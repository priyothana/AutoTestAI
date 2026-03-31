/**
 * Fernet-Compatible Encryption
 *
 * Python uses `cryptography.fernet.Fernet` to encrypt Salesforce credentials.
 * This module provides binary-compatible encrypt/decrypt so Node.js can read
 * existing Python-encrypted values from the database.
 *
 * Fernet spec: https://github.com/fernet/spec/blob/master/Spec.md
 *   Version (1 byte) || Timestamp (8 bytes) || IV (16 bytes) || Ciphertext || HMAC-SHA256 (32 bytes)
 *   - Key = signing_key (16 bytes) || encryption_key (16 bytes) = 32 bytes, base64url-encoded
 *   - Encryption: AES-128-CBC with PKCS7 padding
 *   - Authentication: HMAC-SHA256 over Version || Timestamp || IV || Ciphertext
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto'

const FERNET_VERSION = 0x80

/**
 * Decode a Fernet key (base64url) into signing + encryption key halves.
 */
function decodeKey(key: string): { signingKey: Buffer; encryptionKey: Buffer } {
  // Fernet keys use standard base64 (with + / =), NOT base64url
  const raw = Buffer.from(key, 'base64')
  if (raw.length !== 32) {
    throw new Error(`Invalid Fernet key length: expected 32 bytes, got ${raw.length}`)
  }
  return {
    signingKey: raw.subarray(0, 16),
    encryptionKey: raw.subarray(16, 32),
  }
}

/**
 * Encrypt a plaintext string using Fernet (binary-compatible with Python).
 */
export function fernetEncrypt(plaintext: string, key?: string): string {
  const fernetKey = key ?? process.env.SALESFORCE_ENCRYPTION_KEY
  if (!fernetKey) {
    // No key configured — return plaintext (dangerous in prod, safe for dev startup)
    return plaintext
  }
  try {
    const { signingKey, encryptionKey } = decodeKey(fernetKey)

  const iv = randomBytes(16)
  const timestamp = BigInt(Math.floor(Date.now() / 1000))

  // AES-128-CBC with PKCS7 padding (Node.js default for createCipheriv)
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, iv)
  const padded = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])

  // Build the token: version || timestamp || iv || ciphertext
  const versionBuf = Buffer.from([FERNET_VERSION])
  const timestampBuf = Buffer.alloc(8)
  timestampBuf.writeBigUInt64BE(timestamp)

  const payload = Buffer.concat([versionBuf, timestampBuf, iv, padded])

  // HMAC-SHA256 over the payload
  const hmac = createHmac('sha256', signingKey).update(payload).digest()

  // Final token = payload || hmac, base64url-encoded
  const token = Buffer.concat([payload, hmac])
  return token.toString('base64url')
  } catch (err) {
    // If key is invalid format, return plaintext (non-crashing fallback)
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[fernet] encrypt failed (${msg}) — returning plaintext`)
    return plaintext
  }
}

/**
 * Decrypt a Fernet token (binary-compatible with Python).
 * Returns the plaintext string.
 */
export function fernetDecrypt(token: string, key?: string): string {
  const fernetKey = key ?? process.env.SALESFORCE_ENCRYPTION_KEY
  if (!fernetKey) {
    // No key — return token as-is (value was stored unencrypted)
    return token
  }
  try {
    const { signingKey, encryptionKey } = decodeKey(fernetKey)

  // Fernet tokens may be base64url or standard base64
  let raw: Buffer
  try {
    raw = Buffer.from(token, 'base64url')
    if (raw.length < 57) {
      // Try standard base64
      raw = Buffer.from(token, 'base64')
    }
  } catch {
    raw = Buffer.from(token, 'base64')
  }

  // Minimum: 1 (version) + 8 (timestamp) + 16 (iv) + 16 (min ciphertext) + 32 (hmac) = 73
  if (raw.length < 73) {
    throw new Error(`Invalid Fernet token: too short (${raw.length} bytes)`)
  }

  const version = raw[0]
  if (version !== FERNET_VERSION) {
    throw new Error(`Invalid Fernet version: 0x${version?.toString(16)}`)
  }

  const hmacReceived = raw.subarray(raw.length - 32)
  const payload = raw.subarray(0, raw.length - 32)

  // Verify HMAC
  const hmacComputed = createHmac('sha256', signingKey).update(payload).digest()
  if (!hmacReceived.equals(hmacComputed)) {
    throw new Error('Fernet HMAC verification failed — key mismatch or corrupted token')
  }

  // Extract IV and ciphertext
  const iv = payload.subarray(9, 25) // skip version (1) + timestamp (8)
  const ciphertext = payload.subarray(25)

  // Decrypt AES-128-CBC
  const decipher = createDecipheriv('aes-128-cbc', encryptionKey, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return decrypted.toString('utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[fernet] decrypt failed (${msg}) — returning token as-is`)
    return token
  }
}
