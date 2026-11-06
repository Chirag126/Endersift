import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MESSAGE_OVERHEAD_TOKENS,
  checkBilling,
  checkCallCost,
  promptTokenUpperBound,
  worstCaseCost,
} from '../src/cost.ts';
import type { PricedModel } from '../src/cost.ts';
import type { ZgMessage, ZgModel } from '../src/router.ts';

const MODEL: PricedModel = {
  id: 'test-model',
  name: 'Test',
  type: 'chatbot',
  contextLength: 8192,
  promptPrice: 1_000n,
  completionPrice: 4_000n,
  providerCount: 1,
  pricingIssue: null,
  supportedParameters: ['max_tokens', 'response_format', 'chat_template_kwargs'],
};
const UNPRICED: ZgModel = {
  ...MODEL,
  id: 'image-model',
  promptPrice: null,
  completionPrice: null,
  pricingIssue: 'pricing.prompt is not a price',
};
const MESSAGES: ZgMessage[] = [{ role: 'user', content: 'hi' }];

describe('cost control', () => {
  it('bounds prompt tokens by UTF-8 bytes plus overhead', () => {
    // 'user' (4) + 'hi' (2) + per-message overhead + base overhead
    assert.equal(promptTokenUpperBound(MESSAGES), 4 + 2 + 2 * MESSAGE_OVERHEAD_TOKENS);
    // multi-byte text counts bytes, not characters
    const emoji = promptTokenUpperBound([{ role: 'user', content: '🔒' }]);
    assert.equal(emoji, 4 + 4 + 2 * MESSAGE_OVERHEAD_TOKENS);
  });

  it('computes the worst case from catalog prices', () => {
    assert.equal(worstCaseCost(MODEL, 10, 5), 10n * 1_000n + 5n * 4_000n);
  });

  it('allows a call under the cap and reports the bound', () => {
    const d = checkCallCost({
      catalog: [MODEL],
      modelId: 'test-model',
      messages: MESSAGES,
      maxTokens: 256,
      capNeuron: 10n ** 15n,
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.worstCase, 38n * 1_000n + 256n * 4_000n);
  });

  it('refuses a model missing from the catalog, before any request', () => {
    const d = checkCallCost({
      catalog: [MODEL],
      modelId: 'other',
      messages: MESSAGES,
      maxTokens: 1,
      capNeuron: 10n ** 18n,
    });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.code, 'MODEL_NOT_IN_CATALOG');
  });

  it('refuses a model without a usable per-token price instead of guessing', () => {
    const d = checkCallCost({
      catalog: [MODEL, UNPRICED],
      modelId: 'image-model',
      messages: MESSAGES,
      maxTokens: 1,
      capNeuron: 10n ** 18n,
    });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.code, 'PRICE_UNKNOWN');
      assert.match(d.reason, /pricing\.prompt is not a price/);
    }
  });

  it('refuses models that are not chat models (embedding, speech, decisions)', () => {
    for (const type of ['embedding', 'speech-to-text', 'decisions', null]) {
      const d = checkCallCost({
        catalog: [{ ...MODEL, type }],
        modelId: 'test-model',
        messages: MESSAGES,
        maxTokens: 1,
        capNeuron: 10n ** 18n,
      });
      assert.equal(d.ok, false, String(type));
      if (!d.ok) assert.equal(d.code, 'NOT_A_CHAT_MODEL');
    }
  });

  it('refuses when the worst case exceeds the spendable balance', () => {
    const base = {
      catalog: [MODEL],
      modelId: 'test-model',
      messages: MESSAGES,
      maxTokens: 256,
      capNeuron: 10n ** 15n,
    };
    const worst = 38n * 1_000n + 256n * 4_000n;
    const low = checkCallCost({ ...base, availableNeuron: worst - 1n });
    assert.equal(low.ok, false);
    if (!low.ok) assert.equal(low.code, 'BALANCE_TOO_LOW');
    assert.equal(checkCallCost({ ...base, availableNeuron: worst }).ok, true);
  });

  it('refuses when the worst case exceeds the cap', () => {
    const d = checkCallCost({
      catalog: [MODEL],
      modelId: 'test-model',
      messages: MESSAGES,
      maxTokens: 256,
      capNeuron: 1_000n,
    });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.code, 'COST_OVER_CAP');
      assert.ok((d.worstCase ?? 0n) > 1_000n);
    }
  });

  it('checks billing consistency after the call', () => {
    const good = { inputCost: 30n, outputCost: 70n, totalCost: 100n, exact: true };
    assert.ok(checkBilling(good, 1_000n, 2_000n).every((c) => c.ok));
    const wrongSum = checkBilling({ ...good, totalCost: 101n }, 1_000n, 2_000n);
    assert.equal(wrongSum.find((c) => c.name === 'total = input + output')?.ok, false);
    const overEstimate = checkBilling(good, 99n, 2_000n);
    assert.equal(overEstimate.find((c) => c.name.includes('worst case'))?.ok, false);
    const inexact = checkBilling({ ...good, exact: false }, 1_000n, 2_000n);
    assert.equal(inexact[0]?.ok, false);
  });
});

describe('router float', () => {
  it('notes, never refuses, when the worst case exceeds the Router float', async () => {
    const { routerFloatNote } = await import('../src/cost.ts');
    assert.equal(routerFloatNote(100n, 100n), null);
    assert.equal(routerFloatNote(100n, 1_000n), null);
    assert.match(
      routerFloatNote(1_924_543n, 314_542n) ?? '',
      /pulls the rest from the Payment Layer/,
    );
    assert.match(routerFloatNote(2n, 1n) ?? '', /402 insufficient_balance, no charge/);
  });
});
