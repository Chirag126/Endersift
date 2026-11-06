// Class: unit (offline). Proves the published @x402/core and @x402/hedera
// packages install from npm and expose the entry points Phase 3 will use.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { x402Client } from '@x402/core/client';
import {
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_USDC,
  createClientHederaSigner,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';

describe('@x402 packages', () => {
  it('expose the Hedera exact-scheme client entry points', () => {
    assert.equal(typeof x402Client, 'function');
    assert.equal(typeof createClientHederaSigner, 'function');
    assert.equal(typeof ExactHederaScheme, 'function');
  });

  it('agree with our configuration constants', () => {
    assert.equal(HEDERA_TESTNET_CAIP2, 'hedera:testnet');
    assert.equal(HBAR_ASSET_ID, '0.0.0');
    // Recorded for Phase 36 (HTS USDC settlement).
    assert.equal(HEDERA_TESTNET_USDC, '0.0.429274');
  });
});
