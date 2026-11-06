/**
 * The voice task (D-076), the pure part: turning what 0G's speech model heard
 * into watchlist lines, choosing a recording format the browser supports, and
 * describing the 0G call honestly. DOM-free, unit-tested under Node; the
 * recorder lives in components/VoiceInput.tsx.
 */
import type { InferenceCall } from './types.ts';
import { zgAmount } from './format.ts';

/** Longest recording, in seconds (a watchlist is a sentence or two). */
export const MAX_RECORD_SEC = 30;
/** Largest clip the server accepts (MAX_VOICE_BYTES in apps/server). */
export const MAX_CLIP_BYTES = 1024 * 1024;

/** Recording formats in order of preference; all are accepted by POST /api/voice. */
export const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

/** The first format `supported` accepts, or null (then only a file can be chosen). Pure. */
export function pickRecordingType(supported: (type: string) => boolean): string | null {
  return RECORDING_TYPES.find((t) => supported(t)) ?? null;
}

/** Audio types a chosen file may have (the server's list). */
export const CLIP_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
] as const;

/** The type to send for a chosen file, or null when the server would refuse it. Pure. */
export function clipType(fileType: string): string | null {
  const base = fileType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'audio/x-m4a' || base === 'audio/m4a') return 'audio/mp4';
  if (base === 'audio/mp3') return 'audio/mpeg';
  return (CLIP_TYPES as readonly string[]).includes(base) ? base : null;
}

/**
 * Spoken list → one item per line: split on commas, semicolons, full stops at
 * the end of a phrase, and the word "and"; trailing punctuation dropped;
 * duplicates removed (case-insensitive), order kept. Version numbers like
 * 4.17.21 survive. The owner still reads and edits the result. Pure.
 */
export function spokenToWatchlist(text: string): string {
  const parts = text
    .replace(/\r/g, '')
    // a full stop ends a phrase only when followed by space or the end, not inside 4.17.21
    .split(/[,;\n]|\.(?=\s|$)|\s+and\s+/i)
    .map((s) => s.replace(/^[\s"'“”-]+|[\s"'“”!?.:-]+$/g, '').trim())
    .filter((s) => s !== '' && s.toLowerCase() !== 'and');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join('\n');
}

export interface VoiceReceipt {
  readonly headline: string;
  readonly detail: string;
  readonly tone: 'good' | 'warn';
}

/** What the 0G call did, without claiming more than the ledger row says. Pure. */
export function voiceReceipt(call: InferenceCall): VoiceReceipt {
  const where = `0G Private Computer (${call.network}), model ${call.model}`;
  if (call.status === 'SUCCEEDED') {
    const tee =
      call.teeVerified === true
        ? ', TEE signature verified'
        : call.teeVerified === null
          ? ', TEE check not reported'
          : '';
    return {
      headline: 'Heard on 0G',
      detail: `${where}: ${call.costNeuron === null ? 'cost not reported' : zgAmount(call.costNeuron)}${tee}.`,
      tone: 'good',
    };
  }
  return {
    headline: 'Heard on 0G, not yet billed',
    detail: `${where}: 0G returned the text without a request ID or bill, so the call is held at its reserved ${call.worstCaseNeuron === null ? 'worst case' : zgAmount(call.worstCaseNeuron)} until it is reconciled.`,
    tone: 'warn',
  };
}
