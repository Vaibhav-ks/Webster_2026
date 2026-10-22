// Cloudflare Pages Function: forwards /api/* on the frontend's own origin to the
// Express API (Render, or any host set in API_ORIGIN). Because the browser only ever
// talks to its own origin, the refresh cookie is first-party (SameSite=Strict) and no
// CORS is needed. Bodies are streamed through; video bytes never pass here (they go
// straight from the browser to R2 with presigned URLs).
//
// Pages project settings -> Environment variables:
//   API_ORIGIN           e.g. https://scarlet-rewrite-api.onrender.com   (required)
//   PROXY_SHARED_SECRET  same value as the API's PROXY_SHARED_SECRET      (recommended)

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host'];

export async function onRequest({ request, env }) {
  if (!env.API_ORIGIN) {
    return Response.json({ error: { code: 'PROXY_MISCONFIGURED', message: 'API_ORIGIN is not set.' } }, { status: 502 });
  }
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.API_ORIGIN);

  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  // The real client IP for the API's rate limiting, vouched for by the shared secret.
  headers.set('x-client-ip', request.headers.get('cf-connecting-ip') ?? '');
  if (env.PROXY_SHARED_SECRET) headers.set('x-proxy-secret', env.PROXY_SHARED_SECRET);
  else headers.delete('x-proxy-secret');

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      { error: { code: 'API_UNREACHABLE', message: 'The server is starting up or unreachable. Try again in a moment.' } },
      { status: 502 },
    );
  }
  // Pass status, headers (including Set-Cookie) and body through unchanged.
  return new Response(upstream.body, upstream);
}
