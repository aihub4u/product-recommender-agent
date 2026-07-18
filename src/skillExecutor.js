const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;
const MAX_RESPONSE_CHARS = 4000;

function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 0) return true; // 0.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local / cloud metadata
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.replace('::ffff:', '')); // IPv4-mapped
    return false;
  }
  return true; // unknown/unparseable -> refuse rather than risk it
}

/** Throws if the URL's protocol isn't http/https or its host resolves to a private/internal address. */
async function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error(`Only http/https URLs are allowed (got ${u.protocol})`);
  }
  if (u.hostname === 'localhost' || u.hostname === '0.0.0.0') {
    throw new Error('Refusing to call localhost/internal addresses.');
  }
  let addresses;
  try {
    addresses = await dns.lookup(u.hostname, { all: true });
  } catch (e) {
    throw new Error(`Could not resolve host: ${u.hostname}`);
  }
  for (const a of addresses) {
    if (isPrivateOrReservedIp(a.address)) {
      throw new Error(`Refusing to call a private/internal address (${a.address}) for host ${u.hostname}.`);
    }
  }
}

function interpolate(template, args) {
  let result = template;
  for (const [key, value] of Object.entries(args || {})) {
    result = result.split(`{${key}}`).join(encodeURIComponent(value));
  }
  return result;
}

function interpolateJsonSafe(template, args) {
  let result = template;
  for (const [key, value] of Object.entries(args || {})) {
    const jsonValue = JSON.stringify(String(value)).slice(1, -1); // escape for embedding in a JSON string context
    result = result.split(`{${key}}`).join(jsonValue);
  }
  return result;
}

/**
 * Executes a configured skill (an external HTTP API call) with the given
 * arguments. `authValue` is the already-decrypted secret, if any.
 * Never throws for a bad HTTP response (that's a normal tool result the
 * model should see) — only throws for genuine execution failures (SSRF
 * block, timeout, network error), which the caller should turn into an
 * error result fed back to the model rather than crashing the request.
 */
async function executeSkill(skill, args, authValue) {
  const url = interpolate(skill.url, args);
  await assertPublicUrl(url);

  let headers = { 'Content-Type': 'application/json' };
  try {
    const extra = typeof skill.headers === 'string' ? JSON.parse(skill.headers || '{}') : (skill.headers || {});
    headers = { ...headers, ...extra };
  } catch (e) { /* ignore malformed static headers rather than failing the call */ }

  if (skill.authType === 'bearer' && authValue) {
    headers.Authorization = `Bearer ${authValue}`;
  } else if (skill.authType === 'api_key_header' && authValue && skill.authHeaderName) {
    headers[skill.authHeaderName] = authValue;
  }

  const method = (skill.method || 'GET').toUpperCase();
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    body = skill.bodyTemplate ? interpolateJsonSafe(skill.bodyTemplate, args) : JSON.stringify(args || {});
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      body: text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) + '…(truncated)' : text,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${TIMEOUT_MS}ms`);
    throw new Error(`Request to ${url} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { executeSkill, assertPublicUrl, isPrivateOrReservedIp };
