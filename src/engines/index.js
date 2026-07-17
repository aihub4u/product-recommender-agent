const config = require('../config');
const ruleEngine = require('./ruleEngine');
const llmEngine = require('./llmEngine');

const hasLlm = Boolean(config.anthropicApiKey);

/**
 * Runs the recommendation decision. Uses the LLM engine automatically when
 * ANTHROPIC_API_KEY is configured; otherwise uses the rule-based engine.
 * If the LLM call fails for any reason (network, bad key, parse error),
 * falls back to the rule engine so the API stays available.
 */
async function decide(context) {
  if (hasLlm) {
    try {
      return await llmEngine.decide(context);
    } catch (err) {
      console.error('[engine] LLM engine failed, falling back to rule engine:', err.message);
      return ruleEngine.decide(context);
    }
  }
  return ruleEngine.decide(context);
}

module.exports = { decide, engineInUse: hasLlm ? 'llm' : 'rule' };
