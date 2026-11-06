/**
 * The committed, verified Sepolia records shown on the Providers page (D-066):
 * ERC-8004 agent IDs (deployments/sepolia-erc8004.json, written by
 * `pnpm erc8004:register`) and the ENSv2 subname setups
 * (deployments/sepolia-setups.json, written by `pnpm ens:setups`).
 *
 * Read once at startup: they change only with a commit, so a redeploy picks
 * them up. A missing or malformed file is reported as null (the page then says
 * "not registered yet"), never as an error that stops the agent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ERC8004_DEPLOYMENT_PATH,
  parseErc8004Deployment,
  type Erc8004Deployment,
} from '@agent-economy/ens/erc8004';
import { SETUPS_PATH, parseSetups, type EnsSetupsRecord } from '@agent-economy/ens/setups';

export interface DeploymentRecords {
  readonly erc8004: Erc8004Deployment | null;
  readonly setups: EnsSetupsRecord | null;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Pure apart from the two file reads; `root` is the repository root. */
export function readDeploymentRecords(root: string): DeploymentRecords {
  return {
    erc8004: parseErc8004Deployment(readJson(resolve(root, ERC8004_DEPLOYMENT_PATH))),
    setups: parseSetups(readJson(resolve(root, SETUPS_PATH))),
  };
}
