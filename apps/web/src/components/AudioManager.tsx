/**
 * EnderPay audio (commit 2 of 3, D-072; D-073; D-074): one background-music player, one
 * click-sound player, and the top-bar controls. Nothing here runs outside
 * the EnderPay theme: switching to Classic or Electric stops the music, and
 * clicks make no sound there. Music and click sounds are independent.
 *
 * Browser rules are respected: if autoplay is refused, the status says so
 * and the next real click or key press starts the track once (no retry
 * loop). A missing or broken file is reported as not installed, never shown
 * as playing. Audio errors never block the action that was clicked.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useRoute } from '../hooks.tsx';
import {
  CLICK_SOUND,
  RESTART_GAP_MS,
  endFadeGain,
  firstAudible,
  musicStatusText,
  isSoundTarget,
  playbackVolume,
  readAudioPrefs,
  tabForRoute,
  trackForRoute,
  trackUrl,
  writeAudioPrefs,
  type AudioPrefs,
  type MusicStatus,
  type Track,
} from '../lib/audio.ts';
import { browserStorage, useTheme } from './ThemeSwitch.tsx';

// ── a tiny shared store: preferences + what the player really does ───────

interface AudioState {
  readonly prefs: AudioPrefs;
  readonly status: MusicStatus;
  readonly track: Track | null;
  readonly sfxMissing: boolean;
}

let state: AudioState = {
  prefs: readAudioPrefs(browserStorage()),
  status: 'off',
  track: null,
  sfxMissing: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<AudioState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => state;

export function useAudioState(): AudioState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setAudioPrefs(patch: Partial<AudioPrefs>): void {
  const prefs = { ...state.prefs, ...patch };
  writeAudioPrefs(browserStorage(), prefs);
  set({ prefs });
}

// ── the music player: one element, no overlap, fades, repeats (D-074) ────
// One HTMLAudioElement for all music, so two tracks can never sound at once.
// Every play of a track begins at its owner-set start; the last END_FADE_SEC
// fade to silence; after RESTART_GAP_MS on the same tab it plays again from
// its start. Leaving a tab, switching music off, or leaving EnderPay stops the
// track for good: coming back starts it from its start, never mid-song.
//
// The element's volume is always chosen volume × transition fade × end fade
// (playbackVolume). The two fades are this player's own numbers; the saved
// preference and the slider are never written by a fade, so every repeat is
// back at the listener's level, and moving the slider applies at once.

const FADE_MS = 400;
const FADE_STEPS = 8;
/** How often the end fade is recomputed while playing (smooth at ~20 steps/s). */
const TICK_MS = 50;

interface MusicWant {
  readonly active: boolean;
  readonly track: Track;
  /** The nav tab the track belongs to; a new tab always starts the track afresh. */
  readonly tab: string;
  readonly prefs: AudioPrefs;
  readonly visible: boolean;
}

class MusicPlayer {
  #el: HTMLAudioElement | null = null;
  #current: Track | null = null;
  #tab: string | null = null;
  #missing = new Set<string>();
  /** Bumped by every start and stop; a stale fade or timer sees the change and gives up. */
  #token = 0;
  #armed = false;
  #want: MusicWant | null = null;
  /** The listener's chosen volume (a copy of the preference; never written by fades). */
  #chosen = 0;
  /** Fade between tracks and on stop, 0..1. */
  #transition = 0;
  /** Seek to this once the file's length is known (a new file just loaded). */
  #seekTo: number | null = null;
  #ticker: number | null = null;
  #gapTimer: number | null = null;

