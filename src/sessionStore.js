const { v4: uuidv4 } = require('uuid');
const config = require('./globalConfig');

// sessionId -> { projectSlug, history: [{role, content}], filters: {}, createdAt, lastActive }
const sessions = new Map();

function createSession(projectSlug) {
  const id = uuidv4();
  const session = { projectSlug, history: [], filters: {}, createdAt: Date.now(), lastActive: Date.now() };
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

module.exports = { createSession, getSession, getOrCreate, startSweeper };
