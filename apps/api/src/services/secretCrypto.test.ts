import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Since secretCrypto caches the encryption key at first use, we test with
// the vitest module reset facility. However for simplicity, we test the
// public API with the default test environment key.

describe('secretCrypto', () => {
  // In test environment (NODE_ENV=test), the module falls back to
  // 'test-only-secret-encryption-key' so we can test encrypt/decrypt.

  it('encrypts and decrypts a value', async () => {
    const { encryptSecret, decryptSecret, isEncryptedSecret } = await import('./secretCrypto');

    const original = 'my-secret-value';
    const encrypted = encryptSecret(original);

    expect(encrypted).not.toBeNull();
    expect(isEncryptedSecret(encrypted!)).toBe(true);
    expect(encrypted!.startsWith('enc:v1:')).toBe(true);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it('returns null for null/undefined input', async () => {
    const { encryptSecret, decryptSecret } = await import('./secretCrypto');

    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
  });

  it('does not double-encrypt already encrypted values', async () => {
    const { encryptSecret } = await import('./secretCrypto');

    const encrypted = encryptSecret('hello');
    const doubleEncrypted = encryptSecret(encrypted);
    expect(doubleEncrypted).toBe(encrypted);
  });

  it('passes through unencrypted values in decryptSecret', async () => {
    const { decryptSecret } = await import('./secretCrypto');

    expect(decryptSecret('plain-text-value')).toBe('plain-text-value');
  });

  it('detects encrypted prefix correctly', async () => {
    const { isEncryptedSecret } = await import('./secretCrypto');

    expect(isEncryptedSecret('enc:v1:something')).toBe(true);
    expect(isEncryptedSecret('plain-text')).toBe(false);
    expect(isEncryptedSecret('')).toBe(false);
  });

  it('throws on malformed encrypted data', async () => {
    const { decryptSecret } = await import('./secretCrypto');

    expect(() => decryptSecret('enc:v1:bad-data')).toThrow('Malformed encrypted secret');
  });

  it('produces unique ciphertext for the same input', async () => {
    const { encryptSecret } = await import('./secretCrypto');

    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b); // Random IV ensures unique ciphertext
  });
});
