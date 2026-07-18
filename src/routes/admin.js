const express = require('express');
const multer = require('multer');
const auth = require('../auth');
const registry = require('../projectRegistry');
const cryptoHelper = require('../crypto');
const usageStore = require('../usageStore');
const { AGENT_TYPES } = require('../agentTypes');
const { executeSkill } = require('../skillExecutor');
const knowledgeStore = require('../knowledgeStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ---- Auth ----
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  try {
    if (!auth.checkPassword(password)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    const token = auth.issueToken();
    auth.setAuthCookie(res, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAdmin, (req, res) => res.json({ ok: true }));

// Everything below requires admin auth.
router.use(auth.requireAdmin);

// ---- Agent type suggestions (for the creation wizard) ----
router.get('/agent-types', (req, res) => {
  res.json({ agentTypes: AGENT_TYPES.map(({ id, label, category, description, suggestedHasDataSource }) => ({ id, label, category, description, suggestedHasDataSource })) });
});

// ---- Projects ----
router.get('/projects', (req, res) => {
  res.json({ projects: registry.listProjects() });
});

router.post('/projects', async (req, res) => {
  try {
    const { name, agentType, hasDataSource } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required.' });
    const entry = await registry.createProject(name.trim(), {
      agentType: agentType || 'custom',
      hasDataSource: hasDataSource !== false,
    });
    res.json({ project: { id: entry.id, name: entry.name, slug: entry.slug, agentType: entry.agentType, hasDataSource: entry.hasDataSource } });
  } catch (err) {
    console.error('[admin] create project failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:slug', (req, res) => {
  const entry = registry.getProject(req.params.slug);
  if (!entry) return res.status(404).json({ error: 'Project not found.' });

  res.json({
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    agentType: entry.agentType,
    hasDataSource: entry.hasDataSource,
    productsLoaded: entry.products.length,
    lastRefreshed: entry.lastRefreshed,
    lastRefreshError: entry.lastRefreshError,
    sheet: {
      sheetId: entry.sheetConfig.sheetId,
      range: entry.sheetConfig.range,
      catalogRefreshMs: entry.sheetConfig.catalogRefreshMs,
      hasCustomServiceAccount: entry.sheetConfig.hasCustomServiceAccount,
    },
    llm: {
      provider: entry.llmConfig.provider,
      model: entry.llmConfig.model,
      apiKeyMasked: entry.llmConfig.apiKeyEnc ? cryptoHelper.maskSecret(24) : null,
      embeddingModel: entry.llmConfig.embeddingModel,
      embeddingApiKeyMasked: entry.llmConfig.embeddingApiKeyEnc ? cryptoHelper.maskSecret(24) : null,
      embeddingReady: Boolean(registry.getEmbeddingConfig(entry)),
    },
    guardrails: entry.guardrails,
  });
});

router.delete('/projects/:slug', async (req, res) => {
  try {
    const ok = await registry.deleteProject(req.params.slug);
    if (!ok) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Sheet config ----
router.put('/projects/:slug/sheet', async (req, res) => {
  try {
    const { sheetId, range, catalogRefreshMs, serviceAccountJson, clearServiceAccount } = req.body || {};
    const updated = await registry.updateSheetConfig(req.params.slug, {
      sheetId, range, catalogRefreshMs, serviceAccountJson, clearServiceAccount,
    });
    res.json({
      sheetId: updated.sheetId,
      range: updated.range,
      catalogRefreshMs: updated.catalogRefreshMs,
      hasCustomServiceAccount: updated.hasCustomServiceAccount,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/projects/:slug/sheet/refresh', async (req, res) => {
  try {
    const entry = await registry.refreshCatalog(req.params.slug);
    res.json({
      productsLoaded: entry.products.length,
      lastRefreshed: entry.lastRefreshed,
      lastRefreshError: entry.lastRefreshError,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- LLM config ----
router.put('/projects/:slug/llm', async (req, res) => {
  try {
    const { provider, apiKey, model, clearApiKey, embeddingApiKey, embeddingModel, clearEmbeddingApiKey } = req.body || {};
    if (provider && !['none', 'openai', 'anthropic'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be one of: none, openai, anthropic' });
    }
    const updated = await registry.updateLlmConfig(req.params.slug, {
      provider, apiKey, model, clearApiKey, embeddingApiKey, embeddingModel, clearEmbeddingApiKey,
    });
    const entry = registry.getProject(req.params.slug);
    res.json({
      provider: updated.provider,
      model: updated.model,
      apiKeyMasked: updated.apiKeyEnc ? cryptoHelper.maskSecret(24) : null,
      embeddingModel: updated.embeddingModel,
      embeddingApiKeyMasked: updated.embeddingApiKeyEnc ? cryptoHelper.maskSecret(24) : null,
      embeddingReady: Boolean(registry.getEmbeddingConfig(entry)),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Guardrails ----
router.put('/projects/:slug/guardrails', async (req, res) => {
  try {
    const { systemInstructions, blockedTerms, minPrice, maxPrice, maxRecommendations, offTopicMessage } = req.body || {};
    const parsedTerms = Array.isArray(blockedTerms)
      ? blockedTerms
      : String(blockedTerms || '').split(',').map((t) => t.trim()).filter(Boolean);

    const updated = await registry.updateGuardrails(req.params.slug, {
      systemInstructions,
      blockedTerms: parsedTerms,
      minPrice: minPrice === '' ? null : minPrice,
      maxPrice: maxPrice === '' ? null : maxPrice,
      maxRecommendations,
      offTopicMessage,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Usage & costs ----
router.get('/usage', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const [byProject, daily] = await Promise.all([
      usageStore.getAllProjectsSummary(days),
      usageStore.getDailyTotals(days),
    ]);
    res.json({ days, byProject, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:slug/usage', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    const days = parseInt(req.query.days, 10) || 30;
    const summary = await usageStore.getProjectSummary(entry.id, days);
    res.json({ days, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usage broken down by date — the daily trend for this specific agent.
router.get('/projects/:slug/usage/timeline', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    const days = parseInt(req.query.days, 10) || 30;
    const daily = await usageStore.getProjectDailyTotals(entry.id, days);
    res.json({ days, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Individual requests with exact date+time — the detailed usage log for this agent.
router.get('/projects/:slug/usage/log', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const logs = await usageStore.getProjectRecentLogs(entry.id, limit);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Skills (external API tools) ----
router.get('/projects/:slug/skills', async (req, res) => {
  try {
    const skills = await registry.listSkills(req.params.slug);
    res.json({ skills: skills.map((s) => ({ ...s, authValueEnc: undefined })) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/projects/:slug/skills', async (req, res) => {
  try {
    const skill = await registry.createSkill(req.params.slug, req.body || {});
    res.json({ skill: { ...skill, authValueEnc: undefined } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/projects/:slug/skills/:skillId', async (req, res) => {
  try {
    const skill = await registry.updateSkill(req.params.slug, req.params.skillId, req.body || {});
    res.json({ skill: { ...skill, authValueEnc: undefined } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:slug/skills/:skillId', async (req, res) => {
  try {
    await registry.deleteSkill(req.params.slug, req.params.skillId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Fires the skill directly with sample args (no LLM involved) so the
// operator can verify it works before an agent ever relies on it.
router.post('/projects/:slug/skills/:skillId/test', async (req, res) => {
  try {
    const project = registry.getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const skill = project.skills.find((s) => s.id === req.params.skillId);
    if (!skill) return res.status(404).json({ error: 'Skill not found.' });

    const authValue = registry.getDecryptedSkillAuth(skill);
    const result = await executeSkill(skill, req.body?.args || {}, authValue);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Knowledge base (RAG: files + website crawling) ----
router.get('/projects/:slug/knowledge', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    const sources = await knowledgeStore.listSources(entry.id);
    const embeddingConfig = registry.getEmbeddingConfig(entry);
    res.json({ sources, embeddingReady: Boolean(embeddingConfig) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects/:slug/knowledge/upload', upload.single('file'), async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const embeddingConfig = registry.getEmbeddingConfig(entry);
    if (!embeddingConfig) {
      return res.status(400).json({ error: "No embeddings key available. Set an OpenAI key in the LLM tab (as the main provider, or as a dedicated embeddings key) before adding knowledge sources." });
    }

    const result = await knowledgeStore.ingestFile({
      projectId: entry.id, slug: entry.slug,
      embeddingKey: embeddingConfig.apiKey, embeddingModel: embeddingConfig.model,
      filename: req.file.originalname, buffer: req.file.buffer, mimeType: req.file.mimetype,
    });
    res.json({ source: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/projects/:slug/knowledge/website', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'A URL is required.' });

    const embeddingConfig = registry.getEmbeddingConfig(entry);
    if (!embeddingConfig) {
      return res.status(400).json({ error: "No embeddings key available. Set an OpenAI key in the LLM tab (as the main provider, or as a dedicated embeddings key) before adding knowledge sources." });
    }

    const result = await knowledgeStore.ingestWebsite({
      projectId: entry.id, slug: entry.slug,
      embeddingKey: embeddingConfig.apiKey, embeddingModel: embeddingConfig.model,
      url,
    });
    res.json({ source: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:slug/knowledge/:sourceId', async (req, res) => {
  try {
    const entry = registry.getProject(req.params.slug);
    if (!entry) return res.status(404).json({ error: 'Project not found.' });
    await knowledgeStore.deleteSource(entry.id, entry.slug, req.params.sourceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
