/**
 * EnderPay audio (D-072, D-073, D-074): which background track each page
 * plays, where it starts, how it ends and repeats, and the listener's two
 * independent preferences, music and sound effects. Pure and DOM-free
 * (unit-tested under Node); the players live in components/AudioManager.tsx.
 * Only the EnderPay theme ever plays anything.
 *
 * The music files are C418's tracks, supplied and committed by the owner
 * (D-074), shrunk to 64 kbps mono so the whole web build stays under the API
 * static server's 20 MiB cap. Each is looked up at /audio/music/<file>; a file
 * that is absent or unplayable is reported as not installed, never as playing.
 */

export interface Track {
  readonly title: string;
  readonly artist: string;
  /** File name under /audio/music/. */
  readonly file: string;
  /** Where every play of this track begins, in seconds into the file (owner's choice). */
  readonly startSec: number;
}

const track = (title: string, file: string, startSec = 0): Track => ({
  title,
  artist: 'C418',
  file,
  startSec,
});

/** The owner's mapping, by nav tab (route's first segment). */
export const TAB_TRACKS: Readonly<Record<string, Track>> = {
  '': track('Minecraft', 'minecraft.mp3', 12),
  new: track('Aria Math', 'aria-math.mp3', 150),
  schedule: track('Mice on Venus', 'mice-on-venus.mp3', 30),
  evidence: track('Moog City 2', 'moog-city-2.mp3'),
  logs: track('Subwoofer Lullaby', 'subwoofer-lullaby.mp3'),
  payments: track('Haggstrom', 'haggstrom.mp3'),
  approvals: track('Sweden', 'sweden.mp3'),
  usage: track('Excuse', 'excuse.mp3'),
  providers: track('Dry Hands', 'dry-hands.mp3'),
  rules: track('Key', 'key.mp3', 6),
  holder: track('Living Mice', 'living-mice.mp3'),
};

/** Every other existing page (the task page, page not found). */
export const OTHER_TRACK: Track = track('Wet Hands', 'wet-hands.mp3');

export const MUSIC_DIR = '/audio/music/';

/** |sample| that counts as audible when finding where the click starts. */
export const CLICK_THRESHOLD = 0.02;
/** Start this much before the onset, so the attack is not clipped. */
export const CLICK_LEAD_SEC = 0.005;

/**
 * Where a short sound actually starts: the first sample (in any channel)
 * at least CLICK_THRESHOLD loud, minus a small lead, in seconds. The supplied
 * click has ~0.54 s of silence before it. 0 for an all-silent buffer. Pure.
 */
export function firstAudible(channels: readonly Float32Array[], sampleRate: number): number {
  let first = Infinity;
  for (const data of channels) {
    for (let i = 0; i < data.length && i < first; i++) {
      if (Math.abs(data[i] ?? 0) >= CLICK_THRESHOLD) {
        first = i;
        break;
      }
    }
  }
  return first === Infinity ? 0 : Math.max(0, first / sampleRate - CLICK_LEAD_SEC);
}
export const CLICK_SOUND = '/audio/enderpay-click.mp3';

/** The track for a route (segments as useRoute returns them). Pure. */
export function trackForRoute(route: readonly string[]): Track {
  return TAB_TRACKS[route[0] ?? ''] ?? OTHER_TRACK;
}

/**
 * The tab a route belongs to, for music: a nav tab's own key, or one shared
 * key for every other page (they share Wet Hands, which carries on between
 * them). Entering a different tab always starts its track from its start. Pure.
 */
export function tabForRoute(route: readonly string[]): string {
  const first = route[0] ?? '';
  return Object.hasOwn(TAB_TRACKS, first) ? first : '*';
}

export const trackUrl = (t: Track): string => `${MUSIC_DIR}${t.file}`;

// ── how a track ends and repeats (D-074) ───────────────────────────────

/** The last this-many seconds of every play fade smoothly to silence. */
export const END_FADE_SEC = 4.5;
/** Silence between the end of a track and its next play, on the same tab. */
export const RESTART_GAP_MS = 2000;

/**
 * The end-of-track fade as a 0..1 multiplier: 1 until END_FADE_SEC before the
 * end, then a straight line down to 0 at the end. 1 while the length is not
 * known yet. Pure.
 */
export function endFadeGain(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return 1;
  const left = duration - currentTime;
  return Math.min(1, Math.max(0, left / END_FADE_SEC));
}

