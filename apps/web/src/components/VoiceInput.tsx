/**
 * The voice task (D-076): say the watchlist, or choose an audio clip; 0G's
 * speech model (on 0G Private Computer) turns it into text, which fills the
 * watchlist for the owner to check. The clip goes to this app's own API only
 * (POST /api/voice), never straight to 0G, so no 0G key is in the browser.
 * Nothing is recorded until the owner presses the button, recording stops
 * after MAX_RECORD_SEC, and the microphone is released as soon as it stops.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, postAudio } from '../lib/api.ts';
import type { InferenceCall } from '../lib/types.ts';
import { MAX_CLIP_BYTES, MAX_RECORD_SEC, clipType, pickRecordingType } from '../lib/voice.ts';

export interface VoiceResult {
  readonly text: string;
  readonly call: InferenceCall;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording'; readonly seconds: number }
  | { readonly kind: 'sending' }
  | { readonly kind: 'error'; readonly message: string };

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Zm-4.5 6.5a.75.75 0 0 1 1.5 0 3 3 0 0 0 6 0 .75.75 0 0 1 1.5 0 4.5 4.5 0 0 1-3.75 4.44V13.5h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.56A4.5 4.5 0 0 1 3.5 7.5Z"
      />
    </svg>
  );
}

function recorderType(): string | null {
  if (typeof MediaRecorder === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined)
    return null;
  return pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
}

export function VoiceInput({
  disabled,
  onResult,
}: {
  disabled: boolean;
  onResult: (r: VoiceResult) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const canRecord = recorderType() !== null;

  const release = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  };
  // leaving the page stops the microphone
  useEffect(() => () => release(), []);

  const send = async (blob: Blob, type: string) => {
    if (blob.size === 0) {
      setState({ kind: 'error', message: 'Nothing was recorded. Try again.' });
      return;
    }
    if (blob.size > MAX_CLIP_BYTES) {
      setState({ kind: 'error', message: 'That clip is over 1 MB. Keep it under a minute.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      const r = await postAudio<VoiceResult>('/api/voice', blob, type);
      setState({ kind: 'idle' });
      onResult(r);
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof ApiError ? err.message : 'The clip could not be sent.',
      });
    }
  };

  const start = async () => {
    const type = recorderType();
    if (type === null) return;
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState({
        kind: 'error',
        message: 'The microphone is blocked. Allow it for this site, or choose an audio file.',
      });
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, { mimeType: type });
    recorder.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      release();
      recorder.current = null;
      void send(new Blob(chunks, { type }), type);
    };
    rec.start();
    let seconds = 0;
    setState({ kind: 'recording', seconds });
    timer.current = window.setInterval(() => {
      seconds += 1;
      if (seconds >= MAX_RECORD_SEC) rec.stop();
      else setState({ kind: 'recording', seconds });
    }, 1000);
  };

  const stop = () => recorder.current?.stop();

  const choose = (file: File | undefined) => {
    if (file === undefined) return;
    const type = clipType(file.type);
    if (type === null) {
      setState({
        kind: 'error',
        message: 'Choose an audio file (webm, ogg, m4a, mp3 or wav).',
      });
      return;
    }
    void send(file, type);
  };

  const busy = state.kind === 'sending';
  return (
    <div className="voice-input" aria-busy={busy}>
      <div className="row voice-row">
        {state.kind === 'recording' ? (
          <button type="button" className="button button-danger voice-button" onClick={stop}>
            <MicIcon />
            <span>
              Stop ({state.seconds}s / {MAX_RECORD_SEC}s)
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="button voice-button"
            disabled={disabled || busy || !canRecord}
            onClick={() => void start()}
            title={canRecord ? undefined : 'This browser cannot record here; choose a file instead'}
          >
            <MicIcon />
            <span>{busy ? 'Listening on 0G…' : 'Say it'}</span>
          </button>
        )}
        <label className="voice-file">
          <span>or choose an audio file</span>
          <input
            type="file"
            accept="audio/*"
            disabled={disabled || busy || state.kind === 'recording'}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {state.kind === 'recording' ? (
        <p className="hint voice-live" role="status">
          Recording… say the products, packages and vendors, then press Stop.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
