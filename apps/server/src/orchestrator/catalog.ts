/**
 * Provider catalogs (plan row 24, D-046). Every provider serves a free
 * description at its ENS endpoint (`GET <endpoint>`): which operation it sells,
 * its path and parameters, and the payment it will ask for. That is how the
 * orchestrator learns how to call a provider it has never seen, so a new agent
 * registered on ENS works without a code change.
 *
 * The description is UNTRUSTED (it comes from the provider's server, not from
 * ENS), so:
 *   - it is fetched through the net-guard with a small byte cap;
 *   - it must parse against a strict, length-capped schema;
 *   - an operation is kept only when its path is under the ENS endpoint and its
 *     payment (network, asset, amount, payTo) equals the ENS records. ENS stays
 *     the source of truth; the firewall checks the live 402 quote again anyway.
 *
 * `buildPurchaseUrl` turns a planned purchase into the request URL. The
 * orchestrator builds it, not the model: same origin as the ENS endpoint, the
 * catalog's path, only the catalog's parameter names, values URL-encoded.
 */
import {
  ProviderCatalog,
  type CatalogOperation,
  type PlannedPurchase,
  type ProviderAgent,
} from '@agent-economy/core/domain';
import { NetGuardError } from '@agent-economy/net-guard';

export { ProviderCatalog, type CatalogOperation };

export const CATALOG_MAX_BYTES = 64 * 1024;

export type CatalogResult =
  | {
      readonly ok: true;
      readonly provider: ProviderAgent;
      readonly operations: readonly CatalogOperation[];
      /** Operations dropped because they disagree with ENS, with the reason. */
      readonly dropped: readonly { readonly name: string; readonly code: string }[];
    }
  | {
      readonly ok: false;
      readonly provider: ProviderAgent;
      readonly code: string;
      readonly reason: string;
    };

const endpointPath = (endpoint: string): string => new URL(endpoint).pathname.replace(/\/+$/, '');

/** Why an operation disagrees with the provider's ENS records, or null. Pure. */
export function operationMismatch(provider: ProviderAgent, op: CatalogOperation): string | null {
  const base = endpointPath(provider.endpoint);
  if (!op.path.startsWith(`${base}/`) || op.path.includes('..')) return 'PATH_OUTSIDE_ENDPOINT';
  if (op.payment.scheme !== 'exact') return 'SCHEME_MISMATCH';
  if (op.payment.network !== provider.network) return 'NETWORK_MISMATCH';
  if (op.payment.asset !== provider.asset) return 'ASSET_MISMATCH';
  if (op.payment.amount !== provider.priceAtomic) return 'PRICE_MISMATCH';
  if (op.payment.payTo !== provider.payTo) return 'PAYTO_MISMATCH';
  return null;
}

/** Check a parsed catalog against the provider's ENS records. Pure. */
export function checkCatalog(provider: ProviderAgent, body: unknown): CatalogResult {
  const parsed = ProviderCatalog.safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      provider,
      code: 'CATALOG_INVALID',
      reason: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  if (parsed.data.provider !== provider.label)
    return {
      ok: false,
      provider,
      code: 'CATALOG_PROVIDER_MISMATCH',
      reason: `catalog names "${parsed.data.provider}", ENS label is "${provider.label}"`,
    };
  const operations: CatalogOperation[] = [];
  const dropped: { name: string; code: string }[] = [];
  for (const op of parsed.data.operations) {
    const code = operationMismatch(provider, op);
    if (code === null) operations.push(op);
    else dropped.push({ name: op.name, code });
  }
  if (operations.length === 0)
    return {
      ok: false,
      provider,
      code: 'CATALOG_MISMATCH',
      reason: `no operation agrees with the ENS records (${dropped.map((d) => `${d.name}: ${d.code}`).join(', ')})`,
    };
  return { ok: true, provider, operations, dropped };
}

/** Fetch and check one provider's catalog. Never throws. */
export async function readCatalog(
  fetch: typeof globalThis.fetch,
  provider: ProviderAgent,
  timeoutMs = 10_000,
): Promise<CatalogResult> {
  let res: Response;
  try {
    res = await fetch(provider.endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      provider,
      code: error instanceof NetGuardError ? `NET_${error.code}` : 'CATALOG_UNREACHABLE',
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  }
  if (res.status !== 200)
    return { ok: false, provider, code: 'CATALOG_HTTP_ERROR', reason: `HTTP ${res.status}` };
  const text = await res.text();
  if (text.length > CATALOG_MAX_BYTES)
    return { ok: false, provider, code: 'CATALOG_TOO_LARGE', reason: `${text.length} bytes` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, provider, code: 'CATALOG_INVALID', reason: 'not JSON' };
  }
  return checkCatalog(provider, body);
}

export type BuiltUrl =
  | { readonly ok: true; readonly url: string; readonly operation: CatalogOperation }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * The request URL for a planned purchase, built only from the catalog (which
 * already agrees with ENS). Pure.
 */
export function buildPurchaseUrl(
  catalogs: ReadonlyMap<string, CatalogResult>,
  purchase: PlannedPurchase,
): BuiltUrl {
  const catalog = catalogs.get(purchase.provider);
  if (catalog === undefined)
    return {
      ok: false,
      code: 'UNKNOWN_PROVIDER',
      reason: `${purchase.provider} was not discovered`,
    };
  if (!catalog.ok)
    return {
      ok: false,
      code: 'PROVIDER_UNAVAILABLE',
      reason: `${purchase.provider}: ${catalog.code}`,
    };
  if (!catalog.provider.capabilities.includes(purchase.capability))
    return {
      ok: false,
      code: 'UNKNOWN_CAPABILITY',
      reason: `${purchase.provider} does not publish ${purchase.capability}`,
    };
  const operation = catalog.operations.find((o) => o.name === purchase.operation);
  if (operation === undefined)
    return {
      ok: false,
      code: 'UNKNOWN_OPERATION',
      reason: `${purchase.provider} has no operation "${purchase.operation}"`,
    };
  const allowed = Object.keys(operation.params);
  const extra = Object.keys(purchase.params).filter((k) => !allowed.includes(k));
  if (extra.length > 0)
    return {
      ok: false,
      code: 'PARAM_NOT_ALLOWED',
      reason: `${operation.name} takes ${allowed.join(', ') || 'no parameters'}, not ${extra.join(', ')}`,
    };
  const url = new URL(operation.path, catalog.provider.endpoint);
  for (const key of Object.keys(purchase.params).sort())
    url.searchParams.set(key, purchase.params[key] ?? '');
  return { ok: true, url: url.toString(), operation };
}
