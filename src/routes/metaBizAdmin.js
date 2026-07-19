const express = require('express');
const auth = require('../auth');
const metaBizStore = require('../metaBizStore');

const router = express.Router();
router.use(auth.requireAdmin);

router.get('/agents', async (req, res) => {
  try {
    res.json({ agents: await metaBizStore.listAgents() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/agents', async (req, res) => {
  try {
    const agent = await metaBizStore.createAgent(req.body || {});
    res.json({ agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/agents/:slug', async (req, res) => {
  try {
    res.json(await metaBizStore.getAgentDetail(req.params.slug));
  } catch (err) { res.status(404).json({ error: err.message }); }
});

router.delete('/agents/:slug', async (req, res) => {
  try {
    await metaBizStore.deleteAgent(req.params.slug);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/onboard', async (req, res) => {
  try {
    res.json(await metaBizStore.onboard(req.params.slug));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/agents/:slug/settings', async (req, res) => {
  try {
    await metaBizStore.updateSettingsLocal(req.params.slug, req.body || {});
    const pushed = await metaBizStore.pushSettings(req.params.slug);
    res.json({ ok: true, pushed });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/go-live', async (req, res) => {
  try {
    const pushed = await metaBizStore.pushSettings(req.params.slug, { rolloutEnabled: req.body?.enabled !== false });
    res.json({ ok: true, pushed });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/agents/:slug/business-info', async (req, res) => {
  try {
    await metaBizStore.saveAndPushBusinessInfo(req.params.slug, req.body || {});
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/faqs', async (req, res) => {
  try {
    res.json({ faq: await metaBizStore.addFaq(req.params.slug, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:slug/faqs/:faqId', async (req, res) => {
  try {
    await metaBizStore.deleteFaqLocal(req.params.slug, req.params.faqId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/skills', async (req, res) => {
  try {
    res.json({ skill: await metaBizStore.addSkill(req.params.slug, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:slug/skills/:skillId', async (req, res) => {
  try {
    await metaBizStore.deleteSkillLocal(req.params.slug, req.params.skillId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/connectors', async (req, res) => {
  try {
    res.json({ connector: await metaBizStore.createConnector(req.params.slug, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:slug/connectors/:connectorId', async (req, res) => {
  try {
    await metaBizStore.deleteConnectorLocal(req.params.slug, req.params.connectorId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/connectors/:connectorId/tools', async (req, res) => {
  try {
    res.json({ tool: await metaBizStore.createTool(req.params.slug, req.params.connectorId, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:slug/connectors/:connectorId/tools/:toolId', async (req, res) => {
  try {
    await metaBizStore.deleteToolLocal(req.params.slug, req.params.connectorId, req.params.toolId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/agents/:slug/connectors/:connectorId/tools/:toolId/test', async (req, res) => {
  try {
    const result = await metaBizStore.testTool(req.params.slug, req.params.connectorId, req.params.toolId, req.body?.input || {});
    res.json({ result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
