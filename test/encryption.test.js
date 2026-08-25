'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// We need to set LLM_ENCRYPTION_KEY before loading the module.
// Use a fresh throwaway key per test run.
const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');
let origKey;

before(() => {
  origKey = process.env.LLM_ENCRYPTION_KEY;
  process.env.LLM_ENCRYPTION_KEY = TEST_KEY_HEX;
});

after(() => {
  if (origKey === undefined) {
    delete process.env.LLM_ENCRYPTION_KEY;
  } else {
    process.env.LLM_ENCRYPTION_KEY = origKey;
  }
});

// Require the module under test — it reads getKey() lazily, so our env
// var will be present.
const { encrypt, decrypt } = require('../lib/encryption');

describe('encryption round-trip', () => {
  test('encrypt then decrypt returns the original plaintext', () => {
    const plain = 'sk-test-secret-key-12345';
    const enc = encrypt(plain);
    assert.ok(enc, 'encrypt should return a truthy value');
    assert.strictEqual(typeof enc, 'string');
    const dec = decrypt(enc);
    assert.strictEqual(dec, plain);
  });

  test('two encryptions of the same plaintext differ (random IV)', () => {
    const plain = 'same-input';
    const enc1 = encrypt(plain);
    const enc2 = encrypt(plain);
    // Both decrypt to the same value
    assert.strictEqual(decrypt(enc1), plain);
    assert.strictEqual(decrypt(enc2), plain);
    // But the ciphertexts are different
    assert.notStrictEqual(enc1, enc2);
  });
});

describe('decryption edge cases', () => {
  test('decrypt of tampered ciphertext throws', () => {
    const enc = encrypt('original');
    // Flip a bit in the ciphertext
    const tampered = enc.slice(0, -2) + 'XX';
    assert.throws(() => decrypt(tampered));
  });

  test('decrypt(null) returns null', () => {
    assert.strictEqual(decrypt(null), null);
  });

  test('decrypt(undefined) returns null', () => {
    assert.strictEqual(decrypt(undefined), null);
  });

  test('decrypt("") returns null', () => {
    assert.strictEqual(decrypt(''), null);
  });
});

describe('key formats', () => {
  test('hex key (64 hex chars) is accepted', () => {
    process.env.LLM_ENCRYPTION_KEY = TEST_KEY_HEX;
    const enc = encrypt('hex-key-test');
    assert.strictEqual(decrypt(enc), 'hex-key-test');
  });

  test('base64 key is accepted', () => {
    const b64Key = Buffer.from(TEST_KEY_HEX, 'hex').toString('base64');
    process.env.LLM_ENCRYPTION_KEY = b64Key;
    const enc = encrypt('b64-key-test');
    assert.strictEqual(decrypt(enc), 'b64-key-test');
  });
});

describe('missing key', () => {
  test('getKey throws when LLM_ENCRYPTION_KEY is not set', () => {
    delete process.env.LLM_ENCRYPTION_KEY;
    // Re-require to pick up the missing key.  Since the module is cached,
    // we test getKey directly via encrypt/decrypt which call it internally.
    assert.throws(() => encrypt('test'), /LLM_ENCRYPTION_KEY environment variable is required/);
  });

  test('restores key for subsequent tests', () => {
    process.env.LLM_ENCRYPTION_KEY = TEST_KEY_HEX;
    // Confirm it works again after restoring
    const enc = encrypt('restored');
    assert.strictEqual(decrypt(enc), 'restored');
  });
});
