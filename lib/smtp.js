// Minimal SMTP client for Workers (implicit TLS on port 465), used to send invite and reset emails
// through the site's own mail server. Config: SMTP_HOST, SMTP_PORT (465), SMTP_USER, SMTP_PASS, EMAIL_FROM.
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(str) {
  const bytes = enc.encode(str);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
// RFC 2047 encoded-word for non-ASCII headers (subject, display name).
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}
function wrap76(s) {
  return s.replace(/.{1,76}/g, '$&\r\n');
}

export async function sendSmtp(env, { to, subject, html, text }) {
  const host = env.SMTP_HOST;
  const port = parseInt(env.SMTP_PORT || '465', 10);
  const from = env.EMAIL_FROM || env.SMTP_USER;
  const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
  const fromName = from.includes('<') ? from.slice(0, from.indexOf('<')).trim().replace(/^"|"$/g, '') : '';

  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buf = '';

  async function reply() {
    // Read until a full reply (last line has "NNN " form).
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const out = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          return { code: parseInt(lines[i].slice(0, 3), 10), text: out };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP-servern stängde anslutningen');
      buf += dec.decode(value, { stream: true });
    }
  }
  async function cmd(line, expect) {
    if (line !== null) await writer.write(enc.encode(line + '\r\n'));
    const r = await reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP: ${r.text.slice(0, 200)}`);
    return r;
  }

  try {
    await cmd(null, [220]);
    await cmd(`EHLO ${new URL('https://' + (fromAddr.split('@')[1] || 'localhost')).hostname}`, [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(env.SMTP_USER), [334]);
    await cmd(b64(env.SMTP_PASS), [235]);
    await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const boundary = 'pgs-' + crypto.randomUUID();
    const msg = [
      `From: ${fromName ? `${encodeHeader(fromName)} <${fromAddr}>` : fromAddr}`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${fromAddr.split('@')[1]}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(text)),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(html)),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    await writer.write(enc.encode(msg + '\r\n.\r\n'));
    await cmd(null, [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally {
    try { await socket.close(); } catch {}
  }
  return true;
}
