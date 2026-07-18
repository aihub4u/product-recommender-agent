const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('./globalConfig');

const COOKIE_NAME = 'platform_admin';
const TOKEN_TTL = '7d';

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(password) {
  if (!config.adminPassword) {
    throw new Error('ADMIN_PASSWORD is not set on the server.');
  }
  return typeof password === 'string' && timingSafeEqual(password, config.adminPassword);
}

function issueToken() {
  if (!config.adminJwtSecret) {
    throw new Error('ADMIN_JWT_SECRET is not set on the server.');
  }
  return jwt.sign({ role: 'admin' }, config.adminJwtSecret, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    jwt.verify(token, config.adminJwtSecret);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again.' });
  }
}

module.exports = { checkPassword, issueToken, setAuthCookie, clearAuthCookie, requireAdmin, COOKIE_NAME };
