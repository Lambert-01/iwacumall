import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export function createPasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algorithm, salt, hex] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !hex || hex.length !== 128) return false;
  const computed = scryptSync(password, salt, 64);
  return timingSafeEqual(computed, Buffer.from(hex, 'hex'));
}
export function issueToken() { return randomBytes(32).toString('base64url'); }
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function cleanText(v, max = 180) {
  return typeof v === 'string' ? v.trim().slice(0,max) : '';
}
export function validEmail(v) { return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
