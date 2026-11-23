// Injects site data and per-page <title>/meta into the HTML shell so pages render instantly and share nicely.
import { getSite, currentAdmin } from '../lib/server.js';

const ASSET = /\.(js|css|svg|png|jpe?g|webp|ico|txt|json|map|woff2?)$/i;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || ASSET.test(url.pathname)) {
    return next();
  }
  const res = await next();
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return res;

  const admin = await currentAdmin(request, env);
  const site = await getSite(env, admin);
  const slug = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
  const page = slug && slug !== 'admin' ? site.pages.find((p) => p.slug === slug) : site.pages.find((p) => p.is_home);
  const title = page && !page.is_home ? `${page.title} - ${site.title}` : site.title;
  const desc = page ? describe(page.content) : '';
  const data = JSON.stringify(site).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  const status = slug && !slug.startsWith('admin') && !page ? 404 : 200;

  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', desc); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', title); } })
    .on('meta[property="og:description"]', { element(el) { el.setAttribute('content', desc); } })
    .on('head', { element(el) { el.append(`<script>window.__SITE__=${data}</script>`, { html: true }); } })
    .transform(res);
  const headers = new Headers(out.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(out.body, { status, headers });
}

function describe(md) {
  return String(md || '')
    .replace(/^---[\s\S]*?\n---\n/, '')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
