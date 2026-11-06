/**
 * Production wiring of the agent (D-047, D-048): the orchestrator connected to
 * real ENSv2 (Sepolia), the Hedera x402 signer, the net-guard, the Mirror Node
 * verifier and the 0G Router through the inference ledger. Used by
 * `pnpm agent:run` and the API server, so the live setup exists once.
 *
 * Discovery happens inside each run (a fresh pinned block per run). The
 * signer is rebuilt from that run's ENS snapshot, so its payee allowlist
 * (D-017) is always exactly the payees discovered for the run being paid.
 * Runs are sequential (one TaskRunner worker, one CLI run), so the swap is safe.
 *
 * This module loads viem, x402 and the Hiero SDK; tests use the mock harness.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderAgent } from '@agent-economy/core/domain';
import type { LoadedEnv } from '@agent-economy/core';
import {
  SEPOLIA_CHAIN_ID,
  discoverProviders,
  parseParentLabel,
  viemDiscoveryChain,
  type CachedLogs,
  type DiscoverySnapshot,
  type LogCache,
  type X402Network,
} from '@agent-economy/ens';
import { createPublicClient, http, sepolia } from '@agent-economy/ens/viem';
import { MirrorNodeClient, hashscanTransactionUrl } from '@agent-economy/hedera';
import {
  createClient,
  definiteFailureStatus,
  newTransactionId,
  parsePrivateKey,
  submitTopicMessage,
  type KeyType,
} from '@agent-economy/hedera/sdk';
import { createHederaPaymentSigner, type HederaCaip2 } from '@agent-economy/hedera/x402';
import { spendingPolicyFromEnv, type SpendingPolicy } from '@agent-economy/policy';
import { ZgRouterClient, type ZgModel } from '@agent-economy/zg';
import { VoiceService, voiceOffReason } from './inference/transcribe.ts';
import { zgModelProblem } from './inference/zg-availability.ts';
import { Auditor, DefiniteSubmitError, type TopicPublisher } from './audit/auditor.ts';
import { SqliteInferenceLedger } from './ledger/inference-ledger.ts';
import { PolicyStore } from './policy/policy-store.ts';
import { fileLogCache } from './ens-log-cache.ts';
import { errorMessage, logError } from './log.ts';
import { retryReadOnRateLimit } from './read-retry.ts';
import { ledgeredInference, promptBudget } from './orchestrator/infer.ts';
import { Orchestrator, type OrchestratorLimits } from './orchestrator/orchestrator.ts';
import { ApprovalStore } from './payments/approvals.ts';
import { ChainSpendFloor } from './payments/chain-floor.ts';
import { EarningsReader } from './payments/earnings.ts';
import { SqlitePaymentStore } from './payments/payment-store.ts';
import { SettlementVerifier } from './payments/settlement-verifier.ts';
import { PaymentStateMachine } from './payments/state-machine.ts';
import { buyWithFirewall, buyerFetch, type PaymentSigner } from './payments/x402-buyer.ts';

/** Env groups the live agent needs. */
export const LIVE_ENV_GROUPS = ['core', 'hedera', 'ens', 'x402', 'zg'] as const;

export class WiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WiringError';
  }
}

export interface LiveOptions {
  /** Accept loopback http endpoints found on ENS (the local provider service). Development only. */
  readonly allowLocalHttp: boolean;
  /** Start of the ENS log scan; null uses ENS_DISCOVERY_FROM_BLOCK, else searches for the deployment block. */
  readonly fromBlock: bigint | null;
  /** Where scanned ENS registration logs are kept between runs (D-059); null keeps them in memory only. */
  readonly logCachePath?: string | null;
  /** How long a run retries a provider catalog while a sleeping provider host wakes (D-062). */
  readonly providerWakeMs?: number;
  readonly maxPurchases?: number;
  readonly planTokens?: number;
  readonly analyzeTokens?: number;
}

