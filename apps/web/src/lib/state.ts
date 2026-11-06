/**
 * The agent's state in one word, from what the API reports (health queue and
 * the policy in force). Only states the server can actually be in. Pure.
 */
import type { Tone } from './timeline.ts';

export const AGENT_STATES = [
  'unreachable',
  'blocked',
  'approval',
  'executing',
  'waiting',
  'idle',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface StateInput {
  readonly reachable: boolean;
  readonly running: string | null;
  readonly pending: number;
  readonly paymentsPaused: boolean;
  /** Payments waiting for the owner's approval (D-066); absent on older servers. */
  readonly approvalsPending?: number;
}

export function agentState(i: StateInput): AgentState {
  if (!i.reachable) return 'unreachable';
  if (i.running !== null) return (i.approvalsPending ?? 0) > 0 ? 'approval' : 'executing';
  if (i.paymentsPaused) return 'blocked';
  if (i.pending > 0) return 'waiting';
  return 'idle';
}

export const STATE_TEXT: Readonly<Record<AgentState, string>> = {
  unreachable: 'Not reachable',
  blocked: 'Payments paused',
  approval: 'Waiting for your approval',
  executing: 'Working on a task',
  waiting: 'Tasks waiting',
  idle: 'Idle, ready',
};

export const stateTone = (s: AgentState): Tone =>
  s === 'idle' ? 'good' : s === 'unreachable' ? 'bad' : 'warn';
