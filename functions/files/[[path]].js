// Serves uploaded files (images, PDFs) stored in D1 at /files/<name>.
export async function onRequestGet({ request, env, params, waitUntil }) {
  const name = (params.path || []).map(decodeURIComponent).join('/');
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const meta = await env.DB.prepare('SELECT type, size, chunks FROM files WHERE name = ?').bind(name).first();
  if (!meta) return new Response('Not found', { status: 404 });
  const rows = await env.DB.prepare('SELECT data FROM file_chunks WHERE name = ? ORDER BY idx').bind(name).all();
  const out = new Uint8Array(meta.size);
  let off = 0;
  for (const r of rows.results) {
    const part = new Uint8Array(r.data);
    out.set(part, off);
    off += part.length;
  }
  const res = new Response(out, {
    headers: {
      'Content-Type': meta.type,
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
  waitUntil(cache.put(request, res.clone()));
  return res;
}
