const db = require('./db');
const cryptoHelper = require('./crypto');
const googleSheets = require('./googleSheets');
const globalConfig = require('./globalConfig');

// slug -> { id, name, slug, sheetConfig, llmConfig, guardrails, products, vocabulary,
//           lastRefreshed, lastRefreshError, nextRefreshAt }
const cache = new Map();

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
}

const RESERVED_SLUGS = new Set(['admin', 'api', 'chat', 'health']);

async function uniqueSlug(base) {
  let slug = RESERVED_SLUGS.has(base) ? `${base}-project` : base;
  let n = 2;
  while (true) {
    const { rows } = await db.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${n}`;
    n += 1;
  }
}

function buildVocabulary(products) {
  const tags = new Set();
  const categories = new Set();
  for (const p of products) {
    (p.tagList || []).forEach((t) => tags.add(t));
    if (p.category) categories.add(String(p.category).trim().toLowerCase());
  }
  return { tags, categories };
}

function rowToSheetConfig(row) {
  if (!row) return { sheetId: '', range: 'Sheet1', catalogRefreshMs: globalConfig.defaultCatalogRefreshMs, hasCustomServiceAccount: false };
  return {
    sheetId: row.google_sheet_id || '',
    range: row.google_sheet_range || 'Sheet1',
    catalogRefreshMs: row.catalog_refresh_ms || globalConfig.defaultCatalogRefreshMs,
    serviceAccountJsonEnc: row.service_account_json_enc || null,
    hasCustomServiceAccount: Boolean(row.service_account_json_enc),
  };
}

function rowToLlmConfig(row) {
  if (!row) return { provider: 'none', apiKeyEnc: null, model: '' };
  return {
    provider: row.provider || 'none',
    apiKeyEnc: row.api_key_enc || null,
    model: row.model || '',
  };
}

function rowToGuardrails(row) {
  if (!row) {
    return {
      systemInstructions: '',
      blockedTerms: [],
      minPrice: null,
      maxPrice: null,
      maxRecommendations: globalConfig.defaultMaxRecommendations,
      offTopicMessage: 'Sorry, I can only help with product recommendations for this store.',
    };
  }
  return {
    systemInstructions: row.system_instructions || '',
    blockedTerms: row.blocked_terms || [],
    minPrice: row.min_price !== null ? Number(row.min_price) : null,
    maxPrice: row.max_price !== null ? Number(row.max_price) : null,
    maxRecommendations: row.max_recommendations || globalConfig.defaultMaxRecommendations,
    offTopicMessage: row.off_topic_message || 'Sorry, I can only help with product recommendations for this store.',
  };
}

async function loadProjectIntoCache(projectRow) {
  const [sheetRes, llmRes, guardrailsRes] = await Promise.all([
    db.query('SELECT * FROM project_sheet_config WHERE project_id = $1', [projectRow.id]),
    db.query('SELECT * FROM project_llm_config WHERE project_id = $1', [projectRow.id]),
    db.query('SELECT * FROM project_guardrails WHERE project_id = $1', [projectRow.id]),
  ]);

  const entry = {
    id: projectRow.id,
    name: projectRow.name,
    slug: projectRow.slug,
    agentType: projectRow.agent_type || 'custom',
    hasDataSource: projectRow.has_data_source !== false,
    sheetConfig: rowToSheetConfig(sheetRes.rows[0]),
    llmConfig: rowToLlmConfig(llmRes.rows[0]),
    guardrails: rowToGuardrails(guardrailsRes.rows[0]),
    products: [],
    vocabulary: { tags: new Set(), categories: new Set() },
    lastRefreshed: null,
    lastRefreshError: null,
    nextRefreshAt: 0,
  };
  cache.set(projectRow.slug, entry);
  return entry;
}

async function loadAllProjects() {
  const { rows } = await db.query('SELECT * FROM projects ORDER BY created_at ASC');
  for (const row of rows) {
    await loadProjectIntoCache(row);
  }
  console.log(`[projectRegistry] loaded ${rows.length} project(s)`);
}

function getProject(slug) {
  return cache.get(slug) || null;
}

function listProjects() {
  return Array.from(cache.values()).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    agentType: p.agentType,
    hasDataSource: p.hasDataSource,
    productsLoaded: p.products.length,
    engine: p.llmConfig.provider !== 'none' && p.llmConfig.apiKeyEnc ? p.llmConfig.provider : 'rule',
    lastRefreshed: p.lastRefreshed,
    lastRefreshError: p.lastRefreshError,
    sheetConfigured: Boolean(p.sheetConfig.sheetId),
  }));
}

async function createProject(name, { agentType = 'custom', hasDataSource = true } = {}) {
  const slug = await uniqueSlug(slugify(name));
  const { rows } = await db.query(
    'INSERT INTO projects (name, slug, agent_type, has_data_source) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, slug, agentType, hasDataSource]
  );
  const project = rows[0];
  await db.query('INSERT INTO project_sheet_config (project_id) VALUES ($1)', [project.id]);
  await db.query('INSERT INTO project_llm_config (project_id) VALUES ($1)', [project.id]);
  await db.query('INSERT INTO project_guardrails (project_id) VALUES ($1)', [project.id]);
  return loadProjectIntoCache(project);
}

async function deleteProject(slug) {
  const entry = getProject(slug);
  if (!entry) return false;
  await db.query('DELETE FROM projects WHERE id = $1', [entry.id]);
  cache.delete(slug);
  return true;
}

async function updateSheetConfig(slug, { sheetId, range, catalogRefreshMs, serviceAccountJson, clearServiceAccount }) {
  const entry = getProject(slug);
  if (!entry) throw new Error('Project not found');
  if (!entry.hasDataSource) throw new Error('This project is not configured to use a data source.');

  const fields = [];
  const values = [];
  let i = 1;

  if (sheetId !== undefined) { fields.push(`google_sheet_id = $${i++}`); values.push(sheetId); }
  if (range !== undefined) { fields.push(`google_sheet_range = $${i++}`); values.push(range); }
  if (catalogRefreshMs !== undefined) { fields.push(`catalog_refresh_ms = $${i++}`); values.push(catalogRefreshMs); }
  if (clearServiceAccount) {
    fields.push(`service_account_json_enc = NULL`);
  } else if (serviceAccountJson) {
    // Validate it's parseable JSON before encrypting/storing.
    JSON.parse(serviceAccountJson);
    fields.push(`service_account_json_enc = $${i++}`);
    values.push(cryptoHelper.encrypt(serviceAccountJson));
  }
  fields.push(`updated_at = now()`);

  values.push(entry.id);
  await db.query(`UPDATE project_sheet_config SET ${fields.join(', ')} WHERE project_id = $${i}`, values);

  const { rows } = await db.query('SELECT * FROM project_sheet_config WHERE project_id = $1', [entry.id]);
  entry.sheetConfig = rowToSheetConfig(rows[0]);
  entry.nextRefreshAt = 0; // force refresh on next tick
  return entry.sheetConfig;
}

async function updateLlmConfig(slug, { provider, apiKey, model, clearApiKey }) {
  const entry = getProject(slug);
  if (!entry) throw new Error('Project not found');

  const fields = [];
  const values = [];
  let i = 1;

  if (provider !== undefined) { fields.push(`provider = $${i++}`); values.push(provider); }
  if (model !== undefined) { fields.push(`model = $${i++}`); values.push(model); }
  if (clearApiKey) {
    fields.push(`api_key_enc = NULL`);
  } else if (apiKey) {
    fields.push(`api_key_enc = $${i++}`);
    values.push(cryptoHelper.encrypt(apiKey));
  }
  fields.push(`updated_at = now()`);

  values.push(entry.id);
  await db.query(`UPDATE project_llm_config SET ${fields.join(', ')} WHERE project_id = $${i}`, values);

  const { rows } = await db.query('SELECT * FROM project_llm_config WHERE project_id = $1', [entry.id]);
  entry.llmConfig = rowToLlmConfig(rows[0]);
  return entry.llmConfig;
}

async function updateGuardrails(slug, { systemInstructions, blockedTerms, minPrice, maxPrice, maxRecommendations, offTopicMessage }) {
  const entry = getProject(slug);
  if (!entry) throw new Error('Project not found');

  await db.query(
    `UPDATE project_guardrails SET
       system_instructions = $1,
       blocked_terms = $2,
       min_price = $3,
       max_price = $4,
       max_recommendations = $5,
       off_topic_message = $6,
       updated_at = now()
     WHERE project_id = $7`,
    [
      systemInstructions || '',
      blockedTerms || [],
      minPrice === '' || minPrice === undefined ? null : minPrice,
      maxPrice === '' || maxPrice === undefined ? null : maxPrice,
      maxRecommendations || globalConfig.defaultMaxRecommendations,
      offTopicMessage || 'Sorry, I can only help with product recommendations for this store.',
      entry.id,
    ]
  );

  const { rows } = await db.query('SELECT * FROM project_guardrails WHERE project_id = $1', [entry.id]);
  entry.guardrails = rowToGuardrails(rows[0]);
  return entry.guardrails;
}

async function refreshCatalog(slug) {
  const entry = getProject(slug);
  if (!entry) throw new Error('Project not found');
  if (!entry.hasDataSource) throw new Error('This project is not configured to use a data source.');
  if (!entry.sheetConfig.sheetId) {
    entry.lastRefreshError = 'No Google Sheet ID configured yet.';
    return entry;
  }

  try {
    let credentialsJson = null;
    if (entry.sheetConfig.serviceAccountJsonEnc) {
      const decrypted = cryptoHelper.decrypt(entry.sheetConfig.serviceAccountJsonEnc);
      credentialsJson = JSON.parse(decrypted);
    }
    const products = await googleSheets.fetchProducts({
      sheetId: entry.sheetConfig.sheetId,
      range: entry.sheetConfig.range,
      keyFile: credentialsJson ? undefined : globalConfig.defaultGoogleServiceAccountKeyPath,
      credentialsJson,
    });
    entry.products = products;
    entry.vocabulary = buildVocabulary(products);
    entry.lastRefreshed = new Date();
    entry.lastRefreshError = null;
    console.log(`[projectRegistry] refreshed ${products.length} products for '${slug}'`);
  } catch (err) {
    entry.lastRefreshError = err.message;
    console.error(`[projectRegistry] refresh failed for '${slug}':`, err.message);
  }
  entry.nextRefreshAt = Date.now() + (entry.sheetConfig.catalogRefreshMs || globalConfig.defaultCatalogRefreshMs);
  return entry;
}

function startAutoRefresh() {
  // Tick every 30s; each project decides for itself whether it's due,
  // based on its own catalog_refresh_ms.
  setInterval(async () => {
    const now = Date.now();
    for (const entry of cache.values()) {
      if (entry.sheetConfig.sheetId && now >= entry.nextRefreshAt) {
        await refreshCatalog(entry.slug);
      }
    }
  }, 30000);

  // Kick off an initial refresh for every project with a sheet configured.
  for (const entry of cache.values()) {
    if (entry.sheetConfig.sheetId) refreshCatalog(entry.slug);
  }
}

function getDecryptedApiKey(entry) {
  if (!entry.llmConfig.apiKeyEnc) return null;
  return cryptoHelper.decrypt(entry.llmConfig.apiKeyEnc);
}

module.exports = {
  loadAllProjects,
  listProjects,
  getProject,
  createProject,
  deleteProject,
  updateSheetConfig,
  updateLlmConfig,
  updateGuardrails,
  refreshCatalog,
  startAutoRefresh,
  getDecryptedApiKey,
};
