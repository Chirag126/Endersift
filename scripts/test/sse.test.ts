// Class: unit. The SSE parser used by the live API check.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSse } from '../lib/sse.ts';

describe('parseSse', () => {
  it('reads id, event and data; skips retry lines and comments', () => {
    const text =
      'retry: 3000\n\n: ping\n\nid: 0\nevent: RUN_STARTED\ndata: {"seq":0}\n\nid: 1\nevent: RUN_FINISHED\ndata: {"a":\ndata: 1}\n\nevent: end\ndata: {"status":"SUCCEEDED"}\n\n';
    assert.deepEqual(parseSse(text), [
      { id: '0', event: 'RUN_STARTED', data: '{"seq":0}' },
      { id: '1', event: 'RUN_FINISHED', data: '{"a":\n1}' },
      { id: null, event: 'end', data: '{"status":"SUCCEEDED"}' },
    ]);
  });

  it('handles CRLF and an empty stream', () => {
    assert.deepEqual(parseSse('id: 5\r\nevent: x\r\ndata: y\r\n\r\n'), [
      { id: '5', event: 'x', data: 'y' },
    ]);
    assert.deepEqual(parseSse(''), []);
  });
});
