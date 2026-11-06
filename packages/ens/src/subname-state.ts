/**
 * Local progress file for subname provisioning (.secrets/, gitignored).
 * No secret is involved here (subregistry registration needs no commit-reveal);
 * it lives beside the parent's state for one place to look, and records
 * addresses and tx hashes so an interrupted run resumes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { RegistrationStateError, writeJsonAtomic } from './state.ts';

export interface StoredSubname {
  version: 1;
  chainId: number;
  parent: string;
  label: string;
  owner: string;
  registry: string | null;
  registryTx: string | null;
  setSubregistryTx: string | null;
  setParentTx: string | null;
  subResolver: string | null;
  subResolverTx: string | null;
  registerTx: string | null;
  setResolverTx: string | null;
  textTxs: Record<string, string>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function newSubname(input: {
  chainId: number;
  parent: string;
  label: string;
  owner: string;
}): StoredSubname {
  return {
    version: 1,
    ...input,
    registry: null,
    registryTx: null,
    setSubregistryTx: null,
    setParentTx: null,
    subResolver: null,
    subResolverTx: null,
    registerTx: null,
    setResolverTx: null,
    textTxs: {},
  };
}

export function parseSubname(
  text: string,
  expected: { chainId: number; parent: string; label: string; owner: string },
): StoredSubname {
  let d: Partial<StoredSubname>;
  try {
    d = JSON.parse(text) as Partial<StoredSubname>;
  } catch {
    throw new RegistrationStateError('subname state file is not valid JSON');
  }
  if (d.version !== 1) throw new RegistrationStateError('unsupported subname state version');
  if (d.chainId !== expected.chainId)
    throw new RegistrationStateError('subname state is for another chain');
  if (d.parent !== expected.parent || d.label !== expected.label) {
    throw new RegistrationStateError('subname state is for another name');
  }
  if (typeof d.owner !== 'string' || d.owner.toLowerCase() !== expected.owner.toLowerCase()) {
    throw new RegistrationStateError('subname state belongs to another owner address');
  }
  for (const k of ['registry', 'subResolver'] as const) {
    const v = d[k];
    if (v !== null && (typeof v !== 'string' || !ADDRESS.test(v))) {
      throw new RegistrationStateError(`subname state ${k} is malformed`);
    }
  }
  return d as StoredSubname;
}

export function loadSubname(
  path: string,
  expected: { chainId: number; parent: string; label: string; owner: string },
): StoredSubname | null {
  return existsSync(path) ? parseSubname(readFileSync(path, 'utf8'), expected) : null;
}

export function saveSubname(path: string, state: StoredSubname): void {
  writeJsonAtomic(path, state);
}
