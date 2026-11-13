/**
 * The agent-side wrapper around a payment. It runs the counterparty check
 * first and then:
 *
 *   block → never signs (the pay function is not called)
 *   warn  → asks a human; signs only on an explicit yes
 *   allow → signs
 *
 * The guard contract checks again on-chain, so a wrapper that is bypassed
 * still cannot pay a blocked or unregistered receiver.
 */
import type { Assessment } from './counterparty.ts';
import type { GuardPayResult } from './guard.ts';

export interface PayRequest {
  readonly runId: string;
  readonly receiver: string;
  readonly amount: bigint;
  readonly memo: string;
}

export type GuardedPayOutcome =
  | { readonly outcome: 'refused'; readonly assessment: Assessment }
  | { readonly outcome: 'declined'; readonly assessment: Assessment }
  | {
      readonly outcome: 'paid' | 'rejected';
      readonly assessment: Assessment;
      /** True when a human approved a warning. */
      readonly approvedByHuman: boolean;
      readonly payment: GuardPayResult;
    };

export interface GuardedPayDeps {
  readonly check: (receiver: string, amount: bigint) => Promise<Assessment>;
  /** Called only on a warning. Anything but `true` declines the payment. */
  readonly askHuman: (assessment: Assessment, request: PayRequest) => Promise<boolean>;
  readonly pay: (request: PayRequest) => Promise<GuardPayResult>;
}

export async function guardedPay(
  deps: GuardedPayDeps,
  request: PayRequest,
): Promise<GuardedPayOutcome> {
  const assessment = await deps.check(request.receiver, request.amount);
  if (assessment.verdict === 'block') return { outcome: 'refused', assessment };
  let approvedByHuman = false;
  if (assessment.verdict === 'warn') {
    if ((await deps.askHuman(assessment, request)) !== true)
      return { outcome: 'declined', assessment };
    approvedByHuman = true;
  }
  const payment = await deps.pay(request);
  return {
    outcome: payment.success ? 'paid' : 'rejected',
    assessment,
    approvedByHuman,
    payment,
  };
}
