/**
 * The voice task (D-076): a spoken watchlist becomes text on 0G Private
 * Computer (speech to text, `whisper-large-v3` by default, as the mainnet catalog
 * names it; 0G's docs example says `openai/whisper-large-v3`), through the
 * same inference ledger as every other 0G call, in the same order:
 *
 *   1. reserve  the configured worst case against the daily cap (PENDING),
 *               or a REFUSED row
 *   2. call     one POST /audio/transcriptions, never retried
 *   3. settle   SUCCEEDED  the Router's request ID and billed cost recorded
 *               FAILED     a Router error (not billed), or an invalid TEE
 *                          signature (billed, text not used)
 *               UNKNOWN    a transport error, or an answer without the
 *                          request ID and billing (the worst case stays
 *                          counted until reconciliation; nothing is invented)
 *
 * The transcript is untrusted model output. It only fills the watchlist field
 * in the browser; the owner reads and edits it, and the task endpoint
 * validates it like typed text. The call is then attached to the task's run,
 * so the task page lists it with the plan and analysis calls and the Hedera
 * payments it led to.
 */
import { randomUUID } from 'node:crypto';
import type { InferenceCall } from '@agent-economy/core/domain';
import { ZgRouterError, type ZgRouterClient } from '@agent-economy/zg';
import type { InferenceLedger } from '../ledger/inference-ledger.ts';
import { routerErrorCode } from './ledgered-call.ts';

/** Audio types the browser records or a user may pick, and the file extension sent to 0G. */
export const VOICE_TYPES: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** Largest clip accepted: about a minute of browser-recorded speech. */
export const MAX_VOICE_BYTES = 1024 * 1024;
/** A transcription can start a task for this long after it was made. */
export const VOICE_LINK_WINDOW_MS = 30 * 60 * 1000;

/** The media type without parameters (`audio/webm;codecs=opus` → `audio/webm`), if accepted. */
export function voiceType(contentType: string | undefined): string | null {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return Object.hasOwn(VOICE_TYPES, base) ? base : null;
}

/** Whitespace collapsed, control characters dropped, trimmed. Pure. */
export function cleanTranscript(text: string): string {
  const visible = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  }).join('');
  return visible.replace(/\s+/g, ' ').trim();
}

/**
 * Why voice input is off, for the server log and the New task page, or null
 * when `model` is in the catalog (D-076). Says when this network has no
 * speech model at all (the 0G testnet), and otherwise which ones it has. Pure.
 */
export function voiceOffReason(
  model: string,
  catalog: readonly { readonly id: string; readonly type: string | null }[],
  network: 'mainnet' | 'testnet',
): string | null {
  if (model.trim().toLowerCase() === 'off') return 'switched off by the owner (ZG_STT_MODEL=off)';
  if (catalog.some((m) => m.id === model)) return null;
  const speech = catalog.filter((m) => m.type === 'speech-to-text').map((m) => m.id);
  if (speech.length === 0)
    return `the 0G ${network} catalog has no speech-to-text model${network === 'testnet' ? '; voice works on mainnet' : ''}`;
  return `${model} is not in the 0G ${network} catalog; set ZG_STT_MODEL to one it lists: ${speech.slice(0, 5).join(', ')}`;
}

export interface VoiceConfig {
  readonly network: InferenceCall['network'];
  readonly modelId: string;
  /** Reserved against the daily cap before the call (the catalog gives no per-clip price). */
  readonly worstCaseNeuron: bigint;
  readonly dailyCapNeuron: bigint;
  readonly timeoutMs: number;
  /** ISO-639-1 hint for the model. */
  readonly language: string;
  readonly verifyTee: boolean;
}

export interface VoiceDeps {
  readonly client: Pick<ZgRouterClient, 'transcribe'>;
  readonly ledger: Pick<InferenceLedger, 'reserve' | 'settle' | 'getCall'> & {
    attachToRun(id: string, runId: string): Promise<boolean>;
  };
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type VoiceOutcome =
  /** Text heard. `call.status` is SUCCEEDED, or UNKNOWN when 0G sent no request ID and billing. */
  | { readonly kind: 'transcribed'; readonly text: string; readonly call: InferenceCall }
  | {
      readonly kind: 'refused' | 'failed';
      readonly code: string;
      readonly reason: string;
      readonly call: InferenceCall;
    };

export class VoiceService {
  readonly #deps: VoiceDeps;
  readonly config: VoiceConfig;

