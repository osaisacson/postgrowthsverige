// Shared server helpers for Pages Functions: auth, site data, slugs.

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// Hash format: pbkdf2$<iterations>$<salt b64>$<hash b64>
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, iterStr, saltB64, hashB64] = stored.split('$');
  if (algo !== 'pbkdf2') return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: parseInt(iterStr, 10) },
    key,
    256
  );
  return timingSafeEqual(new Uint8Array(bits), fromB64(hashB64));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const COOKIE = 'pgs_session';
const SESSION_DAYS = 30;

export async function makeSessionCookie(env, url, email) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, email })));
  const sig = await hmac(env.SESSION_SECRET, payload);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Returns the logged-in admin's email, or null. Removed admins lose access immediately.
export async function currentAdmin(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(enc.encode(expected), enc.encode(sig))) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(fromB64(payload)));
  } catch {
    return null;
  }
  if (typeof data.exp !== 'number' || data.exp <= Date.now() || !data.email) return null;
  const row = await env.DB.prepare('SELECT email FROM admins WHERE email = ? AND password_hash IS NOT NULL').bind(data.email).first();
  return row ? row.email : null;
}
export async function isAdmin(request, env) {
  return !!(await currentAdmin(request, env));
}

export async function hashPassword(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(bits)}`;
}

export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Sends an email through Resend when RESEND_API_KEY is set. Returns true if sent.
export async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) return false;
  const from = env.EMAIL_FROM || 'Post-growth Sverige <admin@postgrowthsverige.se>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error('E-post kunde inte skickas: ' + (await res.text()).slice(0, 200));
  return true;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function slugify(title) {
  const s = String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) return 'sida';
  return ['admin', 'api', 'files'].includes(s.toLowerCase()) ? `${s}-sida` : s;
}

export async function uniqueSlug(db, title, exceptId = null) {
  const base = slugify(title);
  let slug = base;
  let n = 2;
  for (;;) {
    const row = await db.prepare('SELECT id FROM pages WHERE slug = ?').bind(slug).first();
    if (!row || row.id === exceptId) return slug;
    slug = `${base}-${n++}`;
  }
}

export async function getSite(env, admin) {
  const db = env.DB;
  const [settings, sections, pages, files] = await db.batch([
    db.prepare('SELECT key, value FROM settings'),
    db.prepare('SELECT id, name, sort FROM sections ORDER BY sort, id'),
    db.prepare('SELECT id, section_id, title, slug, content, sort, options, is_home, updated_at FROM pages ORDER BY sort, id'),
    db.prepare('SELECT name FROM files ORDER BY name'),
  ]);
  const s = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  return {
    title: s.site_title || 'Post-growth Sverige',
    admin: !!admin,
    me: typeof admin === 'string' ? admin : null,
    sections: sections.results,
    pages: pages.results.map((p) => ({ ...p, options: safeJson(p.options), is_home: !!p.is_home })),
    files: files.results.map((f) => f.name),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}') || {};
  } catch {
    return {};
  }
}

// Rewrite [[Old]] / [[Old|x]] / [[Old#h]] / [[folder/Old]] to the new title across all pages.
export function rewriteLinks(content, oldTitle, newTitle) {
  const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(!?\\[\\[)(?:[^\\]|#\\n]*/)?${esc}((?:#[^\\]|\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\])`, 'gi');
  return content.replace(re, `$1${newTitle}$2`);
}
