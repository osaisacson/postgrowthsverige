import {
  verifyPassword,
  makeSessionCookie,
  clearSessionCookie,
  isAdmin,
  json,
  uniqueSlug,
  getSite,
  rewriteLinks,
} from '../../lib/server.js';

const CHUNK = 1000 * 1000; // bytes per stored chunk (D1 rows max out at 2 MB)
const MAX_FILE = 25 * 1000 * 1000;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const parts = (params.route || []).map(decodeURIComponent);
  const method = request.method;
  const admin = await isAdmin(request, env);

  try {
    // ---- public ----
    if (parts[0] === 'site' && method === 'GET') return json(await getSite(env, admin));
    if (parts[0] === 'login' && method === 'POST') return login(request, env, url);
    if (parts[0] === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    if (parts[0] === 'me') return json({ admin });

    // ---- everything below needs admin ----
    if (!admin) return json({ error: 'Inte inloggad' }, 401);
    // Simple CSRF guard: browsers can't add custom headers cross-site without a CORS preflight we never allow.
    if (method !== 'GET' && request.headers.get('X-PGS') !== '1') return json({ error: 'Bad request' }, 400);

    const db = env.DB;
    const body = method === 'POST' || method === 'PATCH' ? await readBody(request) : {};

    if (parts[0] === 'settings' && method === 'PATCH') {
      if (typeof body.site_title === 'string' && body.site_title.trim()) {
        await db.prepare("INSERT INTO settings (key, value) VALUES ('site_title', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(body.site_title.trim()).run();
      }
      return json({ ok: true });
    }

    if (parts[0] === 'sections') {
      if (parts[1] === 'reorder' && method === 'POST') {
        await db.batch((body.ids || []).map((id, i) => db.prepare('UPDATE sections SET sort = ? WHERE id = ?').bind(i, id)));
        return json({ ok: true });
      }
      if (!parts[1] && method === 'POST') {
        const name = String(body.name || '').trim();
        if (!name) return json({ error: 'Namn saknas' }, 400);
        const max = await db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM sections').first();
        const r = await db.prepare('INSERT INTO sections (name, sort) VALUES (?, ?)').bind(name, max.m + 1).run();
        return json({ id: r.meta.last_row_id });
      }
      const id = parseInt(parts[1], 10);
      if (method === 'PATCH') {
        if (body.name !== undefined) await db.prepare('UPDATE sections SET name = ? WHERE id = ?').bind(String(body.name).trim(), id).run();
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM pages WHERE section_id = ? AND is_home = 0').bind(id),
          db.prepare('UPDATE pages SET section_id = NULL WHERE section_id = ?').bind(id),
          db.prepare('DELETE FROM sections WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
    }

    if (parts[0] === 'pages') {
      if (parts[1] === 'reorder' && method === 'POST') {
        const sectionId = body.section_id ?? null;
        await db.batch((body.ids || []).map((id, i) => db.prepare('UPDATE pages SET sort = ?, section_id = ? WHERE id = ?').bind(i, sectionId, id)));
        return json({ ok: true });
      }
      if (!parts[1] && method === 'POST') {
        const title = String(body.title || '').trim();
        if (!title) return json({ error: 'Namn saknas' }, 400);
        const sectionId = body.section_id ?? null;
        const slug = await uniqueSlug(db, title);
        const max = await db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM pages WHERE section_id IS ?').bind(sectionId).first();
        const r = await db
          .prepare('INSERT INTO pages (section_id, title, slug, content, sort, options) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(sectionId, title, slug, String(body.content || ''), max.m + 1, JSON.stringify(body.options || {}))
          .run();
        return json({ id: r.meta.last_row_id, slug });
      }
      const id = parseInt(parts[1], 10);
      const page = await db.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
      if (!page) return json({ error: 'Sidan finns inte' }, 404);

      if (parts[2] === 'home' && method === 'POST') {
        await db.batch([db.prepare('UPDATE pages SET is_home = 0'), db.prepare('UPDATE pages SET is_home = 1 WHERE id = ?').bind(id)]);
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        const stmts = [];
        let slug = page.slug;
        if (typeof body.title === 'string' && body.title.trim() && body.title.trim() !== page.title) {
          const newTitle = body.title.trim();
          slug = await uniqueSlug(db, newTitle, id);
          stmts.push(db.prepare('UPDATE pages SET title = ?, slug = ? WHERE id = ?').bind(newTitle, slug, id));
          // Keep [[links]] pointing at the renamed page, like Obsidian does.
          const others = await db.prepare('SELECT id, content FROM pages').all();
          for (const o of others.results) {
            const src = o.id === id && typeof body.content === 'string' ? body.content : o.content;
            const next = rewriteLinks(src, page.title, newTitle);
            if (next !== src) {
              if (o.id === id) body.content = next;
              else stmts.push(db.prepare('UPDATE pages SET content = ? WHERE id = ?').bind(next, o.id));
            }
          }
        }
        if (typeof body.content === 'string')
          stmts.push(db.prepare("UPDATE pages SET content = ?, updated_at = datetime('now') WHERE id = ?").bind(body.content, id));
        if (body.options && typeof body.options === 'object') {
          const merged = { ...JSON.parse(page.options || '{}'), ...body.options };
          stmts.push(db.prepare('UPDATE pages SET options = ? WHERE id = ?').bind(JSON.stringify(merged), id));
        }
        if (body.section_id !== undefined && body.section_id !== page.section_id) {
          const max = await db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM pages WHERE section_id IS ?').bind(body.section_id).first();
          stmts.push(db.prepare('UPDATE pages SET section_id = ?, sort = ? WHERE id = ?').bind(body.section_id, max.m + 1, id));
        }
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true, slug });
      }
      if (method === 'DELETE') {
        if (page.is_home) return json({ error: 'Startsidan kan inte tas bort' }, 400);
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
    }

    if (parts[0] === 'files') {
      if (!parts[1] && method === 'GET') {
        const r = await db.prepare('SELECT name, type, size, created_at FROM files ORDER BY created_at DESC').all();
        return json(r.results);
      }
      if (!parts[1] && method === 'POST') return upload(request, db, body);
      if (parts[1] && method === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM file_chunks WHERE name = ?').bind(parts[1]),
          db.prepare('DELETE FROM files WHERE name = ?').bind(parts[1]),
        ]);
        return json({ ok: true });
      }
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) return request.json().catch(() => ({}));
  if (type.includes('multipart/form-data')) return { form: await request.formData() };
  return {};
}

async function login(request, env, url) {
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const row = await db.prepare('SELECT fails, last_at FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && row.fails >= 8 && now - row.last_at < 15 * 60 * 1000) {
    return json({ error: 'För många försök. Vänta 15 minuter.' }, 429);
  }
  const body = await request.json().catch(() => ({}));
  const emailOk = String(body.email || '').trim().toLowerCase() === String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  const passOk = await verifyPassword(String(body.password || ''), env.ADMIN_PASSWORD_HASH);
  if (!emailOk || !passOk) {
    const fails = row && now - row.last_at < 15 * 60 * 1000 ? row.fails + 1 : 1;
    await db
      .prepare('INSERT INTO login_attempts (ip, fails, last_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, last_at = excluded.last_at')
      .bind(ip, fails, now)
      .run();
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: 'Fel e-post eller lösenord' }, 401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  return json({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(env, url) });
}

async function upload(request, db, body) {
  const form = body.form;
  const file = form && form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'Ingen fil' }, 400);
  if (file.size > MAX_FILE) return json({ error: 'Filen är för stor (max 25 MB)' }, 400);
  let name = String(form.get('name') || file.name || 'fil').replace(/[\\/[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim();
  const overwrite = form.get('overwrite') === '1';
  if (!overwrite) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (await db.prepare('SELECT 1 FROM files WHERE name = ?').bind(name).first()) name = `${stem} ${n++}${ext}`;
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const chunks = Math.max(1, Math.ceil(buf.length / CHUNK));
  const stmts = [
    db.prepare('DELETE FROM file_chunks WHERE name = ?').bind(name),
    db.prepare('INSERT OR REPLACE INTO files (name, type, size, chunks) VALUES (?, ?, ?, ?)').bind(name, file.type || guessType(name), buf.length, chunks),
  ];
  await db.batch(stmts);
  for (let i = 0; i < chunks; i++) {
    await db.prepare('INSERT INTO file_chunks (name, idx, data) VALUES (?, ?, ?)').bind(name, i, buf.slice(i * CHUNK, (i + 1) * CHUNK)).run();
  }
  return json({ name });
}

export function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' }[ext] ||
    'application/octet-stream'
  );
}
