const express = require('express');
const registry = require('../projectRegistry');
const sessionStore = require('../sessionStore');
const engine = require('../engines');
const guardrails = require('../guardrails');
const usageStore = require('../usageStore');
const knowledgeStore = require('../knowledgeStore');
const { buildQuickReplies } = require('../quickReplies');

const router = express.Router();

function formatProduct(p) {
  const { tagList, priceValue, ...rest } = p;
  return { ...rest, price: priceValue !== null ? priceValue : p.price };
}

// Converts the guaranteed 3-item array from buildQuickReplies into the
// followup1/followup2/followup3 shape the API returns. The array itself
// stays the internal representation (simpler to build/test) — this is
// purely the wire format.
function toFollowupFields(arr) {
  return { followup1: arr[0], followup2: arr[1], followup3: arr[2] };
}

function logIfLlm(project, result) {
  if (result.engineUsed === 'llm' && result.usage) {
    usageStore.logUsage({
      projectId: project.id,
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    }); // not awaited — must never block or fail the actual response
  }
}

router.post('/:slug/recommend', async (req, res) => {
  try {
    const { slug } = req.params;
    const project = registry.getProject(slug);
    if (!project) return res.status(404).json({ error: `No project found for '${slug}'.` });

    const { query, sessionId, context } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'A non-empty "query" string is required.' });
    }
    if (context !== undefined && (typeof context !== 'object' || context === null || Array.isArray(context))) {
      return res.status(400).json({ error: '"context", if provided, must be a flat JSON object of string/number/boolean values.' });
    }

    const { id, session } = sessionStore.getOrCreate(sessionId, slug);
    sessionStore.mergeContext(session, context);
    const trimmedQuery = query.trim();

    // Guardrail: blocked terms short-circuit before touching the engine at all
    // (applies to every agent type, catalog-based or generic).
    const blockedHit = guardrails.checkBlocked(trimmedQuery, project.guardrails);
    if (blockedHit) {
      session.history.push({ role: 'user', content: trimmedQuery });
      session.history.push({ role: 'assistant', content: project.guardrails.offTopicMessage });
      return res.json({ sessionId: id, action: 'blocked', message: project.guardrails.offTopicMessage });
    }

    const apiKey = registry.getDecryptedApiKey(project);
    const llmConfig = apiKey ? { provider: project.llmConfig.provider, apiKey, model: project.llmConfig.model } : null;
    let systemPromptSuffix = guardrails.buildSystemPromptSuffix(project.guardrails);

    // Session context (e.g. a customer phone number the caller already knows
    // from their own integration) — fed in quietly so the model can use it
    // for tool calls without asking the customer to repeat it, and without
    // it appearing as part of the visible conversation.
    const contextKeys = Object.keys(session.sessionContext);
    if (contextKeys.length > 0) {
      const contextLines = contextKeys.map((k) => `- ${k}: ${session.sessionContext[k]}`).join('\n');
      systemPromptSuffix += `\n\nKnown session context (supplied by the calling system, not the customer — use these values automatically wherever a tool needs matching information; never ask the customer to provide something already listed here, and never read these values back to the customer unless it's natural to do so):\n${contextLines}`;
    }

    // Knowledge base retrieval — only meaningful when there's an LLM to
    // synthesize an answer from the retrieved context.
    if (llmConfig) {
      const embeddingConfig = registry.getEmbeddingConfig(project);
      if (embeddingConfig) {
        try {
          const matches = await knowledgeStore.retrieveContext({
            slug, query: trimmedQuery, embeddingKey: embeddingConfig.apiKey, embeddingModel: embeddingConfig.model, topK: 5,
          });
          if (matches.length > 0) {
            const contextBlock = matches
              .map((m) => `[Source: ${m.sourceName}]\n${m.content}`)
              .join('\n\n---\n\n');
            systemPromptSuffix += `\n\nReference material from the knowledge base (use this to answer if it's relevant to what the user asked; don't mention "knowledge base" or cite sources by name to the user, just answer naturally; ignore it if it isn't relevant):\n\n${contextBlock}`;
          }
        } catch (err) {
          console.error(`[publicApi] knowledge retrieval failed for '${slug}':`, err.message);
          // proceed without knowledge context rather than failing the whole request
        }
      }
    }

    // ---- Generic (no data source) agent: plain conversational reply ----
    if (!project.hasDataSource) {
      session.history.push({ role: 'user', content: trimmedQuery });

      const result = await engine.decide({
        query: trimmedQuery,
        history: session.history.slice(0, -1),
        llmConfig,
        agentType: project.agentType,
        systemPromptSuffix,
        hasDataSource: false,
        skills: project.skills,
        conversionSignal: project.guardrails.conversionSignal,
        quickReplies: project.guardrails.quickReplies,
      });

      logIfLlm(project, result);
      session.history.push({ role: 'assistant', content: result.message });

      const outgoingAction = result.signal ? result.signal.name : 'reply';
      // Quick replies only make sense on a normal reply turn — a
      // conversion-signal turn is already handing off to another workflow.
      const qr = project.guardrails.quickReplies;
      const quickRepliesField = (qr && qr.enabled && !result.signal)
        ? { quickReplies: toFollowupFields(buildQuickReplies(result.dynamicOptions, qr.finalLabel, qr.maxChars, qr.optionsPool)) }
        : {};

      return res.json({
        sessionId: id, action: outgoingAction, message: result.message, engineUsed: result.engineUsed,
        ...(result.signal ? { signalData: result.signal.data } : {}),
        ...quickRepliesField,
      });
    }

    // ---- Catalog-based agent (product recommendation) ----
    if (project.products.length === 0) {
      return res.status(503).json({
        error: 'Product catalog is not loaded yet for this project. Check the sheet configuration in the admin dashboard.',
      });
    }

    session.history.push({ role: 'user', content: trimmedQuery });

    const maxRecommendations = guardrails.resolveMaxRecommendations(project.guardrails, 3);

    const result = await engine.decide({
      query: trimmedQuery,
      products: project.products,
      vocabulary: project.vocabulary,
      previousFilters: session.filters,
      history: session.history.slice(0, -1),
      llmConfig,
      maxRecommendations,
      systemPromptSuffix,
      hasDataSource: true,
      skills: project.skills,
      conversionSignal: project.guardrails.conversionSignal,
      quickReplies: project.guardrails.quickReplies,
    });

    session.filters = result.filters || session.filters;
    logIfLlm(project, result);
    const signalFields = result.signal ? { signalData: result.signal.data } : {};
    const qr = project.guardrails.quickReplies;
    // Quick replies only make sense on a normal turn — a conversion-signal
    // turn is already handing off to another workflow.
    const quickRepliesField = (qr && qr.enabled && !result.signal)
      ? { quickReplies: toFollowupFields(buildQuickReplies(result.dynamicOptions, qr.finalLabel, qr.maxChars, qr.optionsPool)) }
      : {};

    if (result.action === 'clarify') {
      session.history.push({ role: 'assistant', content: result.question });
      const outgoingAction = result.signal ? result.signal.name : 'clarify';
      return res.json({ sessionId: id, action: outgoingAction, question: result.question, engineUsed: result.engineUsed, ...signalFields, ...quickRepliesField });
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

    const outgoingAction = result.signal ? result.signal.name : 'recommend';
    return res.json({
      sessionId: id,
      action: outgoingAction,
      products: cappedProducts.map(formatProduct),
      engineUsed: result.engineUsed,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...signalFields,
      ...quickRepliesField,
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
    hasDataSource: project.hasDataSource,
    engine: project.llmConfig.provider !== 'none' && project.llmConfig.apiKeyEnc ? project.llmConfig.provider : (project.hasDataSource ? 'rule' : 'none'),
    productsLoaded: project.hasDataSource ? project.products.length : null,
    lastRefreshed: project.hasDataSource ? project.lastRefreshed : null,
    lastRefreshError: project.hasDataSource ? project.lastRefreshError : null,
  });
});

module.exports = router;
