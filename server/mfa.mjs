import { createCipheriv, createDecipheriv, createHmac, randomBytes, createHash } from 'node:crypto';
import config from './config.mjs';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (bytes) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
};

function decodeBase32(value) {
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid authenticator secret');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

const encryptionKey = () => createHash('sha256').update(config.cookieSecret).digest();

export function createTotpSecret() {
  return base32(randomBytes(20));
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => randomBytes(8).toString('hex').toUpperCase());
}

export function hashRecoveryCode(code) {
  return createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
}

export function encryptSensitiveValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSensitiveValue(value) {
  const [ivText, tagText, encryptedText] = String(value || '').split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptTotpSecret(secret) { return encryptSensitiveValue(secret); }
export function decryptTotpSecret(value) {
  try { return decryptSensitiveValue(value); }
  catch { throw new Error('Invalid encrypted authenticator secret'); }
}

export function totpCode(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, candidate, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(String(candidate || ''))) return false;
  return [-30_000, 0, 30_000].some((delta) => totpCode(secret, timestamp + delta) === candidate);
}

export function totpProvisioningUri(email, secret, issuer = 'IwacuMall') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query.toString()}`;
}
