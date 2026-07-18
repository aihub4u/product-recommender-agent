/**
 * Approximate USD pricing per 1M tokens, as published by each provider
 * around mid-2026. These change over time — treat as estimates for
 * budgeting purposes, not an exact bill reconciliation. Update the tables
 * below if a provider changes pricing.
 */
const PRICING = {
  openai: {
    'gpt-5.5': { input: 5.00, output: 30.00 },
    'gpt-5.4-mini': { input: 0.75, output: 3.00 },
    'gpt-5.4-nano': { input: 0.25, output: 1.00 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1-nano': { input: 0.10, output: 0.40 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    _default: { input: 0.75, output: 3.00 }, // used when the configured model isn't in this table
  },
  anthropic: {
    'claude-sonnet-5': { input: 2.00, output: 10.00 }, // intro pricing; reverts to $3/$15 after Aug 31 2026
    'claude-opus-4-8': { input: 5.00, output: 25.00 },
    'claude-haiku-4-5': { input: 1.00, output: 5.00 },
    'claude-fable-5': { input: 10.00, output: 50.00 },
    _default: { input: 2.00, output: 10.00 },
  },
};

/**
 * Returns { costUsd, estimated } — estimated is true when we fell back to
 * a provider-level default rather than an exact model match.
 */
function calculateCost(provider, model, inputTokens, outputTokens) {
  const table = PRICING[provider];
  if (!table) return { costUsd: null, estimated: true };

  const rates = table[model] || table._default;
  const estimated = !table[model];
  const costUsd =
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output;

  return { costUsd: Number(costUsd.toFixed(6)), estimated };
}

module.exports = { calculateCost, PRICING };
