const express = require('express');
const auth = require('../auth');
const registry = require('../projectRegistry');
const cryptoHelper = require('../crypto');

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

// ---- Projects ----
router.get('/projects', (req, res) => {
  res.json({ projects: registry.listProjects() });
});

router.post('/projects', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required.' });
    const entry = await registry.createProject(name.trim());
    res.json({ project: { id: entry.id, name: entry.name, slug: entry.slug } });
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
    const { provider, apiKey, model, clearApiKey } = req.body || {};
    if (provider && !['none', 'openai', 'anthropic'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be one of: none, openai, anthropic' });
    }
    const updated = await registry.updateLlmConfig(req.params.slug, { provider, apiKey, model, clearApiKey });
    res.json({
      provider: updated.provider,
      model: updated.model,
      apiKeyMasked: updated.apiKeyEnc ? cryptoHelper.maskSecret(24) : null,
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

module.exports = router;
