/**
 * Shared setup for the NEAR scripts: the RPC client, the guard contract
 * reader, the agent's function-call key and explorer links.
 */
import { loadEnv, type EnvSource } from '../../packages/core/src/index.ts';
import {
  GuardAgent,
  GuardReader,
  NearRpc,
  formatNear,
  signerFromSecretKey,
  type Assessment,
  type CounterpartyThresholds,
  type NearNetwork,
} from '../../packages/near/src/index.ts';

export interface NearContext {
  readonly network: NearNetwork;
  readonly rpc: NearRpc;
  readonly guard: GuardReader;
}

export function nearContext(source: EnvSource): NearContext {
  const env = loadEnv(['near'], source);
  const rpc = new NearRpc({ url: env.require('NEAR_NODE_URL') });
  return {
    network: `near:${env.require('NEAR_NETWORK')}` as NearNetwork,
    rpc,
    guard: new GuardReader(rpc, env.require('NEAR_GUARD_CONTRACT_ID')),
  };
}

export interface AgentContext extends NearContext {
  readonly agent: GuardAgent;
  readonly thresholds: CounterpartyThresholds;
}

export function agentContext(source: EnvSource): AgentContext {
  const base = nearContext(source);
  const env = loadEnv(['near-agent'], source);
  return {
    ...base,
    agent: new GuardAgent({
      rpc: base.rpc,
      contractId: base.guard.contractId,
      accountId: env.require('NEAR_AGENT_ACCOUNT_ID'),
      signer: signerFromSecretKey(env.require('NEAR_AGENT_PRIVATE_KEY')),
    }),
    thresholds: { minAgeBlocks: Number(env.require('NEAR_MIN_ACCOUNT_AGE_BLOCKS')) },
  };
}

const explorer = (network: NearNetwork) =>
  network === 'near:mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';

export const explorerTx = (network: NearNetwork, hash: string): string =>
  `${explorer(network)}/txns/${hash}`;

export const explorerAccount = (network: NearNetwork, accountId: string): string =>
  `${explorer(network)}/address/${accountId}`;

export const near = (yocto: bigint): string => `${formatNear(yocto)} NEAR`;

export function printAssessment(assessment: Assessment): void {
  console.log(
    `  counterparty check: ${assessment.verdict.toUpperCase()} for ${assessment.receiver}`,
  );
  for (const s of assessment.signals)
    console.log(`    ${s.level.padEnd(5)} ${s.code.padEnd(15)} ${s.detail}`);
}

/** Plain JSON for evidence files: an assessment has no secrets and no bigint. */
export function assessmentJson(assessment: Assessment | null): unknown {
  return assessment === null
    ? null
    : { receiver: assessment.receiver, verdict: assessment.verdict, signals: assessment.signals };
}
