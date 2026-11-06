/**
 * Local registration state, kept in the gitignored .secrets/ folder.
 *
 * It holds the commitment secret, which is written BEFORE the commit tx is
 * sent: losing it after committing would strand the commitment, and the
 * secret must stay private until the name is registered (it would let anyone
 * front-run the reveal). Transaction hashes are recorded as soon as a tx is
 * sent, so an interrupted run resumes instead of repeating a step.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredRegistration {
  version: 1;
  chainId: number;
  name: string;
  label: string;
  owner: string;
  secret: string;
  resolver: string | null;
  resolverTx: string | null;
  commitment: string | null;
  commitTx: string | null;
  mintTx: string | null;
  approveTx: string | null;
  registerTx: string | null;
  textTxs: Record<string, string>;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class RegistrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationStateError';
  }
}

export function newRegistration(input: {
  chainId: number;
  name: string;
  label: string;
  owner: string;
  secret: string;
}): StoredRegistration {
  if (!HEX32.test(input.secret)) throw new RegistrationStateError('secret must be 32 bytes of hex');
  return {
    version: 1,
    ...input,
    resolver: null,
    resolverTx: null,
    commitment: null,
    commitTx: null,
    mintTx: null,
    approveTx: null,
    registerTx: null,
    textTxs: {},
  };
}

/** Parse and validate a stored file; refuses one written for another name, owner or chain. */
export function parseRegistration(
  text: string,
  expected: { chainId: number; name: string; owner: string },
): StoredRegistration {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RegistrationStateError('state file is not valid JSON');
  }
  const d = data as Partial<StoredRegistration>;
  if (d.version !== 1) throw new RegistrationStateError('unsupported state file version');
  if (d.chainId !== expected.chainId)
    throw new RegistrationStateError('state file is for another chain');
  if (d.name !== expected.name) throw new RegistrationStateError('state file is for another name');
  if (typeof d.owner !== 'string' || d.owner.toLowerCase() !== expected.owner.toLowerCase()) {
    throw new RegistrationStateError('state file belongs to another owner address');
  }
  if (typeof d.secret !== 'string' || !HEX32.test(d.secret)) {
    throw new RegistrationStateError('state file secret is malformed');
  }
  if (d.resolver !== null && (typeof d.resolver !== 'string' || !ADDRESS.test(d.resolver))) {
    throw new RegistrationStateError('state file resolver is malformed');
  }
  return d as StoredRegistration;
}

/** Atomic write (temp file + rename, owner-only) so a crash never leaves a half-written file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function saveRegistration(path: string, state: StoredRegistration): void {
  writeJsonAtomic(path, state);
}

export function loadRegistration(
  path: string,
  expected: { chainId: number; name: string; owner: string },
): StoredRegistration | null {
  if (!existsSync(path)) return null;
  return parseRegistration(readFileSync(path, 'utf8'), expected);
}
