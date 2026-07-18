const crypto = require('crypto');
const config = require('./globalConfig');

function getKey() {
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is not set. Generate one and add it as an env var — see README.');
  }
  // Accept either a 64-char hex string or any string (hashed down to 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
    return Buffer.from(config.encryptionKey, 'hex');
  }
  return crypto.createHash('sha256').update(config.encryptionKey).digest();
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as iv:authTag:ciphertext, all base64
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return null;
  const [ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Returns a masked preview safe to show in the dashboard (never the real value).
function maskSecret(plaintextLength) {
  if (!plaintextLength) return null;
  return '•'.repeat(Math.min(20, Math.max(8, plaintextLength))) + ' (saved)';
}

module.exports = { encrypt, decrypt, maskSecret };
