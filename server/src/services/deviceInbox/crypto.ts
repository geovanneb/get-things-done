import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The sealing shared with a paired phone: X25519, HKDF-SHA256 and AES-256-GCM, chosen because the iPhone has all
 * three in its system library. Changing anything here breaks every paired phone: the fixed vectors in the tests and
 * in Meetlaud's tests must keep matching.
 */
const SALT = Buffer.from('meetlaud-sync-v1');
const INFO = Buffer.from('device-inbox-key');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

export interface Identity { publicKey: Buffer; privateKey: Buffer }

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_X25519.length),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_X25519.length),
  };
}

/** Both sides arrive at the same key, and nothing that crosses the network reveals it. */
export function sharedKey(privateKey: Buffer, peerPublicKey: Buffer): Buffer {
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, peerPublicKey]), format: 'der', type: 'spki' }),
  });
  return Buffer.from(hkdfSync('sha256', secret, SALT, INFO, 32));
}

/** nonce + ciphertext + tag, the layout of CryptoKit's `SealedBox.combined`. `context` binds a seal to one place. */
export function seal(key: Buffer, plain: Buffer, context: string, nonce = randomBytes(NONCE_BYTES)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Throws on anything altered, or sealed for another place. */
export function open(key: Buffer, sealed: Buffer, context: string): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('Too short to be sealed');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
}

export const deviceId = (publicKey: Buffer) => createHash('sha256').update(publicKey).digest('hex').slice(0, 32);

export const proof = (code: Buffer, ...parts: Buffer[]) => {
  const mac = createHmac('sha256', code);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

export const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
