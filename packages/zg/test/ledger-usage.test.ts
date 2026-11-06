// Class: unit. Daily-cap accounting and usage/balance parsing, with the field
// values seen live on 0G testnet (docs/evidence/zg/structured-20261027T083646Z.json).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDailyCap, chargeOf, sumCharges, utcDay, utcDayBounds } from '../src/ledger.ts';
import { parseBalanceFields, parseUsageEntry, parseUsageHistory } from '../src/usage.ts';

const LIVE_ENTRY = {
  id: 22727,
  request_id: '3081e4b7-e4e1-43f9-9a0d-b670b6eb4d03',
  provider_address: '0x1cB95Eb66Cc67C62d4DE0CC96726C5A5d82e7C85',
  model_id: '0GM-1.0-35B-A3B',
  canonical_id: '0gm-1.0-35b-a3b',
  api_key_id: '87832248-544b-4cbc-b895-efdae510be47',
  input_tokens: 502,
  output_tokens: 229,
  cached_tokens: 0,
  cost: '753694000000000',
  credit_used: '0',
  deposit_used: '314542666666667',
  created_at: '2026-10-27T08:36:40.291Z',
  trust_mode: 'private',
};

describe('daily-cap accounting', () => {
  it('charges each status as documented', () => {
    const w = 1_926n;
    assert.equal(chargeOf({ status: 'REFUSED', worstCaseNeuron: w, costNeuron: null }), 0n);
    assert.equal(chargeOf({ status: 'PENDING', worstCaseNeuron: w, costNeuron: null }), w);
    assert.equal(chargeOf({ status: 'UNKNOWN', worstCaseNeuron: w, costNeuron: null }), w);
    assert.equal(chargeOf({ status: 'SUCCEEDED', worstCaseNeuron: w, costNeuron: 754n }), 754n);
    assert.equal(chargeOf({ status: 'FAILED', worstCaseNeuron: w, costNeuron: 754n }), 754n);
    assert.equal(chargeOf({ status: 'FAILED', worstCaseNeuron: w, costNeuron: null }), 0n);
    assert.equal(
      sumCharges([
        { status: 'PENDING', worstCaseNeuron: 5n, costNeuron: null },
        { status: 'SUCCEEDED', worstCaseNeuron: 9n, costNeuron: 3n },
      ]),
      8n,
    );
  });

  it('allows a call only if spent + worst case fits the cap', () => {
    assert.deepEqual(checkDailyCap({ spent: 3n, worstCase: 2n, dailyCap: 5n }), {
      ok: true,
      spent: 3n,
      remainingAfter: 0n,
    });
    const no = checkDailyCap({ spent: 3n, worstCase: 3n, dailyCap: 5n });
    assert.equal(no.ok ? null : no.code, 'DAILY_CAP_EXCEEDED');
    assert.throws(() => checkDailyCap({ spent: 0n, worstCase: 1n, dailyCap: 0n }));
  });

  it('uses UTC calendar days', () => {
    assert.equal(utcDay('2026-10-27T08:36:40.291Z'), '2026-10-27');
    assert.throws(() => utcDay('2026-10-27T08:36:40+05:30'), /UTC/);
    assert.deepEqual(utcDayBounds('2026-10-27'), {
      start: '2026-10-27T00:00:00.000Z',
      end: '2026-10-28T00:00:00.000Z',
    });
    assert.throws(() => utcDayBounds('2026-02-30'), /real date/);
    assert.throws(() => utcDayBounds('27-10-2026'), /YYYY-MM-DD/);
  });
});

describe('usage history parsing', () => {
  it('reads the live entry exactly', () => {
    const e = parseUsageEntry(LIVE_ENTRY);
    assert.ok(e !== null);
    assert.equal(e.requestId, LIVE_ENTRY.request_id);
    assert.equal(e.model, '0gm-1.0-35b-a3b', 'canonical_id preferred');
    assert.equal(e.cost, 753_694_000_000_000n);
    assert.equal(e.depositUsed, 314_542_666_666_667n);
    assert.equal(e.inputTokens + e.outputTokens, 731);
  });

  it('skips entries missing what the ledger needs, and accepts both body shapes', () => {
    const { request_id: _r, ...noId } = LIVE_ENTRY;
    assert.equal(parseUsageEntry(noId), null);
    assert.equal(parseUsageEntry({ ...LIVE_ENTRY, cost: 1.5 }), null);
    assert.equal(parseUsageEntry({ ...LIVE_ENTRY, input_tokens: -1 }), null);
    const wrapped = parseUsageHistory({ data: [LIVE_ENTRY, { junk: true }] });
    assert.equal(wrapped.entries.length, 1);
    assert.equal(wrapped.unparsed, 1);
    assert.equal(parseUsageHistory([LIVE_ENTRY]).entries.length, 1);
    assert.equal(parseUsageHistory('nope').entries.length, 0);
  });
});

describe('balance fields', () => {
  it('keeps every figure, null when omitted', () => {
    const f = parseBalanceFields({
      address: '0x125f33a973257b472194676e760aa1afcbeb8ce5',
      currency: '0g',
      deposit_balance: '0',
      credit_balance: '0',
      pending_charge: '439151333333333',
      total_balance: '0',
    });
    assert.equal(f.pendingCharge, 439_151_333_333_333n);
    assert.equal(f.balance, null);
    assert.throws(() => parseBalanceFields({ address: 'x' }), /address/);
    assert.throws(() => parseBalanceFields({ address: f.address, total_balance: '-1' }));
  });
});
