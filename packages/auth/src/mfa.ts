import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '@repo/crypto';

// Second factor: TOTP (RFC 6238) with recovery codes.
//
// Implemented here rather than pulled in because it is an HMAC and a modulo, and
// the interesting parts are the policy choices around it:
//
//   - The shared secret is encrypted at rest with the instance key (@repo/crypto),
//     so a database dump does not hand over everyone's second factor.
//   - Verification accepts the neighbouring 30-second steps, which covers a phone
//     whose clock has drifted, and nothing wider.
//   - Codes are compared in constant time, and a used recovery code is consumed.
//   - Recovery codes are stored as SHA-256 digests. They are high-entropy random
//     values, so a fast hash is the right one — the same reasoning as session
//     tokens, and the opposite of passwords.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
// How many steps either side of "now" are accepted.
const TOTP_WINDOW = 1;

export const RECOVERY_CODE_COUNT = 10;

export function generateTotpSecret(bytes = 20): string {
  return encodeBase32(randomBytes(bytes));
}

// The `otpauth://` URI an authenticator app scans.
export function totpProvisioningUri(input: {
  issuer: string;
  accountName: string;
  secret: string;
}): string {
  const label = `${input.issuer}:${input.accountName}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_MS / 1000),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

// The code an authenticator would show at `now`. Exported because a caller that
// wants to prove a setup works (tests, a dev seed) should not have to reimplement
// the algorithm to do it.
export function totpCode(secret: string, now = Date.now()): string {
  return totpAtCounter(secret, Math.floor(now / TOTP_STEP_MS));
}

export function verifyTotpCode(secret: string, code: string, now = Date.now()): boolean {
  const normalized = normalizeCode(code);
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(now / TOTP_STEP_MS);
  let matched = false;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    // No early return: the loop always runs the same number of times so a match at
    // the first offset is not faster than a match at the last.
    if (constantTimeEqual(normalized, totpAtCounter(secret, counter + offset))) matched = true;
  }
  return matched;
}

// Digits and letters only, upper-cased: people type codes with spaces and dashes.
export function normalizeCode(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

// Returns the remaining hashes with the used one removed, or null when the code
// does not match any of them. Every candidate is compared so a hit early in the
// list is not measurably faster.
export function consumeRecoveryCode(hashes: readonly string[], code: string): string[] | null {
  const candidate = hashRecoveryCode(code);
  let index = -1;
  hashes.forEach((hash, at) => {
    if (constantTimeEqual(hash, candidate)) index = at;
  });
  if (index === -1) return null;
  return hashes.filter((_, at) => at !== index);
}

// The secret as it is stored: AES-256-GCM with the instance key, plus a
// fingerprint of that key so a value encrypted under a rotated key is reported as
// undecryptable rather than as a wrong code.
export interface StoredTotpSecret extends EncryptedSecret {
  keyFingerprint: string;
}

export function encryptTotpSecret(secret: string): StoredTotpSecret {
  return { ...encryptSecret(secret), keyFingerprint: instanceKeyFingerprint() };
}

export function decryptTotpSecret(stored: StoredTotpSecret): string {
  if (stored.keyFingerprint !== instanceKeyFingerprint()) {
    throw new Error('MFA secret was encrypted with a different APP_ENCRYPTION_KEY');
  }
  return decryptSecret(stored);
}

// Identifies the key without revealing it, so rotation is detectable.
function instanceKeyFingerprint(): string {
  const raw = process.env.APP_ENCRYPTION_KEY ?? '';
  return createHash('sha256').update(`fingerprint:${raw}`).digest('hex').slice(0, 16);
}

function totpAtCounter(secret: string, counter: number): string {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.max(0, counter)));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