  constructor(deps: VoiceDeps, config: VoiceConfig) {
    if (config.worstCaseNeuron <= 0n) throw new Error('the voice worst case must be positive');
    this.#deps = deps;
    this.config = config;
  }

  #now(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  async transcribe(audio: Uint8Array, type: string): Promise<VoiceOutcome> {
    const ext = VOICE_TYPES[type];
    if (ext === undefined) throw new Error(`unsupported audio type ${type}`);
    const { ledger, client } = this.#deps;
    const id = (this.#deps.newId ?? randomUUID)();
    const at = () => this.#now().toISOString();
    const reservation = await ledger.reserve({
      id,
      runId: null,
      purpose: 'TRANSCRIBE',
      network: this.config.network,
      model: this.config.modelId,
      worstCaseNeuron: this.config.worstCaseNeuron,
      dailyCapNeuron: this.config.dailyCapNeuron,
      at: at(),
    });
    if (!reservation.ok)
      return {
        kind: 'refused',
        code: reservation.code,
        reason: reservation.reason,
        call: reservation.call,
      };

    let result: Awaited<ReturnType<ZgRouterClient['transcribe']>>;
    try {
      result = await client.transcribe({
        model: this.config.modelId,
        audio,
        mimeType: type,
        filename: `voice.${ext}`,
        language: this.config.language,
        verifyTee: this.config.verifyTee,
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ZgRouterError) {
        const code = routerErrorCode(error);
        const call = await ledger.settle(
          id,
          { status: 'FAILED', errorCode: code, requestId: error.requestId },
          at(),
        );
        return { kind: 'failed', code, reason: error.message, call };
      }
      const name = error instanceof Error ? error.name.slice(0, 100) : 'ERROR';
      const call = await ledger.settle(id, { status: 'UNKNOWN', errorCode: name }, at());
      return {
        kind: 'failed',
        code: name,
        reason: 'the transcription request did not complete; its outcome is unknown',
        call,
      };
    }

    const t = result.transcription;
    if (t.trace === null) {
      // heard, but without the Router's request ID and billing: nothing is made up
      const call = await ledger.settle(
        id,
        { status: 'UNKNOWN', errorCode: 'NO_BILLING_TRACE' },
        at(),
      );
      return { kind: 'transcribed', text: cleanTranscript(t.text), call };
    }
    const billing = {
      requestId: t.trace.requestId,
      provider: t.trace.provider,
      promptTokens: 0,
      completionTokens: 0,
      costNeuron: t.trace.billing.totalCost,
      teeVerified: t.trace.teeVerified,
    };
    if (t.trace.teeVerified === false) {
      const call = await ledger.settle(
        id,
        { status: 'FAILED', errorCode: 'TEE_SIGNATURE_INVALID', ...billing },
        at(),
      );
      return {
        kind: 'failed',
        code: 'TEE_SIGNATURE_INVALID',
        reason: 'the provider’s TEE signature did not verify, so the text is not used',
        call,
      };
    }
    const call = await ledger.settle(id, { status: 'SUCCEEDED', ...billing }, at());
    return { kind: 'transcribed', text: cleanTranscript(t.text), call };
  }

  /** Why this call cannot start a task, or null when it can (checked before the task is queued). */
  async linkProblem(callId: string): Promise<string | null> {
    const c = await this.#deps.ledger.getCall(callId);
    if (c === null || c.purpose !== 'TRANSCRIBE') return 'no such voice transcription';
    if (c.runId !== null) return 'this voice transcription already started a task';
    if (c.status !== 'SUCCEEDED' && c.status !== 'UNKNOWN')
      return 'this voice transcription did not succeed';
    if (this.#now().getTime() - Date.parse(c.createdAt) > VOICE_LINK_WINDOW_MS)
      return 'this voice transcription is too old; record it again';
    return null;
  }

  linkToRun(callId: string, runId: string): Promise<boolean> {
    return this.#deps.ledger.attachToRun(callId, runId);
  }
}
