const ruleEngine = require('./ruleEngine');
const { callProvider, parseModelJson } = require('./providers');

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

function buildSystemPrompt(maxRecommendations, systemPromptSuffix) {
  let prompt = `You are a warm, attentive shopping assistant — think of a genuinely helpful in-store sales associate, not a form to fill out. You are given:
- A conversation history with the user
- A candidate product catalog (subset of a larger store, already loosely relevant)

How to talk:
- Acknowledge what the customer just told you before asking anything else — react briefly and naturally to context they share (an occasion, a relationship, an emotion), the way a real person would, without gushing or sounding scripted.
- Never repeat a question you've already asked in the same or near-identical phrasing. If you already asked a compound question and the customer only answered part of it, ask ONLY for what's still missing, referencing what they already told you rather than restarting from scratch.
- If the user's message is just a greeting or small talk (e.g. "hi", "hello") with nothing about what they want, respond warmly and ask what they're shopping for — do not try to recommend anything yet, and do not use a stiff or templated-sounding line.
- Vary your phrasing turn to turn. Sound like a conversation, not a repeated script.

Your job: either ask ONE short, natural clarifying question if the user's request is too vague or ambiguous to confidently recommend from, OR recommend up to ${maxRecommendations} products from the given catalog that best match what they want.

Rules:
- Only recommend products that appear in the given catalog (use their exact "id").
- Prefer recommending over asking again and again — only ask a clarifying question if you genuinely cannot narrow down to good options.
- Never invent products or ids that are not in the catalog.
- Respond with ONLY raw JSON, no markdown fences, no preamble, matching exactly one of these shapes:
  {"action": "clarify", "question": "..."}
  {"action": "recommend", "productIds": ["id1", "id2"], "reasoning": "one short sentence"}`;

  if (systemPromptSuffix) {
    prompt += `\n\n${systemPromptSuffix}`;
  }
  return prompt;
}

function buildUserMessage(query, history, candidates) {
  const conversation = (history || [])
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
  return [
    conversation ? `Conversation so far:\n${conversation}\n` : '',
    `Latest user message: ${query}`,
    `\nCandidate catalog (JSON):\n${JSON.stringify(candidates)}`,
  ].join('\n');
}

async function decide({ query, products, vocabulary, previousFilters, history, llmConfig, maxRecommendations = 3, systemPromptSuffix = '' }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('LLM engine called without a valid provider/apiKey — this should not happen.');
  }

  const candidates = buildCandidateList(query, products, vocabulary, previousFilters).map(condenseProduct);
  const systemPrompt = buildSystemPrompt(maxRecommendations, systemPromptSuffix);
  const userMessage = buildUserMessage(query, history, candidates);

  const { rawText, usage } = await callProvider({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, jsonMode: true,
  });
  const parsed = parseModelJson(rawText);

  if (parsed.action === 'clarify') {
    return { action: 'clarify', question: parsed.question, filters: previousFilters || {}, usage };
  }

  if (parsed.action === 'recommend') {
    const byId = new Map(products.map((p) => [p.id, p]));
    const resolved = (parsed.productIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, maxRecommendations);

    if (resolved.length === 0) {
      throw new Error('LLM recommended ids not present in catalog');
    }

    return { action: 'recommend', products: resolved, filters: previousFilters || {}, reasoning: parsed.reasoning, usage };
  }

  throw new Error(`Unrecognized LLM action: ${parsed.action}`);
}

module.exports = { decide };
