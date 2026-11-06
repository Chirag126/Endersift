import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fundingLabel, parseCallFunding } from '../src/funding.ts';

// Shape of the live usage-history entry recorded on 2026-10-26 (testnet).
const LIVE_ENTRY = {
  id: 22700,
  request_id: '787b3070-6821-4172-9be9-9e5f64fdf390',
  cost: '599355333333333',
  credit_used: '0',
  deposit_used: '599355333333333',
};

describe('call funding', () => {
  it('classifies the live testnet call as deposit-funded, not credit-funded', () => {
    const f = parseCallFunding(LIVE_ENTRY);
    assert.deepEqual(f, { creditUsed: 0n, depositUsed: 599355333333333n, source: 'deposit' });
    assert.match(fundingLabel(f), /DEPOSIT/);
  });

  it('recognises credits, mixed and empty charges', () => {
    assert.equal(parseCallFunding({ credit_used: '5', deposit_used: '0' })?.source, 'credits');
    assert.equal(parseCallFunding({ credit_used: 5, deposit_used: '7' })?.source, 'mixed');
    assert.equal(parseCallFunding({ credit_used: '0', deposit_used: '0' })?.source, 'none');
  });

  it('returns null when the fields are absent or malformed', () => {
    assert.equal(parseCallFunding(null), null);
    assert.equal(parseCallFunding({ cost: '1' }), null);
    assert.equal(parseCallFunding({ credit_used: '-1', deposit_used: '0' }), null);
    assert.match(fundingLabel(null), /unknown/);
  });
});