  #element(): HTMLAudioElement {
    if (this.#el === null) {
      const el = new Audio();
      el.loop = false; // repeats are ours: fade out, 2 s of silence, start again
      el.preload = 'none';
      el.addEventListener('loadedmetadata', () => {
        if (this.#seekTo !== null) {
          const to = Number.isFinite(el.duration)
            ? Math.min(this.#seekTo, el.duration)
            : this.#seekTo;
          this.#seekTo = null;
          if (to > 0) el.currentTime = to;
        }
        this.#apply();
      });
      el.addEventListener('playing', () => {
        this.#startTicker();
        if (this.#current !== null) set({ status: 'playing', track: this.#current });
      });
      el.addEventListener('pause', () => this.#stopTicker());
      el.addEventListener('ended', () => this.#ended());
      el.addEventListener('error', () => {
        // the file is absent or unplayable: remember it for this visit, say so
        this.#clearGap();
        el.pause();
        if (this.#current !== null) {
          this.#missing.add(this.#current.file);
          set({ status: 'missing', track: this.#current });
        }
      });
      this.#el = el;
    }
    return this.#el;
  }

  /** Put chosen × transition × end-of-track fade on the element. */
  #apply(): void {
    const el = this.#el;
    if (el === null) return;
    try {
      el.volume = playbackVolume(
        this.#chosen,
        this.#transition,
        endFadeGain(el.currentTime, el.duration),
      );
    } catch {
      // a browser that refuses a volume value must not break playback
    }
  }

  #startTicker(): void {
    if (this.#ticker !== null) return;
    this.#ticker = window.setInterval(() => this.#apply(), TICK_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    window.clearInterval(this.#ticker);
    this.#ticker = null;
  }

  #clearGap(): void {
    if (this.#gapTimer === null) return;
    window.clearTimeout(this.#gapTimer);
    this.#gapTimer = null;
  }

  /** Ramp the transition fade; resolves when done or superseded. */
  #fade(to: number, token: number): Promise<void> {
    const from = this.#transition;
    return new Promise((resolve) => {
      let step = 0;
      const id = window.setInterval(() => {
        step += 1;
        if (token !== this.#token || step >= FADE_STEPS) {
          window.clearInterval(id);
          if (token === this.#token) {
            this.#transition = to;
            this.#apply();
          }
          resolve();
          return;
        }
        this.#transition = from + ((to - from) * step) / FADE_STEPS;
        this.#apply();
      }, FADE_MS / FADE_STEPS);
    });
  }

  /** The track played to its end (already faded to silence): wait, then again from its start. */
  #ended(): void {
    const track = this.#current;
    if (track === null) return;
    this.#stopTicker();
    this.#clearGap();
    const token = this.#token;
    set({ status: 'repeat', track });
    this.#gapTimer = window.setTimeout(() => {
      this.#gapTimer = null;
      if (token !== this.#token || this.#current !== track) return;
      const want = this.#want;
      if (want === null || !want.active || !want.prefs.music || !want.visible) return;
      this.#play(track, token, true);
    }, RESTART_GAP_MS);
  }

  /**
   * Stop. `reset` forgets the track, so the next play starts it from its start
   * (leaving EnderPay, music off); without it the position is kept (a hidden
   * browser tab).
   */
  #stop(status: MusicStatus, reset: boolean): void {
    const token = ++this.#token;
    this.#clearGap();
    const el = this.#el;
    set({ status, track: reset ? null : this.#current });
    const finish = () => {
      if (token !== this.#token || el === null) return;
      el.pause();
      if (reset) {
        if (el.getAttribute('src') !== null) {
          el.removeAttribute('src');
          el.load();
        }
        this.#current = null;
        this.#tab = null;
        this.#seekTo = null;
      }
    };
    if (el === null || el.paused) finish();
    else void this.#fade(0, token).then(finish);
  }

  /** play() on the element, from the track's start when `fromStart`. */
  #play(track: Track, token: number, fromStart: boolean): void {
    const el = this.#element();
    if (fromStart || el.ended) {
      this.#transition = 0;
      if (el.readyState >= 1) el.currentTime = track.startSec;
      else this.#seekTo = track.startSec;
    }
    this.#apply();
    set({ status: el.paused ? 'loading' : 'playing', track });
    el.play()
      .then(() => {
        if (token !== this.#token) return;
        set({ status: 'playing', track });
        void this.#fade(1, token);
      })
      .catch((e: unknown) => {
        if (token !== this.#token) return;
        const name = e instanceof DOMException ? e.name : '';
        if (name === 'NotAllowedError') {
          set({ status: 'blocked', track });
          this.#armGesture();
        } else if (name !== 'AbortError') {
          el.pause();
          this.#missing.add(track.file);
          set({ status: 'missing', track });
        }
      });
  }

  /** A new track or a new tab: fade the old one out, load this one, play from its start. */
  #startFresh(track: Track, tab: string): void {
    const el = this.#element();
    const token = ++this.#token;
    this.#clearGap();
    const begin = () => {
      if (token !== this.#token) return;
      el.pause();
      this.#current = track;
      this.#tab = tab;
      this.#transition = 0;
      this.#seekTo = track.startSec;
      el.src = trackUrl(track);
      this.#play(track, token, false);
    };
    if (!el.paused) void this.#fade(0, token).then(begin);
    else begin();
  }

  /** After a refused autoplay: the next real click or key press tries once. */
  #armGesture(): void {
    if (this.#armed) return;
    this.#armed = true;
    const go = () => {
      this.#armed = false;
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      if (this.#want !== null) this.update(this.#want);
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  }

  update(want: MusicWant): void {
    this.#want = want;
    const { active, track, tab, prefs, visible } = want;
    this.#chosen = prefs.volume;
    if (!active) return this.#stop('off', true);
    if (!prefs.music) return this.#stop('off', true);
    this.#apply(); // a slider move takes effect now, even mid-fade
    if (!visible) return this.#stop('hidden', false);
    if (this.#missing.has(track.file)) {
      if (this.#current?.file !== track.file) this.#stop('missing', true);
      set({ status: 'missing', track });
      return;
    }
    const el = this.#el;
    const same =
      this.#current?.file === track.file &&
      this.#tab === tab &&
      el !== null &&
      el.getAttribute('src') !== null;
    if (same) {
      // between plays: the restart timer owns what happens next
      if (this.#gapTimer !== null) return;
      if (!el.paused) {
        set({ status: 'playing', track });
        return;
      }
      // paused on this same tab (hidden browser tab, refused autoplay): carry on
      this.#play(track, ++this.#token, false);
      return;
    }
    this.#startFresh(track, tab);
  }

  /** Unmount: silence now, no timers left behind. */
  shutdown(): void {
    ++this.#token;
    this.#clearGap();
    this.#stopTicker();
    const el = this.#el;
    if (el !== null) {
      el.pause();
      if (el.getAttribute('src') !== null) {
        el.removeAttribute('src');
        el.load();
      }
    }
    this.#current = null;
    this.#tab = null;
    this.#seekTo = null;
  }
}

const music = new MusicPlayer();

// ── the click sound: decoded once, played from its first audible sample ──
// The supplied file is 0.89 s long and its click starts after ~0.54 s of
// silence, quietly (about -14 dBFS). Played from the start at half volume it
// sounded late and faint, so it read as "no sound". It is now decoded once
// with the Web Audio API and played from just before the first audible
// sample, at full level: the click lands on the click. HTMLAudioElement is
// only a fallback, seeking to the same point.

let ctx: AudioContext | null = null;
let buffer: AudioBuffer | null = null;
let onsetSec = 0;
let loading: Promise<void> | null = null;
let fallback: HTMLAudioElement | null = null;

function audioContext(): AudioContext | null {
  if (ctx !== null) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  ctx = new Ctor();
  return ctx;
}

/** Fetch and decode once (when EnderPay with click sounds is active). */
function loadClick(): Promise<void> {
  if (loading !== null) return loading;
  loading = (async () => {
    let res: Response;
    try {
      res = await fetch(CLICK_SOUND);
    } catch {
      set({ sfxMissing: true });
      return;
    }
    if (!res.ok) {
      // the file is not served here (not installed, or a server that does not serve .mp3);
      // read the error body so the request completes
      await res.text().catch(() => '');
      set({ sfxMissing: true });
      return;
    }
    try {
      const bytes = await res.arrayBuffer();
      const ac = audioContext();
      if (ac === null) throw new Error('no Web Audio');
      // decodeAudioData works on a suspended context; it does not need a gesture
      buffer = await ac.decodeAudioData(bytes.slice(0));
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      onsetSec = firstAudible(channels, buffer.sampleRate);
      set({ sfxMissing: false });
    } catch {
      // no Web Audio here: a media element, seeking to the start of the file
      buffer = null;
      fallback = new Audio(CLICK_SOUND);
      fallback.preload = 'auto';
      fallback.addEventListener('error', () => set({ sfxMissing: true }));
    }
  })();
  return loading;
}

function playClick(): void {
  try {
    const ac = ctx;
    if (buffer !== null && ac !== null) {
      // a click is a user gesture, so a suspended context may resume here
      if (ac.state === 'suspended') void ac.resume();
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(ac.destination);
      src.start(0, onsetSec);
      return;
    }
    if (fallback !== null) {
      fallback.volume = 1;
      fallback.currentTime = onsetSec;
      void fallback.play().catch(() => {});
      return;
    }
    // not loaded yet (the very first click): load now, play when ready; a missing file stays silent
    if (loading === null)
      void loadClick().then(() => {
        if (buffer !== null || fallback !== null) playClick();
      });
  } catch {
    // never let a sound get in the way of the action
  }
}

function clickTargetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>('button, a, summary, input, [role]');
}

/** Mounted once in the app shell. Renders nothing. */
export function EnderPayAudio() {
  const theme = useTheme();
  const route = useRoute();
  const { prefs } = useAudioState();
  const active = theme === 'enderpay';
  const track = trackForRoute(route);
  const tab = tabForRoute(route);

  // music follows theme, tab, preference and browser-tab visibility
  useEffect(() => {
    const apply = () =>
      music.update({ active, track, tab, prefs, visible: document.visibilityState !== 'hidden' });
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => document.removeEventListener('visibilitychange', apply);
  }, [active, track, tab, prefs]);

  // unmounted: nothing keeps playing, no timer fires later
  useEffect(() => () => music.shutdown(), []);

  // click sounds: real user clicks on actionable controls only
  useEffect(() => {
    if (!active || !prefs.sfx) return undefined;
    void loadClick(); // decoded before the first click, so the first one is not late
    const onClick = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      const el = clickTargetOf(e.target);
      if (el === null) return;
      const ok = isSoundTarget({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        disabled: (el as HTMLButtonElement).disabled === true,
        ariaDisabled: el.getAttribute('aria-disabled') === 'true',
        hasHref: el.hasAttribute('href'),
        classes: [...el.classList],
      });
      if (ok) playClick();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [active, prefs.sfx]);

  return null;
}

// ── the top-bar controls (EnderPay only) ─────────────────────────────────

function NoteIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" shapeRendering="crispEdges">
      <path
        fill="currentColor"
        d="M6 2h8v2h-6v7H6zm6 2h2v7h-2zM3 10h3v1h1v2H6v1H3v-1H2v-2h1zm7 0h3v1h1v2h-1v1h-3v-1H9v-2h1z"
      />
      {off ? (
        <path
          fill="currentColor"
          d="M1 1h2v2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1H9V9H8V8H7V7H6V6H5V5H4V4H3V3H1z"
        />
      ) : null}
    </svg>
  );
}

function SpeakerIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M1 5h3l4-3h1v12H8l-4-3H1z" />
      {off ? (
        <path
          fill="currentColor"
          d="M10 5h2v1h1v1h1V5h1v2h-1v1h-1v1h1v2h-1v-1h-1v1h-1v-1h-1V9h1V8h-1z"
        />
      ) : (
        <path
          fill="currentColor"
          d="M11 5h1v1h1v4h-1v1h-1v-1h1V6h-1zm2-2h1v1h1v8h-1v1h-1v-1h1V4h-1z"
        />
      )}
    </svg>
  );
}

const SHORT: Readonly<Partial<Record<MusicStatus, string>>> = {
  blocked: 'Click to start',
  missing: 'Not installed',
  loading: 'Starting…',
};

export function AudioControls() {
  const { prefs, status, track, sfxMissing } = useAudioState();
  const text = musicStatusText(status, track);
  return (
    <div className="audio-controls" role="group" aria-label="EnderPay sound" aria-live="off">
      <button
        type="button"
        className={`audio-button audio-${status}`}
        aria-pressed={prefs.music}
        aria-label={`Background music ${prefs.music ? 'on' : 'off'}. ${text}`}
        title={text}
        onClick={() => setAudioPrefs({ music: !prefs.music })}
      >
        <NoteIcon off={!prefs.music} />
        {prefs.music && SHORT[status] !== undefined ? (
          <span className="audio-state">{SHORT[status]}</span>
        ) : null}
      </button>
      <label className="audio-volume" title={`Music volume ${Math.round(prefs.volume * 100)}%`}>
        <span className="sr-only">Music volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(prefs.volume * 100)}
          disabled={!prefs.music}
          onChange={(e) => setAudioPrefs({ volume: Number(e.target.value) / 100 })}
        />
      </label>
      <button
        type="button"
        className={`audio-button${sfxMissing ? ' audio-missing' : ''}`}
        aria-pressed={prefs.sfx}
        aria-label={`Click sounds ${prefs.sfx ? 'on' : 'off'}${sfxMissing ? '. The click sound file could not be loaded' : ''}`}
        title={
          sfxMissing
            ? 'Click sound file could not be loaded'
            : prefs.sfx
              ? 'Click sounds on'
              : 'Click sounds off'
        }
        onClick={() => setAudioPrefs({ sfx: !prefs.sfx })}
      >
        <SpeakerIcon off={!prefs.sfx} />
      </button>
    </div>
  );
}
