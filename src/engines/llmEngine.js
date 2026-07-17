const config = require('../config');
const ruleEngine = require('./ruleEngine');

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

// Keep the catalog sent to the LLM small: pre-filter with the rule engine's
// keyword/tag matching so we're not shipping the entire sheet as tokens on
// every request. Falls back to the first N products if pre-filtering
// yields too few candidates (e.g. very first, very vague turn).
function buildCandidateList(query, products, vocabulary, previousFilters) {
  const filters = ruleEngine.extractFilters(query, vocabulary, previousFilters);
  const scored = products
    .map((p) => ({ product: p, score: ruleEngine.scoreProduct(p, filters) }))
    .sort((a, b) => b.score - a.score);

  const withSignal = scored.filter((s) => s.score > 0).map((s) => s.product);
  const pool = withSignal.length >= 8 ? withSignal : products;
  return pool.slice(0, 40);
}

function condenseProduct(p) {
  return {
    id: p.id,
    name: p.name || '',
    category: p.category || '',
    price: p.priceValue !== null ? p.priceValue : p.price || '',
    description: (p.description || '').slice(0, 200),
    tags: p.tagList,
  };
}

const SYSTEM_PROMPT = `You are a product recommendation assistant embedded in an API. You are given:
- A conversation history with the user
- A candidate product catalog (subset of a larger store, already loosely relevant)

Your job: either ask ONE short, specific clarifying question if the user's request is too vague or ambiguous to confidently recommend from, OR recommend up to 3 products from the given catalog that best match what they want.

Rules:
- Only recommend products that appear in the given catalog (use their exact "id").
- Prefer recommending over asking again and again — only ask a clarifying question if you genuinely cannot narrow down to good options (e.g. no category/price/preference signal, or the catalog has many equally plausible matches).
- Never invent products or ids that are not in the catalog.
- Respond with ONLY raw JSON, no markdown fences, no preamble, matching exactly one of these shapes:
  {"action": "clarify", "question": "..."}
  {"action": "recommend", "productIds": ["id1", "id2", "id3"], "reasoning": "one short sentence"}`;

async function decide({ query, products, vocabulary, previousFilters, history }) {
  const candidates = buildCandidateList(query, products, vocabulary, previousFilters).map(condenseProduct);

  const conversation = (history || [])
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');

  const userMessage = [
    conversation ? `Conversation so far:\n${conversation}\n` : '',
    `Latest user message: ${query}`,
    `\nCandidate catalog (JSON):\n${JSON.stringify(candidates)}`,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_completion_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no message content');

  const parsed = JSON.parse(content);

  if (parsed.action === 'clarify') {
    return { action: 'clarify', question: parsed.question, filters: previousFilters || {} };
  }

  if (parsed.action === 'recommend') {
    const byId = new Map(products.map((p) => [p.id, p]));
    const resolved = (parsed.productIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, config.maxRecommendations);

    if (resolved.length === 0) {
      // LLM claimed a recommendation but ids didn't resolve — fall back safely.
      throw new Error('LLM recommended ids not present in catalog');
    }

    return { action: 'recommend', products: resolved, filters: previousFilters || {}, reasoning: parsed.reasoning };
  }

  throw new Error(`Unrecognized LLM action: ${parsed.action}`);
}

module.exports = { decide };
