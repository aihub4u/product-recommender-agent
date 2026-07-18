/**
 * Guardrails are per-project, stored in project_guardrails and loaded onto
 * the in-memory project entry. Shape:
 * {
 *   systemInstructions: string,   // appended to the LLM system prompt
 *   blockedTerms: string[],       // lowercase substrings; a match short-circuits to offTopicMessage
 *   minPrice: number|null,        // clamps recommendations below this are dropped
 *   maxPrice: number|null,        // clamps recommendations above this are dropped
 *   maxRecommendations: number,   // 1-5, overrides the platform default of 3
 *   offTopicMessage: string,
 * }
 */

function checkBlocked(query, guardrails) {
  const terms = guardrails?.blockedTerms || [];
  if (!terms.length) return null;
  const q = query.toLowerCase();
  const hit = terms.find((t) => t && q.includes(String(t).toLowerCase()));
  return hit || null;
}

function applyPriceCap(products, guardrails) {
  const min = guardrails?.minPrice;
  const max = guardrails?.maxPrice;
  if (min === null && max === null) return products;
  if ((min === undefined || min === null) && (max === undefined || max === null)) return products;
  return products.filter((p) => {
    const price = typeof p.priceValue === 'number' ? p.priceValue : null;
    if (price === null) return true; // don't drop items with unknown price
    if (min !== null && min !== undefined && price < min) return false;
    if (max !== null && max !== undefined && price > max) return false;
    return true;
  });
}

function buildSystemPromptSuffix(guardrails) {
  const parts = [];
  if (guardrails?.systemInstructions) {
    parts.push(`Store-specific instructions from the operator (follow these strictly): ${guardrails.systemInstructions}`);
  }
  if (guardrails?.minPrice || guardrails?.maxPrice) {
    const min = guardrails.minPrice ?? 'no minimum';
    const max = guardrails.maxPrice ?? 'no maximum';
    parts.push(`Only ever recommend products priced between ${min} and ${max}.`);
  }
  return parts.join('\n');
}

function resolveMaxRecommendations(guardrails, fallback) {
  const n = guardrails?.maxRecommendations;
  if (!n || !Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

module.exports = { checkBlocked, applyPriceCap, buildSystemPromptSuffix, resolveMaxRecommendations };
