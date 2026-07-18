const ruleEngine = require('./ruleEngine');
const llmEngine = require('./llmEngine');
const chatEngine = require('./chatEngine');

/**
 * Runs the recommendation/reply decision for a single project/request.
 * - Catalog-based projects (hasDataSource: true): LLM engine if configured,
 *   else rule engine, with automatic fallback on LLM failure.
 * - Generic projects (hasDataSource: false): LLM-only conversational reply.
 *   There's no rule-based fallback possible without a catalog, so failures
 *   return a graceful plain-text message instead of erroring out.
 */
async function decide(context) {
  const { llmConfig, hasDataSource } = context;
  const hasLlm = Boolean(llmConfig && llmConfig.provider && llmConfig.provider !== 'none' && llmConfig.apiKey);

  if (!hasDataSource) {
    if (!hasLlm) {
      return {
        action: 'reply',
        message: "This agent doesn't have an LLM provider configured yet, so it can't respond intelligently. Add one in the LLM tab to activate it.",
        engineUsed: 'none',
      };
    }
    try {
      const result = await chatEngine.decide(context);
      return { ...result, engineUsed: 'llm', provider: llmConfig.provider, model: llmConfig.model };
    } catch (err) {
      console.error(`[engine] chat engine failed (${llmConfig.provider}):`, err.message);
      return {
        action: 'reply',
        message: "Sorry, I'm having trouble responding right now — please try again in a moment.",
        engineUsed: 'error',
      };
    }
  }

  if (hasLlm) {
    try {
      const result = await llmEngine.decide(context);
      return { ...result, engineUsed: 'llm', provider: llmConfig.provider, model: llmConfig.model };
    } catch (err) {
      console.error(`[engine] LLM engine failed (${llmConfig.provider}), falling back to rule engine:`, err.message);
      const result = ruleEngine.decide(context);
      return { ...result, engineUsed: 'rule' };
    }
  }

  const result = ruleEngine.decide(context);
  return { ...result, engineUsed: 'rule' };
}

module.exports = { decide };
