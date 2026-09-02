const { v4: uuidv4 } = require('uuid');
const config = require('./globalConfig');

const MAX_CONTEXT_KEYS = 20;
const MAX_CONTEXT_VALUE_CHARS = 200;

// sessionId -> { projectSlug, history: [{role, content}], filters: {}, sessionContext: {}, createdAt, lastActive }
const sessions = new Map();

function createSession(projectSlug) {
  const id = uuidv4();
  const session = { projectSlug, history: [], filters: {}, sessionContext: {}, createdAt: Date.now(), lastActive: Date.now() };
  sessions.set(id, session);
  return { id, session };
}

// A session can only be reused if it belongs to the same project — prevents
// a sessionId leaking context across two different projects' agents.
function getSession(id, projectSlug) {
  const session = sessions.get(id);
  if (!session || session.projectSlug !== projectSlug) return null;
  session.lastActive = Date.now();
  return session;
}

function getOrCreate(id, projectSlug) {
  if (id) {
    const existing = getSession(id, projectSlug);
    if (existing) return { id, session: existing };
  }
  return createSession(projectSlug);
}

/**
 * Merges caller-supplied context (e.g. { customerPhone: "9958880486" })
 * into a session, persisting across turns even if a later call omits it.
 * Only flat string/number/boolean values are accepted — this is meant for
 * small identifiers to feed tool calls, not arbitrary payloads. Silently
 * drops keys/values that don't fit the limits rather than erroring the
 * whole request over a caller mistake in one field.
 */
function mergeContext(session, newContext) {
  if (!newContext || typeof newContext !== 'object' || Array.isArray(newContext)) return;
  const existingKeys = Object.keys(session.sessionContext).length;
  let added = 0;
  for (const [key, value] of Object.entries(newContext)) {
    if (existingKeys + added >= MAX_CONTEXT_KEYS && !(key in session.sessionContext)) continue;
    if (value === null || value === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const strValue = String(value).slice(0, MAX_CONTEXT_VALUE_CHARS);
    if (!(key in session.sessionContext)) added += 1;
    session.sessionContext[key] = strValue;
  }
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > config.defaultSessionTtlMs) {
      sessions.delete(id);
    }
  }
}

function startSweeper() {
  setInterval(sweepExpired, Math.min(config.defaultSessionTtlMs, 60000));
}

module.exports = { createSession, getSession, getOrCreate, mergeContext, startSweeper };
