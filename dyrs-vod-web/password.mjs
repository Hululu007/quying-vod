// 密码哈希与校验：格式固定为 scrypt$salt$hash，保证 Node 与 Workers 之间可互通。
// Node 内置 scrypt 最快；Cloudflare Workers 的 node:crypto 未实现 scryptSync，
// 回退到纯 JS 的 @noble/hashes 实现（参数与 Node 默认值一致：N=16384, r=8, p=1）。
import crypto from 'node:crypto';
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, dkLen: SCRYPT_KEYLEN };

function scryptHex(password, salt) {
  try {
    return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  } catch {
    return Buffer.from(nobleScrypt(String(password), String(salt), SCRYPT_OPTS)).toString('hex');
  }
}

// 定长比较，避免依赖 Workers 不一定实现的 timingSafeEqual。
function equalHex(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptHex(password, salt)}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  return equalHex(scryptHex(password, salt), hash);
}
