const db = require('./db');
const cryptoHelper = require('./crypto');
const metaBizClient = require('./metaBizClient');

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'meta-agent';
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (true) {
    const { rows } = await db.query('SELECT 1 FROM meta_biz_agents WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${n}`;
    n += 1;
  }
}

function rowToAgentSummary(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    entityId: row.entity_id,
    onboarded: row.onboarded,
    rolloutEnabled: row.rollout_enabled,
    hasAccessToken: Boolean(row.access_token_enc),
  };
}

function buildAgentContext(row) {
  return {
    apiBase: row.api_base || 'https://api.facebook.com',
    entityId: row.entity_id,
    accessToken: row.access_token_enc ? cryptoHelper.decrypt(row.access_token_enc) : null,
    agentId: row.agent_id,
  };
}

async function listAgents() {
  const { rows } = await db.query('SELECT * FROM meta_biz_agents ORDER BY created_at DESC');
  return rows.map(rowToAgentSummary);
}

async function createAgent({ name, entityId, accessToken }) {
  if (!name || !name.trim()) throw new Error('Agent name is required.');
  if (!entityId || !entityId.trim()) throw new Error('Entity ID (WhatsApp Business Account ID) is required.');
  const slug = await uniqueSlug(slugify(name));
  const { rows } = await db.query(
    `INSERT INTO meta_biz_agents (name, slug, entity_id, access_token_enc) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name.trim(), slug, entityId.trim(), accessToken ? cryptoHelper.encrypt(accessToken) : null]
  );
  await db.query('INSERT INTO meta_biz_agent_business_info (agent_id) VALUES ($1)', [rows[0].id]);
  return rowToAgentSummary(rows[0]);
}

async function getAgentRow(slug) {
  const { rows } = await db.query('SELECT * FROM meta_biz_agents WHERE slug = $1', [slug]);
  if (rows.length === 0) throw new Error('Meta Business Agent not found.');
  return rows[0];
}

async function getAgentDetail(slug) {
  const row = await getAgentRow(slug);
  const [biRes, faqRes, skillRes, connRes] = await Promise.all([
    db.query('SELECT * FROM meta_biz_agent_business_info WHERE agent_id = $1', [row.id]),
    db.query('SELECT * FROM meta_biz_agent_faqs WHERE agent_id = $1 ORDER BY created_at ASC', [row.id]),
    db.query('SELECT * FROM meta_biz_agent_skills WHERE agent_id = $1 ORDER BY created_at ASC', [row.id]),
    db.query('SELECT * FROM meta_biz_agent_connectors WHERE agent_id = $1 ORDER BY created_at ASC', [row.id]),
  ]);

  const connectors = [];
  for (const c of connRes.rows) {
    const { rows: toolRows } = await db.query('SELECT * FROM meta_biz_agent_tools WHERE connector_id = $1 ORDER BY created_at ASC', [c.id]);
    connectors.push({
      id: c.id, name: c.name, description: c.description, baseUrl: c.base_url,
      authType: c.auth_type, authHeaderName: c.auth_header_name, hasAuthValue: Boolean(c.auth_value_enc),
      remoteConnectorId: c.remote_connector_id, synced: c.synced,
      tools: toolRows.map((t) => ({
        id: t.id, name: t.name, description: t.description,
        requestDefinition: JSON.parse(t.request_definition_json || '{}'),
        remoteToolId: t.remote_tool_id, synced: t.synced,
      })),
    });
  }

  return {
    id: row.id, name: row.name, slug: row.slug, entityId: row.entity_id, apiBase: row.api_base,
    hasAccessToken: Boolean(row.access_token_enc), agentId: row.agent_id, onboarded: row.onboarded,
    settings: {
      rolloutEnabled: row.rollout_enabled, handoffEnabled: row.handoff_enabled, handoffMessage: row.handoff_message,
      followupEnabled: row.followup_enabled, followupMessage: row.followup_message, aiAudience: row.ai_audience,
    },
    businessInfo: biRes.rows[0] ? {
      businessDescription: biRes.rows[0].business_description, paymentMethod: biRes.rows[0].payment_method,
      returnPolicy: biRes.rows[0].return_policy, purchaseInfo: biRes.rows[0].purchase_info,
      deliveryAndShipping: biRes.rows[0].delivery_and_shipping, contactEmail: biRes.rows[0].contact_email,
      contactHours: biRes.rows[0].contact_hours, contactAddress: biRes.rows[0].contact_address,
      synced: biRes.rows[0].synced,
    } : null,
    faqs: faqRes.rows.map((f) => ({ id: f.id, question: f.question, answer: f.answer, synced: f.synced })),
    skills: skillRes.rows.map((s) => ({ id: s.id, title: s.title, description: s.description, skill: s.skill_markdown, synced: s.synced })),
    connectors,
  };
}

async function deleteAgent(slug) {
  const row = await getAgentRow(slug);
  await db.query('DELETE FROM meta_biz_agents WHERE id = $1', [row.id]);
}

async function onboard(slug) {
  const row = await getAgentRow(slug);
  if (!row.access_token_enc) throw new Error('Set an access token before onboarding.');
  const result = await metaBizClient.onboardAgent(buildAgentContext(row));
  const agentId = result.agent_id || result.id || null;
  await db.query('UPDATE meta_biz_agents SET agent_id = $1, onboarded = true, updated_at = now() WHERE id = $2', [agentId, row.id]);
  return { agentId, raw: result };
}

async function updateSettingsLocal(slug, settings) {
  const row = await getAgentRow(slug);
  await db.query(
    `UPDATE meta_biz_agents SET handoff_enabled=$1, handoff_message=$2, followup_enabled=$3, followup_message=$4, ai_audience=$5, updated_at=now() WHERE id=$6`,
    [settings.handoffEnabled, settings.handoffMessage || '', settings.followupEnabled, settings.followupMessage || '', settings.aiAudience || 'EVERYONE', row.id]
  );
}

async function pushSettings(slug, { rolloutEnabled } = {}) {
  const row = await getAgentRow(slug);
  if (!row.agent_id) throw new Error('Onboard the agent before pushing settings.');
  const body = {
    rollout: { enabled: rolloutEnabled !== undefined ? rolloutEnabled : row.rollout_enabled },
    handoff: { enabled: row.handoff_enabled, message: row.handoff_message || '' },
    followup: { enabled: row.followup_enabled, message: row.followup_message || '' },
    ai_audience: row.ai_audience,
  };
  await metaBizClient.updateSettings(buildAgentContext(row), body);
  const newRollout = rolloutEnabled !== undefined ? rolloutEnabled : row.rollout_enabled;
  await db.query('UPDATE meta_biz_agents SET rollout_enabled = $1, updated_at = now() WHERE id = $2', [newRollout, row.id]);
  return body;
}

async function saveAndPushBusinessInfo(slug, info) {
  const row = await getAgentRow(slug);
  await db.query(
    `UPDATE meta_biz_agent_business_info SET business_description=$1, payment_method=$2, return_policy=$3, purchase_info=$4, delivery_and_shipping=$5, contact_email=$6, contact_hours=$7, contact_address=$8, synced=false, updated_at=now() WHERE agent_id=$9`,
    [info.businessDescription || '', info.paymentMethod || '', info.returnPolicy || '', info.purchaseInfo || '', info.deliveryAndShipping || '', info.contactEmail || '', info.contactHours || '', info.contactAddress || '', row.id]
  );
  const body = {
    business_description: info.businessDescription || '',
    payment_method: info.paymentMethod || '',
    return_policy: info.returnPolicy || '',
    purchase_info: info.purchaseInfo || '',
    delivery_and_shipping: info.deliveryAndShipping || '',
    contact_info: { email: info.contactEmail || '', hours_of_operation: info.contactHours || '', address: info.contactAddress || '' },
  };
  await metaBizClient.updateBusinessInfo(buildAgentContext(row), body);
  await db.query('UPDATE meta_biz_agent_business_info SET synced = true WHERE agent_id = $1', [row.id]);
}

async function addFaq(slug, { question, answer }) {
  const row = await getAgentRow(slug);
  if (!question || !answer) throw new Error('Both question and answer are required.');
  const { rows } = await db.query(
    'INSERT INTO meta_biz_agent_faqs (agent_id, question, answer) VALUES ($1,$2,$3) RETURNING *',
    [row.id, question, answer]
  );
  await metaBizClient.addFaq(buildAgentContext(row), { question, answer });
  await db.query('UPDATE meta_biz_agent_faqs SET synced = true WHERE id = $1', [rows[0].id]);
  return { id: rows[0].id, question, answer, synced: true };
}

async function deleteFaqLocal(slug, faqId) {
  const row = await getAgentRow(slug);
  await db.query('DELETE FROM meta_biz_agent_faqs WHERE id = $1 AND agent_id = $2', [faqId, row.id]);
}

async function addSkill(slug, { title, description, skill }) {
  const row = await getAgentRow(slug);
  if (!row.agent_id) throw new Error('Onboard the agent before adding skills.');
  if (!title || !skill) throw new Error('Both title and skill content are required.');
  const { rows } = await db.query(
    'INSERT INTO meta_biz_agent_skills (agent_id, title, description, skill_markdown) VALUES ($1,$2,$3,$4) RETURNING *',
    [row.id, title, description || '', skill]
  );
  await metaBizClient.addSkill(buildAgentContext(row), { title, description, skill });
  await db.query('UPDATE meta_biz_agent_skills SET synced = true WHERE id = $1', [rows[0].id]);
  return { id: rows[0].id, title, description, skill, synced: true };
}

async function deleteSkillLocal(slug, skillId) {
  const row = await getAgentRow(slug);
  await db.query('DELETE FROM meta_biz_agent_skills WHERE id = $1 AND agent_id = $2', [skillId, row.id]);
}

async function createConnector(slug, { name, description, baseUrl, authType, authHeaderName, authValue }) {
  const row = await getAgentRow(slug);
  if (!name || !baseUrl) throw new Error('Connector name and base URL are required.');
  const authValueEnc = authValue ? cryptoHelper.encrypt(authValue) : null;
  const { rows } = await db.query(
    `INSERT INTO meta_biz_agent_connectors (agent_id, name, description, base_url, auth_type, auth_header_name, auth_value_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [row.id, name, description || '', baseUrl, authType || 'API_KEY', authHeaderName || '', authValueEnc]
  );
  const connectorRow = rows[0];

  const body = {
    name, description: description || '', base_url: baseUrl, auth_type: authType || 'API_KEY', requires_certificate: false,
  };
  if ((authType || 'API_KEY') === 'API_KEY' && authValue) {
    body.auth_config = { api_key: { headers: [{ field_name: authHeaderName || 'Authorization', value: authValue, prefix: '' }] } };
  }
  const result = await metaBizClient.createConnector(buildAgentContext(row), body);
  const remoteId = result.id || result.connector_id || null;
  await db.query('UPDATE meta_biz_agent_connectors SET remote_connector_id = $1, synced = true WHERE id = $2', [remoteId, connectorRow.id]);
  return { id: connectorRow.id, name, description, baseUrl, authType, remoteConnectorId: remoteId, synced: true };
}

async function deleteConnectorLocal(slug, connectorId) {
  const row = await getAgentRow(slug);
  await db.query('DELETE FROM meta_biz_agent_connectors WHERE id = $1 AND agent_id = $2', [connectorId, row.id]);
}

async function getConnectorRow(agentDbId, connectorId) {
  const { rows } = await db.query('SELECT * FROM meta_biz_agent_connectors WHERE id = $1 AND agent_id = $2', [connectorId, agentDbId]);
  if (rows.length === 0) throw new Error('Connector not found.');
  return rows[0];
}

async function createTool(slug, connectorId, { name, description, requestDefinition }) {
  const row = await getAgentRow(slug);
  const connectorRow = await getConnectorRow(row.id, connectorId);
  if (!connectorRow.remote_connector_id) throw new Error('This connector has not been synced to Meta yet.');
  if (!name || !requestDefinition) throw new Error('Tool name and request definition are required.');

  let parsedDef;
  try { parsedDef = typeof requestDefinition === 'string' ? JSON.parse(requestDefinition) : requestDefinition; }
  catch (e) { throw new Error('Request definition must be valid JSON.'); }

  const { rows } = await db.query(
    'INSERT INTO meta_biz_agent_tools (connector_id, name, description, request_definition_json) VALUES ($1,$2,$3,$4) RETURNING *',
    [connectorId, name, description || '', JSON.stringify(parsedDef)]
  );
  const toolRow = rows[0];

  const result = await metaBizClient.createTool(buildAgentContext(row), connectorRow.remote_connector_id, {
    name, description: description || '', request_definition: parsedDef,
  });
  const remoteToolId = result.id || result.tool_id || null;
  await db.query('UPDATE meta_biz_agent_tools SET remote_tool_id = $1, synced = true WHERE id = $2', [remoteToolId, toolRow.id]);
  return { id: toolRow.id, name, description, requestDefinition: parsedDef, remoteToolId, synced: true };
}

async function deleteToolLocal(slug, connectorId, toolId) {
  await db.query('DELETE FROM meta_biz_agent_tools WHERE id = $1 AND connector_id = $2', [toolId, connectorId]);
}

async function testTool(slug, connectorId, toolId, inputVars) {
  const row = await getAgentRow(slug);
  const connectorRow = await getConnectorRow(row.id, connectorId);
  const { rows } = await db.query('SELECT * FROM meta_biz_agent_tools WHERE id = $1 AND connector_id = $2', [toolId, connectorId]);
  if (rows.length === 0) throw new Error('Tool not found.');
  const toolRow = rows[0];
  if (!toolRow.remote_tool_id) throw new Error('This tool has not been synced to Meta yet.');
  return metaBizClient.runTool(buildAgentContext(row), connectorRow.remote_connector_id, toolRow.remote_tool_id, inputVars);
}

module.exports = {
  listAgents, createAgent, getAgentDetail, deleteAgent, onboard,
  updateSettingsLocal, pushSettings, saveAndPushBusinessInfo,
  addFaq, deleteFaqLocal, addSkill, deleteSkillLocal,
  createConnector, deleteConnectorLocal, createTool, deleteToolLocal, testTool,
};
