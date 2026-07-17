const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// sessionId -> { history: [{role, content}], filters: {}, createdAt, lastActive }
const sessions = new Map();

function createSession() {
  const id = uuidv4();
  const session = { history: [], filters: {}, createdAt: Date.now(), lastActive: Date.now() };
  sessions.set(id, session);
  return { id, session };
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  session.lastActive = Date.now();
  return session;
}

function getOrCreate(id) {
  if (id) {
    const existing = getSession(id);
    if (existing) return { id, session: existing };
  }
  return createSession();
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > config.sessionTtlMs) {
      sessions.delete(id);
    }
  }
}

function startSweeper() {
  setInterval(sweepExpired, Math.min(config.sessionTtlMs, 60000));
}

module.exports = { createSession, getSession, getOrCreate, startSweeper };
