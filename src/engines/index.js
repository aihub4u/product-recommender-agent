const ruleEngine = require('./ruleEngine');
const llmEngine = require('./llmEngine');

/**
 * Runs the recommendation decision for a single project/request.
 * Uses the LLM engine when the project has a valid provider+apiKey
 * configured; otherwise (or on LLM failure) falls back to the rule engine
 * so the API always returns something usable.
 */
async function decide(context) {
  const { llmConfig } = context;
  const hasLlm = Boolean(llmConfig && llmConfig.provider && llmConfig.provider !== 'none' && llmConfig.apiKey);

  if (hasLlm) {
    try {
      const result = await llmEngine.decide(context);
      return { ...result, engineUsed: 'llm' };
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
