/**
 * The request as clients addressed it (D-062). Behind a TLS-terminating proxy
 * (Render) the service receives `http://…` URLs, while clients and the ENS
 * records use `https://<public host>`. The x402 middleware quotes the request
 * URL as the payment's resource, and the agent's firewall refuses a resource
 * outside the provider's ENS endpoint (ENDPOINT_MISMATCH). So every GET/HEAD
 * is rebuilt on PROVIDERS_PUBLIC_URL's origin before the app sees it. Locally
 * the public URL is the listening address, and nothing changes. Pure.
 */
export function toPublicRequest(request: Request, publicUrl: string): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;
  const target = new URL(publicUrl);
  const url = new URL(request.url);
  if (url.origin === target.origin) return request;
  return new Request(`${target.origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  });
}
