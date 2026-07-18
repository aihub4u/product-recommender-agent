const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('./globalConfig');

let pool = null;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set. The platform needs a Postgres database — see README.');
    }
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  await getPool().query(sql);
  console.log('[db] migrations applied');
}

module.exports = { query, runMigrations, getPool };
