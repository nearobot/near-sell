import type { AccessKey, RpcPort, VaultData, VaultEnvelope } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as near from 'near-api-js';
import seedUtils from 'near-seed-phrase';
import bip39 from 'bip39-light';
import { AppError, assert, accountId } from './core.ts';

const derive = (password: string, salt: Buffer) => crypto.scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
export function atomicWrite(filename: string, data: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filename);
}
export function seal(data: unknown, password: string): VaultEnvelope {
  assert(typeof password === 'string' && password.length >= 12, 'Use a vault passphrase of at least 12 characters.');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = derive(password, salt);
  try {
    const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('near-sell-bot:v1'));
    const cipher = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
    return { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), cipher: cipher.toString('base64') };
  } finally { key.fill(0); }
}
export function unseal<T = unknown>(envelope: VaultEnvelope, password: string): T {
  let key: Buffer | undefined;
  try {
    if (envelope.version !== 1) throw new Error();
    const salt = Buffer.from(envelope.salt, 'base64'), iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error();
    key = derive(password, salt);
    const c = crypto.createDecipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('near-sell-bot:v1')); c.setAuthTag(tag);
    return JSON.parse(Buffer.concat([c.update(Buffer.from(envelope.cipher, 'base64')), c.final()]).toString('utf8')) as T;
  } catch { throw new AppError('Vault is locked: wrong passphrase or damaged vault.'); }
  finally { key?.fill(0); }
}
export function loadVault(file: string, password: string): VaultData { return unseal<VaultData>(JSON.parse(fs.readFileSync(file, 'utf8')), password); }
export function saveVault(file: string, data: VaultData, password: string) { atomicWrite(file, JSON.stringify(seal(data, password), null, 2)); }
export function deriveWallet(secret: string, hd = "m/44'/397'/0'") {
  assert(/^m(?:\/\d+')+$/.test(hd), 'Use an ed25519 hardened derivation path.');
  try {
    const input = secret.trim();
    let key: near.KeyPair;
    if (input.startsWith('ed25519:')) key = near.KeyPair.fromString(input as `ed25519:${string}`);
    else {
      const phrase = input.toLowerCase().replace(/\s+/g, ' ');
      if (!bip39.validateMnemonic(phrase)) throw new Error();
      key = near.KeyPair.fromString(seedUtils.parseSeedPhrase(phrase, hd).secretKey as `ed25519:${string}`);
    }
    assert(key.getPublicKey().toString().startsWith('ed25519:'), 'Only NEAR ed25519 keys are supported.');
    return key;
  } catch { throw new AppError('Invalid NEAR seed phrase or ed25519 private key.'); }
}
export async function verifyKey(rpc: Pick<RpcPort, 'query'>, account: string, key: near.KeyPair) {
  accountId(account);
  const access = await rpc.query<AccessKey>({ request_type: 'view_access_key', account_id: account, public_key: key.getPublicKey().toString() });
  assert(access.permission === 'FullAccess', 'This key is not a full-access key for that NEAR account.');
  return key.getPublicKey().toString();
}
