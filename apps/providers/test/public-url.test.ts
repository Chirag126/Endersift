// Class: unit. Requests rebuilt on the public URL behind a TLS proxy (D-062).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPublicRequest } from '../src/public-url.ts';

describe('toPublicRequest', () => {
  const PUBLIC = 'https://threat-intel-providers.onrender.com';

  it('a request Render forwarded as http becomes the https URL clients used, path and query kept', () => {
    const r = toPublicRequest(
      new Request(
        'http://threat-intel-providers.onrender.com/v1/kev/recent?since=2026-10-20&limit=5',
        {
          headers: { 'payment-signature': 'x' },
        },
      ),
      PUBLIC,
    );
    assert.equal(r.url, `${PUBLIC}/v1/kev/recent?since=2026-10-20&limit=5`);
    assert.equal(r.headers.get('payment-signature'), 'x');
    assert.equal(r.method, 'GET');
  });

  it('the host also comes from the public URL, never from the request', () => {
    const r = toPublicRequest(new Request('http://10.0.0.5:10000/v1/cve'), PUBLIC);
    assert.equal(r.url, `${PUBLIC}/v1/cve`);
  });

  it('locally (the public URL is the listening address) the request is unchanged', () => {
    const original = new Request('http://127.0.0.1:4021/v1/osv/query?ecosystem=npm');
    assert.equal(toPublicRequest(original, 'http://127.0.0.1:4021'), original);
  });

  it('only GET and HEAD are rebuilt', () => {
    const post = new Request('http://x.example/v1/kev', { method: 'POST', body: '{}' });
    assert.equal(toPublicRequest(post, PUBLIC), post);
    assert.equal(
      toPublicRequest(new Request('http://x/v1', { method: 'HEAD' }), PUBLIC).url,
      `${PUBLIC}/v1`,
    );
  });
});
