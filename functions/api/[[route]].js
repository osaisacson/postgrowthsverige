import {
  verifyPassword,
  makeSessionCookie,
  clearSessionCookie,
  currentAdmin,
  hashPassword,
  randomToken,
  sha256,
  sendEmail,
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
  const me = await currentAdmin(request, env);
  const admin = !!me;

  try {
    // Simple CSRF guard: browsers can't add custom headers cross-site without a CORS preflight we never allow.
    if (method !== 'GET' && request.headers.get('X-PGS') !== '1') return json({ error: 'Bad request' }, 400);

    // ---- public ----
    if (parts[0] === 'site' && method === 'GET') return json(await getSite(env, me));
    if (parts[0] === 'login' && method === 'POST') return login(request, env, url);
    if (parts[0] === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    if (parts[0] === 'me') return json({ admin, email: me });
    if (parts[0] === 'password' && parts[1] === 'forgot' && method === 'POST') return forgotPassword(request, env, url);
    if (parts[0] === 'password' && parts[1] === 'set' && method === 'POST') return setPassword(request, env, url);
    if (parts[0] === 'password' && parts[1] === 'check' && method === 'GET') {
      const tok = await readToken(env.DB, url.searchParams.get('token'));
      return tok ? json({ email: tok.email, purpose: tok.purpose }) : json({ error: 'Länken är ogiltig eller har gått ut.' }, 400);
    }

    // ---- everything below needs admin ----
    if (!admin) return json({ error: 'Inte inloggad' }, 401);

    const db = env.DB;
    const body = method === 'POST' || method === 'PATCH' ? await readBody(request) : {};
    const handled = await adminRoutes(request, env, url, parts, method, me, body);
    if (handled) return handled;

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

// ---------------------------------------------------------------- auth

const WINDOW = 15 * 60 * 1000;
async function rateLimited(db, key, max) {
  const row = await db.prepare('SELECT fails, last_at FROM login_attempts WHERE ip = ?').bind(key).first();
  return row && row.fails >= max && Date.now() - row.last_at < WINDOW;
}
async function countAttempt(db, key) {
  const now = Date.now();
  const row = await db.prepare('SELECT fails, last_at FROM login_attempts WHERE ip = ?').bind(key).first();
  const fails = row && now - row.last_at < WINDOW ? row.fails + 1 : 1;
  await db
    .prepare('INSERT INTO login_attempts (ip, fails, last_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, last_at = excluded.last_at')
    .bind(key, fails, now)
    .run();
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// The first admin comes from the ADMIN_EMAIL / ADMIN_PASSWORD_HASH secrets; after that, admins live in the database.
async function bootstrapOwner(env) {
  const any = await env.DB.prepare('SELECT 1 FROM admins LIMIT 1').first();
  if (!any && env.ADMIN_EMAIL && env.ADMIN_PASSWORD_HASH) {
    await env.DB.prepare('INSERT OR IGNORE INTO admins (email, password_hash) VALUES (?, ?)').bind(normEmail(env.ADMIN_EMAIL), env.ADMIN_PASSWORD_HASH).run();
  }
}

async function login(request, env, url) {
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (await rateLimited(db, ip, 8)) return json({ error: 'För många försök. Vänta 15 minuter.' }, 429);
  await bootstrapOwner(env);
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  const row = await db.prepare('SELECT password_hash FROM admins WHERE email = ?').bind(email).first();
  const ok = row && row.password_hash && (await verifyPassword(String(body.password || ''), row.password_hash));
  if (!ok) {
    await countAttempt(db, ip);
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: 'Fel e-post eller lösenord' }, 401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  return json({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(env, url, email) });
}

async function issueToken(db, email, purpose, hours) {
  const token = randomToken();
  await db.batch([
    db.prepare('DELETE FROM auth_tokens WHERE email = ? AND purpose = ?').bind(email, purpose),
    db.prepare('INSERT INTO auth_tokens (token_hash, email, purpose, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), email, purpose, Date.now() + hours * 3600e3),
  ]);
  return token;
}
async function readToken(db, token) {
  if (!token) return null;
  const row = await db.prepare('SELECT email, purpose, expires_at FROM auth_tokens WHERE token_hash = ?').bind(await sha256(String(token))).first();
  return row && row.expires_at > Date.now() ? row : null;
}

async function siteTitle(db) {
  const r = await db.prepare("SELECT value FROM settings WHERE key = 'site_title'").first();
  return r ? r.value : 'Post-growth Sverige';
}

function emailLayout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;line-height:1.55">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e7e5;border-radius:12px;padding:28px">
<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px">${title}</h1>${bodyHtml}</div></body></html>`;
}
const btn = (href, label) =>
  `<p style="margin:24px 0"><a href="${href}" style="background:#2b8a55;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block;font-weight:600">${label}</a></p>`;
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function inviteEmail(site, origin, link, inviter) {
  const admin = `${origin}/admin`;
  const steps = [
    `Gå till <a href="${admin}">${admin}</a> och logga in med din e-postadress och ditt lösenord.`,
    'I menyn till vänster lägger du till en sektion med <b>Ny sektion</b>. Plustecknet bredvid en sektion skapar en ny sida i den.',
    'Öppna en sida och klicka på <b>Redigera</b>. Du skriver i Markdown och ser resultatet direkt bredvid. Allt sparas automatiskt.',
    'Skriv <code>[[</code> för att länka till en annan sida, till exempel <code>[[Definition]]</code>. Länkarna syns i grafen till höger.',
    'Dra in eller klistra in en bild i texten för att ladda upp den.',
    'Tre-punktsmenyn uppe till höger på en sida har fler val: innehållsförteckning av eller på, byt namn, flytta eller ta bort.',
  ];
  const html = emailLayout(
    `Du är nu admin för ${escHtml(site)}`,
    `<p>${escHtml(inviter)} har lagt till dig som admin för ${escHtml(site)}. Börja med att välja ett lösenord:</p>
${btn(link, 'Välj lösenord')}
<p style="font-size:13px;color:#5c625f">Länken gäller i 7 dagar.</p>
<h2 style="font-family:Georgia,serif;font-size:17px;margin:28px 0 8px">Så redigerar du sajten</h2>
<ol style="padding-left:20px">${steps.map((s) => `<li style="margin:6px 0">${s}</li>`).join('')}</ol>`
  );
  const text = `${inviter} har lagt till dig som admin för ${site}.

Välj ett lösenord här (gäller i 7 dagar):
${link}

Så redigerar du sajten:
${steps.map((s, i) => `${i + 1}. ${s.replace(/<[^>]+>/g, '')}`).join('\n')}
`;
  return { subject: `Du är nu admin för ${site}`, html, text };
}

function resetEmail(site, link) {
  const html = emailLayout(
    'Återställ ditt lösenord',
    `<p>Någon bad om att återställa lösenordet för ditt admin-konto på ${escHtml(site)}. Klicka på knappen för att välja ett nytt lösenord:</p>
${btn(link, 'Välj nytt lösenord')}
<p style="font-size:13px;color:#5c625f">Länken gäller i 1 timme. Om det inte var du kan du strunta i det här mejlet.</p>`
  );
  const text = `Välj ett nytt lösenord för ditt admin-konto på ${site} (länken gäller i 1 timme):\n${link}\n\nOm det inte var du kan du strunta i det här mejlet.`;
  return { subject: `Återställ lösenordet för ${site}`, html, text };
}

async function forgotPassword(request, env, url) {
  const db = env.DB;
  const ip = 'forgot:' + (request.headers.get('CF-Connecting-IP') || 'local');
  if (await rateLimited(db, ip, 5)) return json({ error: 'För många försök. Vänta 15 minuter.' }, 429);
  await countAttempt(db, ip);
  await bootstrapOwner(env);
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  const row = await db.prepare('SELECT email FROM admins WHERE email = ?').bind(email).first();
  if (row) {
    const token = await issueToken(db, email, 'reset', 1);
    const msg = resetEmail(await siteTitle(db), `${url.origin}/admin/reset?token=${token}`);
    await sendEmail(env, { to: email, ...msg }).catch(() => {});
  }
  // Same answer either way, so the form doesn't reveal who is an admin.
  return json({ ok: true, emailConfigured: !!env.RESEND_API_KEY });
}

async function setPassword(request, env, url) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  const tok = await readToken(db, body.token);
  if (!tok) return json({ error: 'Länken är ogiltig eller har gått ut. Be om en ny.' }, 400);
  const password = String(body.password || '');
  if (password.length < 8) return json({ error: 'Lösenordet måste vara minst 8 tecken.' }, 400);
  const exists = await db.prepare('SELECT 1 FROM admins WHERE email = ?').bind(tok.email).first();
  if (!exists) return json({ error: 'Kontot finns inte längre.' }, 400);
  await db.batch([
    db.prepare('UPDATE admins SET password_hash = ? WHERE email = ?').bind(await hashPassword(password), tok.email),
    db.prepare('DELETE FROM auth_tokens WHERE email = ?').bind(tok.email),
  ]);
  return json({ ok: true, email: tok.email }, 200, { 'Set-Cookie': await makeSessionCookie(env, url, tok.email) });
}

async function adminRoutes(request, env, url, parts, method, me, body) {
  const db = env.DB;
  if (parts[0] === 'password' && parts[1] === 'change' && method === 'POST') {
    const row = await db.prepare('SELECT password_hash FROM admins WHERE email = ?').bind(me).first();
    if (!row || !(await verifyPassword(String(body.current || ''), row.password_hash))) return json({ error: 'Nuvarande lösenord stämmer inte.' }, 400);
    if (String(body.password || '').length < 8) return json({ error: 'Lösenordet måste vara minst 8 tecken.' }, 400);
    await db.prepare('UPDATE admins SET password_hash = ? WHERE email = ?').bind(await hashPassword(String(body.password)), me).run();
    return json({ ok: true });
  }
  if (parts[0] !== 'admins') return null;
  if (!parts[1] && method === 'GET') {
    const r = await db.prepare('SELECT email, password_hash IS NULL AS pending, invited_by, created_at FROM admins ORDER BY created_at').all();
    return json({ me, emailConfigured: !!env.RESEND_API_KEY, admins: r.results.map((a) => ({ ...a, pending: !!a.pending })) });
  }
  if (!parts[1] && method === 'POST') {
    const email = normEmail(body.email);
    if (!validEmail(email)) return json({ error: 'Ange en giltig e-postadress.' }, 400);
    const existing = await db.prepare('SELECT password_hash FROM admins WHERE email = ?').bind(email).first();
    if (existing && existing.password_hash) return json({ error: 'Personen är redan admin.' }, 400);
    if (!existing) await db.prepare('INSERT INTO admins (email, invited_by) VALUES (?, ?)').bind(email, me).run();
    const token = await issueToken(db, email, 'invite', 24 * 7);
    const link = `${url.origin}/admin/reset?token=${token}`;
    const msg = inviteEmail(await siteTitle(db), url.origin, link, me);
    let sent = false;
    let warning = null;
    try {
      sent = await sendEmail(env, { to: email, ...msg });
    } catch (err) {
      warning = err.message;
    }
    return json({ ok: true, sent, link: sent ? null : link, warning });
  }
  if (parts[1] && method === 'DELETE') {
    const email = normEmail(parts[1]);
    if (email === me) return json({ error: 'Du kan inte ta bort dig själv.' }, 400);
    const active = await db.prepare('SELECT COUNT(*) AS n FROM admins WHERE password_hash IS NOT NULL AND email != ?').bind(email).first();
    if (!active.n) return json({ error: 'Det måste finnas minst en admin.' }, 400);
    await db.batch([db.prepare('DELETE FROM auth_tokens WHERE email = ?').bind(email), db.prepare('DELETE FROM admins WHERE email = ?').bind(email)]);
    return json({ ok: true });
  }
  return null;
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