export interface LiveAgent {
  readonly orchestrator: Orchestrator;
  readonly store: SqlitePaymentStore;
  readonly ledger: SqliteInferenceLedger;
  /** The env policy: the ceiling the owner's persisted policy may only lower (D-052). */
  readonly policy: SpendingPolicy;
  /** The owner's persisted policy and kill switch; read for every run and purchase. */
  readonly policyStore: PolicyStore;
  readonly hederaNetwork: 'testnet' | 'mainnet';
  readonly network: HederaCaip2;
  readonly zg: {
    readonly network: 'testnet' | 'mainnet';
    readonly modelId: string;
    /** Null when ZG_MODEL is not in the catalog (D-079): every 0G call is then refused. */
    readonly model: ZgModel | null;
    /** Why 0G inference is unavailable at start, or null. */
    readonly unavailable: string | null;
    readonly capNeuron: bigint;
    readonly dailyCapNeuron: bigint;
    readonly limits: OrchestratorLimits;
  };
  /** The voice task (D-076), or null with the reason it is off. */
  readonly voice: VoiceService | null;
  readonly voiceStatus: {
    readonly model: string;
    readonly enabled: boolean;
    readonly reason: string | null;
  };
  readonly hashscan: (transactionId: string) => string;
  /** The HCS auditor (D-057), or null when HCS_TOPIC_ID is not set. */
  readonly auditor: Auditor | null;
  /** Today's x402 spend from outside this database, read from the Mirror Node (D-062). */
  readonly chainFloor: ChainSpendFloor;
  /** The ENS snapshot of the latest run (block, hash, providers, skipped). */
  lastSnapshot(): DiscoverySnapshot | null;
  /** Human approval requests and answers (D-066). */
  readonly approvals: ApprovalStore;
  /** What the agent earned from selling its brief (D-066), or null when it is not for sale. */
  readonly earnings: EarningsReader | null;
  /**
   * At startup (D-066): expire approval requests a previous process left
   * PENDING and end their payments FAILED, unsigned. Returns how many.
   */
  closeOpenApprovals(): Promise<number>;
}

