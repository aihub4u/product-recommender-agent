const express = require('express');
const registry = require('../projectRegistry');
const sessionStore = require('../sessionStore');
const engine = require('../engines');
const guardrails = require('../guardrails');
const usageStore = require('../usageStore');

const router = express.Router();

function formatProduct(p) {
  const { tagList, priceValue, ...rest } = p;
  return { ...rest, price: priceValue !== null ? priceValue : p.price };
}

router.post('/:slug/recommend', async (req, res) => {
  try {
    const { slug } = req.params;
    const project = registry.getProject(slug);
    if (!project) return res.status(404).json({ error: `No project found for '${slug}'.` });

    const { query, sessionId } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'A non-empty "query" string is required.' });
    }

    if (project.products.length === 0) {
      return res.status(503).json({
        error: 'Product catalog is not loaded yet for this project. Check the sheet configuration in the admin dashboard.',
      });
    }

    const { id, session } = sessionStore.getOrCreate(sessionId, slug);
    const trimmedQuery = query.trim();

    // Guardrail: blocked terms short-circuit before touching the engine at all.
    const blockedHit = guardrails.checkBlocked(trimmedQuery, project.guardrails);
    if (blockedHit) {
      session.history.push({ role: 'user', content: trimmedQuery });
      session.history.push({ role: 'assistant', content: project.guardrails.offTopicMessage });
      return res.json({ sessionId: id, action: 'blocked', message: project.guardrails.offTopicMessage });
    }

    session.history.push({ role: 'user', content: trimmedQuery });

    const maxRecommendations = guardrails.resolveMaxRecommendations(project.guardrails, 3);
    const systemPromptSuffix = guardrails.buildSystemPromptSuffix(project.guardrails);
    const apiKey = registry.getDecryptedApiKey(project);

    const result = await engine.decide({
      query: trimmedQuery,
      products: project.products,
      vocabulary: project.vocabulary,
      previousFilters: session.filters,
      history: session.history.slice(0, -1),
      llmConfig: apiKey ? { provider: project.llmConfig.provider, apiKey, model: project.llmConfig.model } : null,
      maxRecommendations,
      systemPromptSuffix,
    });

    session.filters = result.filters || session.filters;

    if (result.engineUsed === 'llm' && result.usage) {
      usageStore.logUsage({
        projectId: project.id,
        provider: result.provider,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      }); // not awaited — must never block or fail the actual response
    }

    if (result.action === 'clarify') {
      session.history.push({ role: 'assistant', content: result.question });
      return res.json({ sessionId: id, action: 'clarify', question: result.question, engineUsed: result.engineUsed });
    }

    // Guardrail: hard price cap applied on top of whatever the engine picked.
    const cappedProducts = guardrails.applyPriceCap(result.products, project.guardrails);
    if (cappedProducts.length === 0) {
      const question = "I found some options, but none fit the store's allowed price range — could you adjust your budget?";
      session.history.push({ role: 'assistant', content: question });
      return res.json({ sessionId: id, action: 'clarify', question, engineUsed: result.engineUsed });
    }

    session.history.push({
      role: 'assistant',
      content: `Recommended: ${cappedProducts.map((p) => p.name || p.id).join(', ')}`,
    });

    return res.json({
      sessionId: id,
      action: 'recommend',
      products: cappedProducts.map(formatProduct),
      engineUsed: result.engineUsed,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    });
  } catch (err) {
    console.error('[publicApi] recommend error:', err);
    return res.status(500).json({ error: 'Internal error while generating a recommendation.' });
  }
});

router.get('/:slug/health', (req, res) => {
  const project = registry.getProject(req.params.slug);
  if (!project) return res.status(404).json({ error: `No project found for '${req.params.slug}'.` });
  res.json({
    status: 'ok',
    project: project.slug,
    engine: project.llmConfig.provider !== 'none' && project.llmConfig.apiKeyEnc ? project.llmConfig.provider : 'rule',
    productsLoaded: project.products.length,
    lastRefreshed: project.lastRefreshed,
    lastRefreshError: project.lastRefreshError,
  });
});

module.exports = router;
