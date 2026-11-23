// Usage: node scripts/hash-password.mjs 'your password'
// Prints a PBKDF2 hash to store as the ADMIN_PASSWORD_HASH secret.
import { webcrypto as crypto } from 'node:crypto';

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node scripts/hash-password.mjs 'password'");
  process.exit(1);
}
const iterations = 100000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
const b64 = (b) => Buffer.from(b).toString('base64url');
console.log(`pbkdf2$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
