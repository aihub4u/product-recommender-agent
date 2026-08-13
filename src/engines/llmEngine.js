const ruleEngine = require('./ruleEngine');
const { parseModelJson } = require('./providers');
const { runWithTools } = require('./toolLoop');

function buildCandidateList(query, products, vocabulary, previousFilters) {
  const filters = ruleEngine.extractFilters(query, vocabulary, previousFilters);

  // HARD gender filter — applied BEFORE scoring, so a wrong-gender product
  // can never enter the pool the LLM sees, regardless of keyword score.
  const genderSafe = filters.gender
    ? products.filter((p) => p.tagList.includes(filters.gender))
    : products;

  const scored = genderSafe
    .map((p) => ({ product: p, score: ruleEngine.scoreProduct(p, filters) }))
    .sort((a, b) => b.score - a.score);

  const withSignal = scored.filter((s) => s.score > 0).map((s) => s.product);
  const pool = withSignal.length >= 8 ? withSignal : genderSafe;

  // Returns filters alongside the pool now, so decide() below can persist
  // the merged (not stale) filters into session state.
  return { pool: pool.slice(0, 40), filters };
}

function condenseProduct(p) {
  return {
    id: p.id,
    name: p.name || '',
    category: p.category || '',
    gender: (p.tagList || []).find((t) => ['men', 'women', 'kids'].includes(t)) || '',
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

async function decide({ query, products, vocabulary, previousFilters, history, llmConfig, maxRecommendations = 3, systemPromptSuffix = '', skills = [] }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('LLM engine called without a valid provider/apiKey — this should not happen.');
  }

  const { pool, filters } = buildCandidateList(query, products, vocabulary, previousFilters);
  const candidates = pool.map(condenseProduct);
  const systemPrompt = buildSystemPrompt(maxRecommendations, systemPromptSuffix);
  const userMessage = buildUserMessage(query, history, candidates);

  const { rawText, usage } = await runWithTools({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, skills, jsonMode: true,
  });
  const parsed = parseModelJson(rawText);

  if (parsed.action === 'clarify') {
    return { action: 'clarify', question: parsed.question, filters, usage };
  }

  if (parsed.action === 'recommend') {
    const byId = new Map(products.map((p) => [p.id, p]));
    const resolved = (parsed.productIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      // belt-and-suspenders: re-verify gender even on the LLM's chosen ids,
      // in case it ever picks an id outside the pre-filtered candidate pool
      .filter((p) => !filters.gender || p.tagList.includes(filters.gender))
      .slice(0, maxRecommendations);

    if (resolved.length === 0) {
      throw new Error('LLM recommended ids not present in catalog or failed gender filter');
    }

    return { action: 'recommend', products: resolved, filters, reasoning: parsed.reasoning, usage };
  }

  throw new Error(`Unrecognized LLM action: ${parsed.action}`);
}

module.exports = { decide };