export async function createLiveAgent(
  env: LoadedEnv,
  db: DatabaseSync,
  options: LiveOptions,
): Promise<LiveAgent> {
  if (env.require('ENS_CHAIN') !== 'sepolia') throw new WiringError('runs on Sepolia only');
  const network = env.require('X402_NETWORK') as HederaCaip2;
  const hederaNetwork = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
  const payer = env.require('HEDERA_PAYER_ACCOUNT_ID');
  const policy = spendingPolicyFromEnv(env, payer);
  const policyStore = new PolicyStore(db, policy);

  // 0G: the model's live price sizes the analysis prompt to the per-call cap
  const zgNetwork = env.require('ZG_NETWORK') as 'testnet' | 'mainnet';
  const modelId = env.require('ZG_MODEL');
  const capNeuron = BigInt(env.require('ZG_MAX_CALL_COST_NEURON'));
  const dailyCapNeuron = BigInt(env.require('ZG_DAILY_CAP_NEURON'));
  const timeoutMs = Number(env.require('ZG_TIMEOUT_MS'));
  const client = new ZgRouterClient({
    baseUrl: env.require('ZG_ROUTER_BASE_URL'),
    apiKey: env.require('ZG_API_KEY'),
    chatTimeoutMs: timeoutMs,
  });
  // A model missing from the catalog, or a catalog 0G cannot serve, no longer stops the server
  // (D-079): the site, ENS discovery and the evidence stay up, and every 0G call is refused
  // (MODEL_NOT_IN_CATALOG) until the model is listed again. A cost cap too low for the model is
  // still a configuration error and stops it.
  let catalog: readonly ZgModel[] = [];
  let catalogError: string | null = null;
  try {
    catalog = (await client.listModels()).models;
  } catch (error) {
    catalogError = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
  }
  const model = catalog.find((m) => m.id === modelId) ?? null;
  const zgUnavailable = zgModelProblem(modelId, zgNetwork, catalog, catalogError);
  const planTokens = options.planTokens ?? 768;
  const analyzeTokens = options.analyzeTokens ?? 1024;
  const analyzePromptTokens = model === null ? null : promptBudget(model, capNeuron, analyzeTokens);
  if (model !== null && (analyzePromptTokens === null || analyzePromptTokens < 800))
    throw new WiringError(
      `an analysis of ${analyzeTokens} tokens leaves no room for a prompt under ZG_MAX_CALL_COST_NEURON`,
    );

  // ENS (chain state only)
  const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
  const envFromBlock = env.get('ENS_DISCOVERY_FROM_BLOCK');
  const fromBlock = options.fromBlock ?? (envFromBlock === undefined ? null : BigInt(envFromBlock));
  const rpc = createPublicClient({
    chain: sepolia,
    // read-only client: back off and retry on 429 and 5xx (1, 2, 4, 8 s; Retry-After when sent).
    // Free RPC plans refuse bursts per second, as on the first Render start (D-063). Scripts that
    // send transactions keep a single attempt.
    transport: http(env.require('ETH_RPC_URL'), {
      timeout: 30_000,
      retryCount: 4,
      retryDelay: 1_000,
    }),
    batch: { multicall: true },
  });
  if ((await rpc.getChainId()) !== SEPOLIA_CHAIN_ID)
    throw new WiringError('ETH_RPC_URL is not Sepolia');
  // scanned registration logs survive between runs (D-059), so only new blocks are read
  let memoryLogs: CachedLogs | null = null;
  const logCache: LogCache =
    options.logCachePath === undefined || options.logCachePath === null
      ? {
          load: () => memoryLogs,
          save: (e) => {
            memoryLogs = e;
          },
        }
      : fileLogCache(options.logCachePath);

  const store = new SqlitePaymentStore(db);
  const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));
  // today's x402 spend this database does not know about (a wiped database, another copy of the
  // agent): read from the Mirror Node before every run and added to the daily budget (D-062)
  const chainFloor = new ChainSpendFloor({
    payer,
    mirror,
    knownTransactionIds: () =>
      (
        db
          .prepare('SELECT transaction_id FROM payment_intents WHERE transaction_id IS NOT NULL')
          .all() as { transaction_id: string }[]
      ).map((r) => r.transaction_id),
  });
  const machine = new PaymentStateMachine(store, {
    dayFloor: (dayStart) => chainFloor.floorFor(dayStart),
    payeeFloor: (dayStart) => chainFloor.payeeFloorFor(dayStart),
  });
  const ledger = new SqliteInferenceLedger(db);
  // the voice task (D-076): optional; a speech model missing from the catalog switches only it off
  const sttModel = env.require('ZG_STT_MODEL');
  const sttOff = voiceOffReason(sttModel, catalog, zgNetwork);
  const voice =
    sttOff === null
      ? new VoiceService(
          { client, ledger },
          {
            network: zgNetwork,
            modelId: sttModel,
            worstCaseNeuron: BigInt(env.require('ZG_STT_MAX_NEURON')),
            dailyCapNeuron,
            timeoutMs,
            language: 'en',
            verifyTee: true,
          },
        )
      : null;
  const voiceStatus = {
    model: sttModel,
    enabled: voice !== null,
    reason: sttOff,
  };
  // Human approval mode (D-066): requests wait here for the owner
  const approvalTimeout = env.get('APPROVAL_TIMEOUT_SEC');
  const approvals = new ApprovalStore(
    db,
    approvalTimeout === undefined ? {} : { timeoutSec: Number(approvalTimeout) },
  );
  // the agent's earnings (D-066): sales of its brief, read from the Mirror Node only
  const earningsAccount = env.get('AGENT_EARNINGS_ACCOUNT') ?? null;
  const earnings =
    earningsAccount === null
      ? null
      : new EarningsReader({ account: earningsAccount, ownPayer: payer, mirror });
  const fetch = buyerFetch({ allowLoopbackHttp: options.allowLocalHttp });
  const verifier = new SettlementVerifier({
    machine,
    store,
    mirror,
    network: hederaNetwork,
    payer,
  });

  // HCS audit topic (D-057): posted by the payer, which is the topic's submit key
  const topicId = env.get('HCS_TOPIC_ID') ?? null;
  let auditor: Auditor | null = null;
  if (topicId !== null) {
    const client = createClient(
      hederaNetwork,
      payer,
      parsePrivateKey(
        env.require('HEDERA_PAYER_PRIVATE_KEY'),
        env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
      ),
    );
    const publisher: TopicPublisher = {
      topicId,
      newTransactionId: () => newTransactionId(client),
      submit: async ({ message, transactionId }) => {
        try {
          return await submitTopicMessage(client, { topicId, message, transactionId });
        } catch (error) {
          // the node refused it (precheck) or consensus failed it (receipt): certainly not recorded
          const status = definiteFailureStatus(error);
          if (status !== null)
            throw new DefiniteSubmitError(
              status,
              error instanceof Error ? error.message : String(error),
            );
          throw error;
        }
      },
    };
    auditor = new Auditor({
      db,
      publisher,
      mirror,
      payments: store,
      inference: ledger,
      agent: env.require('ENS_PARENT_NAME'),
      mode: 'live',
    });
  }
  const facilitatorUrl = env.require('X402_FACILITATOR_URL');
  const signerFor = (providers: readonly ProviderAgent[]): PaymentSigner =>
    createHederaPaymentSigner({
      accountId: payer,
      privateKey: env.require('HEDERA_PAYER_PRIVATE_KEY'),
      keyType: env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
      network,
      // second layer (D-017): only this run's ENS payees, never above the per-payment cap
      policy: {
        network,
        asset: policy.asset,
        maxAmount: policy.maxPerPayment,
        allowedPayTo: providers.map((p) => p.payTo),
        payer,
      },
    });

  let snapshot: DiscoverySnapshot | null = null;
  let signer: PaymentSigner | null = null;
  const limits: OrchestratorLimits = {
    maxPurchases: options.maxPurchases ?? 3,
    maxItems: 30,
    planMaxTokens: planTokens,
    analyzeMaxTokens: analyzeTokens,
    analyzePromptTokens,
    catalogWakeMs: options.providerWakeMs ?? 0,
  };
  const hashscan = (tx: string) => hashscanTransactionUrl(hederaNetwork, tx);
  const orchestrator = new Orchestrator({
    db,
    discover: async () => {
      snapshot = null;
      signer = null;
      // a pure read: retried (bounded) when the RPC provider rate-limits (D-054)
      const s = await retryReadOnRateLimit(() =>
        discoverProviders(viemDiscoveryChain(rpc), {
          parentName: parent.name,
          parentLabel: parent.label,
          chain: 'sepolia',
          allowLocalHttp: options.allowLocalHttp,
          expectedNetwork: network as X402Network,
          ...(fromBlock === null ? {} : { fromBlock }),
          logCache,
          // free RPC plans limit requests per second; a short pause keeps the scan under it
          minLogIntervalMs: 200,
        }),
      );
      const providers = s.providers.map((p) => p.provider);
      snapshot = s;
      signer = signerFor(providers);
      return {
        parent: parent.name,
        blockNumber: s.blockNumber,
        observedAt: new Date().toISOString(),
        providers,
        skipped: s.skipped.map((k) => ({ label: k.label, code: k.code, reason: k.reason })),
        allowLocalHttp: options.allowLocalHttp,
      };
    },
    fetch,
    buy: (input) => {
      if (signer === null) throw new WiringError('no ENS snapshot for this run');
      return buyWithFirewall({ fetch, signer, machine, verifier, facilitatorUrl }, input);
    },
    infer: ledgeredInference(
      { client, ledger },
      { network: zgNetwork, modelId, capNeuron, dailyCapNeuron, timeoutMs },
    ),
    payments: store,
    inference: ledger,
    policy,
    policySource: () => policyStore.effective(),
    approvals,
    earningsAccount,
    spendCheck: () => chainFloor.refresh(),
    environment: 'live',
    hashscan,
    limits,
    ...(auditor === null
      ? {}
      : {
          afterRun: async (runId: string) => {
            await auditor?.auditRun(runId);
          },
          onAfterRunError: (runId: string, error: unknown) =>
            logError(`HCS audit for ${runId} failed: ${errorMessage(error)}`),
        }),
  });

  return {
    orchestrator,
    store,
    ledger,
    policy,
    policyStore,
    hederaNetwork,
    network,
    zg: {
      network: zgNetwork,
      modelId,
      model,
      unavailable: zgUnavailable,
      capNeuron,
      dailyCapNeuron,
      limits,
    },
    voice,
    voiceStatus,
    hashscan,
    auditor,
    chainFloor,
    lastSnapshot: () => snapshot,
    approvals,
    earnings,
    closeOpenApprovals: async () => {
      const expired = approvals.expireAllPending('restart');
      for (const a of expired) {
        const p = await store.get(a.paymentId);
        // still AUTHORIZED: never signed, so it can only end FAILED (D-042)
        if (p?.status === 'AUTHORIZED')
          await machine.recordFailedBeforeSubmit(p.id, 'APPROVAL_EXPIRED');
      }
      return expired.length;
    },
  };
}