/**
 * What the element's volume should be: the listener's chosen volume times the
 * temporary fades (between tracks, and at the end). The fades never change
 * the saved volume or the slider, so the next play is back at the chosen
 * level. Pure.
 */
export function playbackVolume(chosen: number, transition: number, end: number): number {
  const v = chosen * transition * end;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

// ── preferences: music and sound effects are independent ───────────────

export interface AudioPrefs {
  /** Background music; on by default the first time EnderPay is used. */
  readonly music: boolean;
  /** Interaction sounds; on by default. */
  readonly sfx: boolean;
  /** Music volume 0..1 (sound effects follow at a fixed comfortable level). */
  readonly volume: number;
}

export const DEFAULT_AUDIO: AudioPrefs = { music: true, sfx: true, volume: 0.35 };
export const AUDIO_STORAGE_KEY = 'threat-intel-agent:enderpay-audio';

/** Anything malformed falls back field by field to the defaults. Pure. */
export function parseAudioPrefs(raw: unknown): AudioPrefs {
  if (typeof raw !== 'string') return DEFAULT_AUDIO;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_AUDIO;
  }
  if (typeof v !== 'object' || v === null) return DEFAULT_AUDIO;
  const o = v as Record<string, unknown>;
  const volume =
    typeof o['volume'] === 'number' && Number.isFinite(o['volume'])
      ? Math.min(1, Math.max(0, o['volume']))
      : DEFAULT_AUDIO.volume;
  return {
    music: typeof o['music'] === 'boolean' ? o['music'] : DEFAULT_AUDIO.music,
    sfx: typeof o['sfx'] === 'boolean' ? o['sfx'] : DEFAULT_AUDIO.sfx,
    volume,
  };
}

export function readAudioPrefs(storage: Pick<Storage, 'getItem'> | null | undefined): AudioPrefs {
  try {
    return parseAudioPrefs(storage?.getItem(AUDIO_STORAGE_KEY));
  } catch {
    return DEFAULT_AUDIO;
  }
}

export function writeAudioPrefs(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  prefs: AudioPrefs,
): boolean {
  try {
    if (storage === null || storage === undefined) return false;
    storage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

// ── what the music player is actually doing (shown, never guessed) ──────

export type MusicStatus =
  /** Not EnderPay, or music switched off. */
  | 'off'
  /** Waiting for the file to start. */
  | 'loading'
  | 'playing'
  /** The browser refused to start without a user gesture; the next click starts it. */
  | 'blocked'
  /** The file for this track is not installed or cannot be played. */
  | 'missing'
  /** Paused while the browser tab is hidden. */
  | 'hidden'
  /** The track finished; it plays again from its start after RESTART_GAP_MS. */
  | 'repeat';

/** The toggle's tooltip and accessible description for a status. Pure. */
export function musicStatusText(status: MusicStatus, t: Track | null): string {
  const name = t === null ? 'this page' : `${t.title} (${t.artist})`;
  switch (status) {
    case 'off':
      return 'Music is off';
    case 'loading':
      return `Starting ${name}…`;
    case 'playing':
      return `Playing ${name}`;
    case 'blocked':
      return `Your browser blocked autoplay: click anywhere to start ${name}`;
    case 'missing':
      return `${name} is not installed (add ${t === null ? 'the file' : trackUrl(t)})`;
    case 'hidden':
      return `Paused while this tab is hidden: ${name}`;
    case 'repeat':
      return `${name} finished: playing it again in ${RESTART_GAP_MS / 1000} s`;
  }
}

/** Should a click on this element make the interaction sound? Pure (on element facts). */
export interface ClickTarget {
  readonly tag: string;
  readonly role: string | null;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly ariaDisabled: boolean;
  readonly hasHref: boolean;
  readonly classes: readonly string[];
}

export function isSoundTarget(t: ClickTarget): boolean {
  if (t.disabled || t.ariaDisabled || t.classes.includes('is-disabled')) return false;
  if (t.classes.includes('no-click-sound')) return false;
  switch (t.tag) {
    case 'button':
    case 'summary':
      return true;
    case 'a':
      return t.hasHref;
    case 'input':
      return t.type === 'checkbox' || t.type === 'radio' || t.type === 'submit';
    default:
      return t.role === 'button' || t.role === 'tab' || t.role === 'menuitem';
  }
}
