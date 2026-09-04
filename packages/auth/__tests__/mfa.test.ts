import { describe, expect, it } from 'bun:test';
import {
  consumeRecoveryCode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeCode,
  totpCode,
  totpProvisioningUri,
  verifyTotpCode,
} from '../src/mfa';

process.env.APP_ENCRYPTION_KEY ??= 'test-encryption-key-for-mfa-unit-tests';

// A known RFC 6238 style vector: secret "GEZDGNBVGY3TQOJQ" is the base32 of
// "12345678901234567890", the reference key from the spec.
const SPEC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('generateTotpSecret', () => {
  it('produces distinct base32 secrets', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('verifyTotpCode', () => {
  it('accepts the code for the current step', () => {
    const now = 1_700_000_000_000;
    const code = currentCode(SPEC_SECRET, now);
    expect(verifyTotpCode(SPEC_SECRET, code, now)).toBe(true);
  });

  it('accepts one step of clock drift either way, and no more', () => {
    const now = 1_700_000_000_000;
    const code = currentCode(SPEC_SECRET, now);
    expect(verifyTotpCode(SPEC_SECRET, code, now + 30_000)).toBe(true);
    expect(verifyTotpCode(SPEC_SECRET, code, now - 30_000)).toBe(true);
    expect(verifyTotpCode(SPEC_SECRET, code, now + 120_000)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotpCode(SPEC_SECRET, '', now)).toBe(false);
    expect(verifyTotpCode(SPEC_SECRET, 'abcdef', now)).toBe(false);
    expect(verifyTotpCode(SPEC_SECRET, '1234567', now)).toBe(false);
  });

  it('tolerates the spaces and dashes people actually type', () => {
    const now = 1_700_000_000_000;
    const code = currentCode(SPEC_SECRET, now);
    expect(verifyTotpCode(SPEC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it('rejects a code minted for a different secret', () => {
    const now = 1_700_000_000_000;
    const other = generateTotpSecret();
    expect(verifyTotpCode(other, currentCode(SPEC_SECRET, now), now)).toBe(false);
  });
});

describe('totpProvisioningUri', () => {
  it('builds a scannable otpauth URI', () => {
    const uri = totpProvisioningUri({
      issuer: "It's a Plan",
      accountName: 'demo@itsaplan.dev',
      secret: SPEC_SECRET,
    });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${SPEC_SECRET}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('generates ten distinct, readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });

  it('consumes a code once and leaves the rest', () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    const remaining = consumeRecoveryCode(hashes, codes[1]!);
    expect(remaining).toHaveLength(2);
    expect(consumeRecoveryCode(remaining!, codes[1]!)).toBeNull();
    expect(consumeRecoveryCode(remaining!, codes[0]!)).toHaveLength(1);
  });

  it('matches however the code was typed', () => {
    const [code] = generateRecoveryCodes(1);
    const hashes = [hashRecoveryCode(code!)];
    expect(consumeRecoveryCode(hashes, code!.toLowerCase().replace('-', ' '))).toEqual([]);
  });

  it('returns null for an unknown code', () => {
    expect(consumeRecoveryCode([hashRecoveryCode('AAAAA-BBBBB')], 'CCCCC-DDDDD')).toBeNull();
  });
});

describe('secret storage', () => {
  it('round-trips through encryption', () => {
    const secret = generateTotpSecret();
    const stored = encryptTotpSecret(secret);
    expect(stored.ciphertext).not.toContain(secret);
    expect(decryptTotpSecret(stored)).toBe(secret);
  });

  it('refuses a secret encrypted under a different key', () => {
    const stored = encryptTotpSecret(generateTotpSecret());
    expect(() => decryptTotpSecret({ ...stored, keyFingerprint: 'deadbeefdeadbeef' })).toThrow(
      /different APP_ENCRYPTION_KEY/,
    );
  });
});

describe('normalizeCode', () => {
  it('strips separators and upper-cases', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('abcde-fghij')).toBe('ABCDEFGHIJ');
  });
});

// The code an authenticator app would be showing at that instant.
function currentCode(secret: string, now: number): string {
  return totpCode(secret, now);
}
