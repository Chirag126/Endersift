import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOLDER_CREDIT_RUNS,
  HOLDER_LANE_PORT,
  JWT_PATTERN,
  buildEvidence,
  laneResult,
  zgAmount,
  decideVerdict,
  decodeJwtClaims,
  interpretBalance,
  interpretKeyList,
  type StepResult,
} from '../src/probe.ts';

// A structurally valid, unsigned test JWT, assembled at runtime.
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = [
  b64u({ alg: 'ES256' }),
  b64u({ iss: 'privy.io', aud: 'app-123', exp: 1793030000 }),
  'c2lnbmF0dXJlLXRlc3Q',
].join('.');
const ADDRESS = '0x125f33a973257b472194676e760aa1afcbeb8ce5';

const step = (accepted: boolean, status: number | null): StepResult => ({
  name: 's',
  status,
  accepted,
  detail: '',
});

describe('holder probe', () => {
  it('decodes issuer, audience and expiry without verifying', () => {
    assert.deepEqual(decodeJwtClaims(TOKEN), { iss: 'privy.io', aud: 'app-123', exp: 1793030000 });
    assert.equal(decodeJwtClaims('not.a.jwt!'), null);
    assert.equal(decodeJwtClaims('abc'), null);
  });

  it('reads a balance and infers the credit part as total minus deposit', () => {
    const { step: s, balance } = interpretBalance({
      status: 200,
      body: { address: ADDRESS, deposit_balance: '400', total_balance: '1400' },
    });
    assert.equal(s.accepted, true);
    assert.equal(balance?.inferredCreditPart, '1000');
    const none = interpretBalance({
      status: 200,
      body: { address: ADDRESS, deposit_balance: '400', total_balance: '400' },
    });
    assert.equal(none.balance?.inferredCreditPart, '0');
  });

  it('treats 401/403, malformed bodies and network errors as not accepted', () => {
    const rejected = interpretBalance({
      status: 401,
      body: { error: { type: 'invalid_request_error', code: 'invalid_api_key' } },
    });
    assert.equal(rejected.step.accepted, false);
    assert.match(rejected.step.detail, /401 invalid_request_error\/invalid_api_key/);
    assert.equal(interpretBalance({ status: 200, body: { address: 'x' } }).step.accepted, false);
    assert.match(
      interpretBalance({ status: null, body: null, networkError: 'boom' }).step.detail,
      /network error/,
    );
  });

  it('counts listed API keys without recording their contents', () => {
    const r = interpretKeyList({ status: 200, body: { data: [{ id: 'a' }, { id: 'b' }] } });
    assert.equal(r.keyCount, 2);
    assert.equal(r.step.accepted, true);
    assert.equal(interpretKeyList({ status: 403, body: null }).step.accepted, false);
  });

  it('decides verdicts for the real test and the negative control', () => {
    assert.equal(decideVerdict('0g', step(true, 200), step(true, 200)).verdict, 'YES_LIKELY');
    assert.equal(decideVerdict('0g', step(true, 200), step(false, 403)).verdict, 'PARTIAL');
    assert.equal(decideVerdict('0g', step(false, 401), step(false, 403)).verdict, 'NO_THIS_ROUTE');
    assert.equal(decideVerdict('0g', step(false, 500), step(false, 401)).verdict, 'INCONCLUSIVE');
    assert.equal(decideVerdict('0g', step(false, null), step(false, 401)).verdict, 'INCONCLUSIVE');
    assert.equal(
      decideVerdict('own', step(false, 401), step(false, 401)).verdict,
      'NEGATIVE_CONTROL_OK',
    );
    assert.equal(
      decideVerdict('own', step(true, 200), step(false, 401)).verdict,
      'NEGATIVE_CONTROL_UNEXPECTED',
    );
  });

  it('builds evidence that never contains the token, and refuses if one sneaks in', () => {
    const base = {
      network: 'mainnet' as const,
      appIdKind: 'own' as const,
      origin: 'http://localhost:5173',
      privyUserLinked: true,
      walletAddresses: [ADDRESS],
      claims: decodeJwtClaims(TOKEN),
      configuredAppId: 'app-123',
      balanceStep: step(false, 401),
      balance: null,
      keysStep: step(false, 401),
      keyCount: null,
      now: new Date('2026-10-26T15:00:00Z'),
    };
    const text = buildEvidence(base);
    assert.ok(!text.includes(TOKEN));
    assert.ok(!JWT_PATTERN.test(text));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(parsed['verdict'], 'NEGATIVE_CONTROL_OK');
    assert.deepEqual(parsed['token'], {
      issuer: 'privy.io',
      audienceMatchesConfiguredAppId: true,
      expiresAt: new Date(1793030000 * 1000).toISOString(),
    });
    assert.throws(() => buildEvidence({ ...base, origin: TOKEN }), /contains a JWT/);
  });
});

describe('holder lane page (plan row 30, D-058)', () => {
  const step = (accepted: boolean, detail: string): StepResult => ({
    name: 'x',
    status: accepted ? 200 : 401,
    accepted,
    detail,
  });

  it('shows the balance in 0G when the Router accepts the sign-in', () => {
    const { balance } = interpretBalance({
      status: 200,
      body: {
        address: ADDRESS,
        deposit_balance: '1000000000000000',
        total_balance: '1271000000000000000',
      },
    });
    const r = laneResult(balance, step(true, 'ok'), step(true, 'ok'));
    assert.match(
      r.balanceText,
      /^1\.271 0G available \(deposit 0\.001 0G; credits, inferred: 1\.27 0G\)/,
    );
    assert.match(r.accessText, /can also list/);
  });

  it('says plainly why the balance is not readable when the Router refuses', () => {
    const r = laneResult(
      null,
      step(false, 'HTTP 401 invalid_auth'),
      step(false, 'HTTP 401 invalid_auth'),
    );
    assert.equal(
      r.balanceText,
      'Not readable: the 0G Router refused this sign-in (HTTP 401 invalid_auth).',
    );
    assert.match(r.accessText, /cannot list/);
  });

  it('neuron to 0G is exact', () => {
    assert.equal(zgAmount('1326974000000000'), '0.001326974');
    assert.equal(zgAmount('2000000000000000000'), '2');
    assert.equal(zgAmount('0'), '0');
  });

  it('runs on holder credits stay off until the probe says yes; the lane uses an origin 0G allows', () => {
    assert.equal(HOLDER_CREDIT_RUNS.available, false);
    assert.match(HOLDER_CREDIT_RUNS.reason, /0G's Privy app ID/);
    assert.ok([3000, 3001, 5173].includes(HOLDER_LANE_PORT));
    assert.notEqual(HOLDER_LANE_PORT, 5173, 'the web app uses 5173');
    assert.notEqual(HOLDER_LANE_PORT, 3001, 'the agent API uses 3001');
  });
});
