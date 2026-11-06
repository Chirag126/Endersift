/**
 * 0G inference availability at start (D-079). Kept apart from wiring.ts, which
 * loads the chain clients, so the rule is testable on its own.
 */

/**
 * Why 0G inference cannot run with this model at start, or null when it can
 * (D-079): the catalog could not be read, or the model is not in it. Pure.
 */
export function zgModelProblem(
  modelId: string,
  network: 'testnet' | 'mainnet',
  catalog: readonly { readonly id: string }[],
  catalogError: string | null,
): string | null {
  if (catalogError !== null)
    return `the 0G ${network} model catalog could not be read (${catalogError})`;
  if (catalog.some((m) => m.id === modelId)) return null;
  return `${modelId} is not in the 0G ${network} catalog right now`;
}
