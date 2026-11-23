// Imports import/content.json and import/files/* into a running site through its admin API.
// Usage: PGS_EMAIL=... PGS_PASSWORD=... node scripts/import.mjs http://localhost:8788
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || 'http://localhost:8788').replace(/\/$/, '');
const dir = path.resolve(process.argv[3] || 'import');
let cookie = '';

async function call(p, opts = {}) {
  const headers = { 'X-PGS': '1', Cookie: cookie, Origin: base };
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(base + '/api/' + p, { method: opts.method || 'GET', headers, body });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

await call('login', { method: 'POST', body: { email: process.env.PGS_EMAIL, password: process.env.PGS_PASSWORD } });
const site = await call('site');
if (site.pages.length) {
  console.error('The site already has pages; refusing to import twice.');
  process.exit(1);
}

for (const f of fs.readdirSync(path.join(dir, 'files'))) {
  const buf = fs.readFileSync(path.join(dir, 'files', f));
  const form = new FormData();
  form.append('file', new Blob([buf]), f);
  form.append('name', f);
  form.append('overwrite', '1');
  const r = await call('files', { method: 'POST', body: form });
  console.log('file', r.name);
}

const pages = JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'));
const sectionIds = new Map();
for (const p of pages) {
  let sid = null;
  if (p.section) {
    if (!sectionIds.has(p.section)) sectionIds.set(p.section, (await call('sections', { method: 'POST', body: { name: p.section } })).id);
    sid = sectionIds.get(p.section);
  }
  const r = await call('pages', { method: 'POST', body: { title: p.title, section_id: sid, content: p.content } });
  if (p.home) await call(`pages/${r.id}/home`, { method: 'POST' });
  console.log('page', p.title, '->', r.slug);
}
console.log('done');
