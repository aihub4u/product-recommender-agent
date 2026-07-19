/**
 * Thin client for Meta's BizAI WA Enterprise 3P API, built directly from
 * the "BizAI apply" Postman collection. Endpoint paths, headers, and body
 * shapes match that collection exactly — this is not a general Graph API
 * wrapper, just the specific BizAI agent-configuration surface.
 *
 * Not covered here (visible in the source collection but not wired into
 * this platform yet): WhatsApp number registration (graph.facebook.com),
 * Thread Control, and the Agent Eval framework. Straightforward to add
 * following the same pattern below if needed.
 */

async function call(agent, { method, path, body, apiVersion }) {
  const url = `${agent.apiBase}/${agent.entityId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${agent.accessToken}`,
      'X-API-Version': apiVersion,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Meta BizAI API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function onboardAgent(agent) {
  return call(agent, { method: 'POST', path: '/agent_onboarding?channel=whatsapp', body: {}, apiVersion: '2.0.0' });
}

async function updateSettings(agent, settings) {
  return call(agent, {
    method: 'PUT',
    path: `/agent_config/settings?agent_id=${agent.agentId}`,
    body: settings,
    apiVersion: '1.0.0',
  });
}

async function updateBusinessInfo(agent, info) {
  return call(agent, { method: 'PUT', path: '/agent_config/business_info', body: info, apiVersion: '1.0.0' });
}

async function addFaq(agent, { question, answer }) {
  return call(agent, { method: 'POST', path: '/agent_config/faq', body: { question, answer }, apiVersion: '1.0.0' });
}

async function addSkill(agent, { title, description, skill }) {
  return call(agent, {
    method: 'POST',
    path: `/agent_config/skills?agent_id=${agent.agentId}`,
    body: { title, description: description || `Apply for: ${title}`, skill },
    apiVersion: '2.0.0',
  });
}

async function createConnector(agent, connectorBody) {
  return call(agent, { method: 'POST', path: '/agent_connectors/', body: connectorBody, apiVersion: '2.0.0' });
}

async function listConnectors(agent) {
  return call(agent, { method: 'GET', path: '/agent_connectors/', apiVersion: '2.0.0' });
}

async function createTool(agent, remoteConnectorId, toolBody) {
  return call(agent, {
    method: 'POST',
    path: `/agent_connectors/${remoteConnectorId}/tools`,
    body: toolBody,
    apiVersion: '2.0.0',
  });
}

async function runTool(agent, remoteConnectorId, remoteToolId, inputVars) {
  return call(agent, {
    method: 'POST',
    path: `/agent_connectors/${remoteConnectorId}/tools/${remoteToolId}/run`,
    body: { input: JSON.stringify(inputVars || {}) },
    apiVersion: '2.0.0',
  });
}

module.exports = { onboardAgent, updateSettings, updateBusinessInfo, addFaq, addSkill, createConnector, listConnectors, createTool, runTool };
