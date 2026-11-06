/**
 * Provider service startup (plan row 16), in order; any failure aborts:
 *   1. probe the facilitators from env (primary, then fallback) and report
 *      which one x402 will bind (D-037);
 *   2. read the agents' live ENS records (chain discovery; a failed read is
 *      tried again, D-082) and refuse to start if price, payTo, network,
 *      asset or endpoint differ (ens-check.ts);
 *   3. build the app through the shared x402 server module and initialise its
 *      resource server, so the facilitator is bound before the port opens.
 * The ENS check can be skipped only outside production, explicitly.
 */
import type { DiscoverySnapshot } from '@agent-economy/ens';
import {
  probeFacilitators,
  type FacilitatorEntry,
  type FacilitatorProbe,
} from '@agent-economy/hedera/x402-server';
import { createIntelService, type IntelApp, type ProviderIdentity } from './app.ts';
import { briefReader, type AgentBrief } from './brief.ts';
import type { IntelServiceConfig } from './config.ts';
import { EnsMismatchError, compareWithEns } from './ens-check.ts';
import { readEnsWithRetry } from './ens-retry.ts';
import type { Feeds } from './operations.ts';

export class ProviderStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderStartupError';
  }
}

export interface EnsChecked {
  readonly checked: true;
  readonly blockNumber: bigint;
  readonly subregistry: string;
  readonly agents: readonly string[];
}
export interface EnsSkipped {
  readonly checked: false;
  readonly reason: string;
}

export interface StartupReport {
  readonly facilitators: readonly FacilitatorProbe[];
  readonly bound: FacilitatorProbe;
  readonly ens: EnsChecked | EnsSkipped;
}

/** The first line of an error, without the RPC URL viem prints on later lines. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? '').slice(0, 160);
}

export async function prepareProviderService(deps: {
  readonly config: IntelServiceConfig;
  readonly facilitators: readonly FacilitatorEntry[];
  /** Live ENS discovery, or null to skip the check (refused in production). */
  readonly discover: (() => Promise<DiscoverySnapshot>) | null;
  readonly feeds: Feeds;
  readonly now?: () => Date;
  /** ERC-8004 registration files to serve (D-066); absent = none. */
  readonly identity?: ProviderIdentity;
  /** Reads the agent's latest brief (tests replace it); default: the agent's public API. */
  readonly briefRead?: () => Promise<AgentBrief>;
  /** Waits before each new ENS read after a failed one (D-082); tests pass short ones. */
  readonly ensRetryDelaysMs?: readonly number[];
}): Promise<{ service: IntelApp; report: StartupReport }> {
  const { config } = deps;

  const { probes, bound } = await probeFacilitators(deps.facilitators, config.network);
  if (bound === null) {
    throw new ProviderStartupError(
      `no facilitator supports exact on ${config.network}: ` +
        probes.map((p) => `${p.role} ${p.url}: ${p.error ?? 'unavailable'}`).join('; '),
    );
  }

  let ens: StartupReport['ens'];
  if (deps.discover === null) {
    if (config.production) {
      throw new ProviderStartupError(
        'the ENS check cannot be skipped in production (NODE_ENV=production)',
      );
    }
    ens = { checked: false, reason: 'skipped with --skip-ens-check (development only)' };
  } else {
    const discover = deps.discover;
    const snapshot = await readEnsWithRetry(() => discover(), {
      ...(deps.ensRetryDelaysMs === undefined ? {} : { delaysMs: deps.ensRetryDelaysMs }),
      onRetry: (attempt, delayMs, error) =>
        console.log(
          `  ENS check   read ${attempt} failed (${firstLine(error)}); trying again in ${delayMs / 1000} s`,
        ),
    });
    const mismatches = compareWithEns({
      served: config.providers,
      network: config.network,
      asset: config.asset,
      publicUrl: config.publicUrl,
      snapshot,
    });
    if (mismatches.length > 0) throw new EnsMismatchError(mismatches);
    ens = {
      checked: true,
      blockNumber: snapshot.blockNumber,
      subregistry: snapshot.subregistry,
      agents: config.providers.map((p) => p.label),
    };
  }

  const service = createIntelService({
    facilitators: deps.facilitators.map((f) => f.client),
    network: config.network,
    providers: config.providers,
    pingPriceTinybars: config.pingPriceTinybars,
    ...(config.usdcPing === null ? {} : { usdcPing: config.usdcPing }),
    ...(config.briefSale === null
      ? {}
      : {
          briefSale: {
            priceTinybars: config.briefSale.priceTinybars,
            payTo: config.briefSale.payTo,
            read:
              deps.briefRead ??
              briefReader({ agentUrl: config.briefSale.agentUrl, production: config.production }),
          },
        }),
    ...(deps.identity === undefined ? {} : { identity: deps.identity }),
    feeds: deps.feeds,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  await service.payment.resourceServer.initialize();
  return { service, report: { facilitators: probes, bound, ens } };
}
