/**
 * Per-agent operator keys (.secrets/ens-operator-keys.json, gitignored,
 * owner-only). Each agent gets its own EVM operator that may write only that
 * agent's delegated record keys on that agent's resolver (plan row 12 grants
 * the roles; plan row 13 proves the enforcement with these keys).
 *
 * The file is written before any role is granted, so a crash can never leave
 * a role held by an address whose key was lost. Keys are never printed.
 * Generation itself happens in the script (viem); this module only validates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from './state.ts';

export interface OperatorKey {
  readonly address: string;
  readonly privateKey: string;
}

export interface OperatorKeyFile {
  readonly version: 1;
  readonly chainId: number;
  readonly parent: string;
  readonly admin: string;
  readonly operators: Readonly<Record<string, OperatorKey>>;
}

export class OperatorKeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorKeyFileError';
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;

export function parseOperatorKeyFile(
  text: string,
  expected: { chainId: number; parent: string; admin: string },
): OperatorKeyFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OperatorKeyFileError('operator key file is not valid JSON');
  }
  const d = data as Partial<OperatorKeyFile>;
  if (d.version !== 1) throw new OperatorKeyFileError('unsupported operator key file version');
  if (d.chainId !== expected.chainId)
    throw new OperatorKeyFileError('operator key file is for another chain');
  if (d.parent !== expected.parent)
    throw new OperatorKeyFileError('operator key file is for another parent name');
  if (typeof d.admin !== 'string' || d.admin.toLowerCase() !== expected.admin.toLowerCase()) {
    throw new OperatorKeyFileError('operator key file belongs to another admin');
  }
  if (typeof d.operators !== 'object' || d.operators === null) {
    throw new OperatorKeyFileError('operator key file has no operators');
  }
  const seen = new Set<string>();
  for (const [label, op] of Object.entries(d.operators)) {
    if (typeof op?.address !== 'string' || !ADDRESS.test(op.address)) {
      throw new OperatorKeyFileError(`operator "${label}" has a malformed address`);
    }
    if (typeof op.privateKey !== 'string' || !KEY.test(op.privateKey)) {
      throw new OperatorKeyFileError(`operator "${label}" has a malformed key`);
    }
    const a = op.address.toLowerCase();
    if (a === expected.admin.toLowerCase()) {
      throw new OperatorKeyFileError(`operator "${label}" must not be the admin`);
    }
    if (seen.has(a)) throw new OperatorKeyFileError('two agents share one operator address');
    seen.add(a);
  }
  return d as OperatorKeyFile;
}

export function loadOperatorKeyFile(
  path: string,
  expected: { chainId: number; parent: string; admin: string },
): OperatorKeyFile | null {
  if (!existsSync(path)) return null;
  return parseOperatorKeyFile(readFileSync(path, 'utf8'), expected);
}

export function saveOperatorKeyFile(path: string, file: OperatorKeyFile): void {
  writeJsonAtomic(path, file);
}

/** Public view: label → operator address (never the key). */
export function operatorAddresses(file: OperatorKeyFile | null): Map<string, string> {
  const out = new Map<string, string>();
  if (file === null) return out;
  for (const [label, op] of Object.entries(file.operators)) out.set(label, op.address);
  return out;
}
