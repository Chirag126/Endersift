// Class: unit. 0G inference unavailable at start (D-079): a chat model missing
// from the Router catalog, or a catalog 0G cannot serve, is reported instead of
// stopping the server; while the model is missing, the catalog is read again
// at most once a minute, so 0G listing it again needs no restart.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { InferenceCall } from '@agent-economy/core/domain';
import type { ZgModel, ZgRouterClient } from '@agent-economy/zg';
import type { ledgeredStructuredCall } from '../src/inference/ledgered-call.ts';
import { CATALOG_RECHECK_MS, ledgeredInference } from '../src/orchestrator/infer.ts';
import { zgModelProblem } from '../src/inference/zg-availability.ts';

describe('0G model unavailable at start (D-079)', () => {
  it('says why: the catalog could not be read, or the model is not in it', () => {
    const catalog = [{ id: '0gm-1.0-35b-a3b' }, { id: 'qwen-image-edit' }];
    assert.equal(zgModelProblem('0gm-1.0-35b-a3b', 'testnet', catalog, null), null);
    assert.equal(
      zgModelProblem('0gm-1.0-35b-a3b', 'testnet', [{ id: 'qwen-image-edit' }], null),
      '0gm-1.0-35b-a3b is not in the 0G testnet catalog right now',
    );
    assert.equal(
      zgModelProblem('0gm-1.0-35b-a3b', 'mainnet', [], 'Router 503'),
      'the 0G mainnet model catalog could not be read (Router 503)',
    );
  });

  it('reads the catalog again at most once a minute while the model is missing, then keeps it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const model = { id: '0gm-1.0-35b-a3b' } as ZgModel;
    const other = { id: 'qwen-image-edit' } as ZgModel;
    const catalogs = [[other], [other], [other, model]];
    let reads = 0;
    const client = {
      listModels: async () => ({ models: catalogs[Math.min(reads++, catalogs.length - 1)] ?? [] }),
    } as unknown as ZgRouterClient;
    // the real ledgered call refuses a model missing from the catalog (MODEL_NOT_IN_CATALOG);
    // this stand-in records the catalog it was given and answers the same way
    const seen: (readonly ZgModel[])[] = [];
    const call = mock.fn(async (...args: unknown[]) => {
      const input = args[1] as { catalog: readonly ZgModel[] };
      seen.push(input.catalog);
      return {
        kind: 'refused',
        code: input.catalog.some((m) => m.id === model.id) ? 'TEST_LISTED' : 'MODEL_NOT_IN_CATALOG',
        reason: 'test',
        call: {} as InferenceCall,
      };
    }) as unknown as typeof ledgeredStructuredCall;
    const infer = ledgeredInference(
      { client, ledger: {} as never },
      {
        network: 'testnet',
        modelId: model.id,
        capNeuron: 1n,
        dailyCapNeuron: 1n,
        timeoutMs: 1,
      },
      call,
    );
    const request = {
      runId: 'r',
      purpose: 'PLAN',
      task: {},
      maxTokens: 1,
    } as unknown as Parameters<typeof infer>[0];
    const code = async () => {
      const r = await infer(request);
      return r.ok ? 'ok' : r.code;
    };

    assert.equal(await code(), 'MODEL_NOT_IN_CATALOG');
    assert.equal(reads, 1);
    // within the minute: the same catalog, no new read
    t.mock.timers.tick(CATALOG_RECHECK_MS - 1);
    assert.equal(await code(), 'MODEL_NOT_IN_CATALOG');
    assert.equal(reads, 1);
    // a minute later: read again (still missing)
    t.mock.timers.tick(1);
    assert.equal(await code(), 'MODEL_NOT_IN_CATALOG');
    assert.equal(reads, 2);
    // another minute: 0G lists it again, no restart needed
    t.mock.timers.tick(CATALOG_RECHECK_MS);
    assert.equal(await code(), 'TEST_LISTED');
    assert.equal(reads, 3);
    // listed: kept, not read again
    t.mock.timers.tick(10 * CATALOG_RECHECK_MS);
    assert.equal(await code(), 'TEST_LISTED');
    assert.equal(reads, 3);
    assert.equal(seen.length, 5);
  });
});