/**
 * What the UI may know about this deployment (`GET /api/config`): networks,
 * the payer's public account, the spending policy and the 0G caps. Nothing
 * secret: no keys, no access code, no RPC URL.
 */
export function publicConfigOf(agent: LiveAgent, ensParent: string): Record<string, unknown> {
  // the env policy; the API overlays the owner's effective limits on every request
  const p = agent.policy;
  return {
    mode: 'live',
    networks: {
      ens: 'sepolia',
      hedera: agent.hederaNetwork,
      x402: agent.network,
      zg: agent.zg.network,
    },
    ensParent,
    payer: p.payer,
    policy: {
      asset: p.asset,
      maxPerPayment: p.maxPerPayment.toString(),
      maxPerRun: p.maxPerRun.toString(),
      maxPerDay: p.maxPerDay.toString(),
      maxPaymentsPerRun: p.maxPaymentsPerRun,
      maxSnapshotAgeSec: Math.round(p.maxSnapshotAgeMs / 1000),
      allowedProviders: p.allowedProviders,
      blockedProviders: p.blockedProviders,
      allowedCapabilities: p.allowedCapabilities,
    },
    hcs: agent.auditor === null ? null : { topicId: agent.auditor.topicId },
    approvals: { timeoutSec: agent.approvals.timeoutSec },
    earnings: agent.earnings === null ? null : { account: agent.earnings.account },
    zg: {
      model: agent.zg.modelId,
      unavailable: agent.zg.unavailable,
      capNeuron: agent.zg.capNeuron.toString(),
      dailyCapNeuron: agent.zg.dailyCapNeuron.toString(),
      planTokens: agent.zg.limits.planMaxTokens,
      analyzeTokens: agent.zg.limits.analyzeMaxTokens,
      maxPurchases: agent.zg.limits.maxPurchases,
    },
    voice: agent.voiceStatus,
  };
}
