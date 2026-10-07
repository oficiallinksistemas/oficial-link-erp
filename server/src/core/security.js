'use strict';

/**
 * Segurança de credenciais e tokens usando apenas o módulo nativo `crypto`.
 *
 * - Senhas: scrypt (memory-hard) com sal aleatório de 16 bytes.
 *   Formato armazenado: scrypt$<N>$<salt_hex>$<hash_hex>
 * - Sessões: token opaco aleatório; no banco guardamos apenas o SHA-256 do token,
 *   então um vazamento do banco não expõe sessões ativas.
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, n, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: parseInt(n, 10),
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { hashPassword, verifyPassword, randomToken, sha256 };
