const ruleEngine = require('./ruleEngine');
const { parseModelJson } = require('./providers');
const { runWithTools } = require('./toolLoop');

function buildCandidateList(query, products, vocabulary, previousFilters, excludeIds = []) {
  const filters = ruleEngine.extractFilters(query, vocabulary, previousFilters);
  const excludeSet = new Set(excludeIds);
  const notShown = products.filter((p) => !excludeSet.has(p.id));

  // HARD gender filter — applied BEFORE scoring, so a wrong-gender product
  // can never enter the pool the LLM sees, regardless of keyword score.
  const genderSafe = filters.gender
    ? notShown.filter((p) => p.tagList.includes(filters.gender))
    : notShown;

  const scored = genderSafe
    .map((p) => ({ product: p, score: ruleEngine.scoreProduct(p, filters) }))
    .sort((a, b) => b.score - a.score);

  const withSignal = scored.filter((s) => s.score > 0).map((s) => s.product);
  const pool = withSignal.length >= 8 ? withSignal : genderSafe;

  // Detect if exclusion (not gender/other filters) is why the pool is thin —
  // used below to give an honest "I've shown you everything" message instead
  // of pretending to search further.
  const wouldHaveMatchedIfShown = products.some(
    (p) => excludeSet.has(p.id)
      && (!filters.gender || p.tagList.includes(filters.gender))
      && ruleEngine.productMatchesFilters(p, filters),
  );

  return { pool: pool.slice(0, 40), filters, exhausted: pool.length === 0 && wouldHaveMatchedIfShown };
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

function resolveShownProducts(products, excludeIds) {
  const excludeSet = new Set(excludeIds);
  return products.filter((p) => excludeSet.has(p.id)).map(condenseProduct);
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

Your job: respond with exactly one of three actions —
1. "clarify" — ask ONE short, natural clarifying question if the request is too vague or ambiguous to confidently recommend from.
2. "recommend" — recommend up to ${maxRecommendations} NEW products from the "Candidate catalog" that best match what they want.
3. "info" — answer a question, comparison, or opinion request about product(s) that were ALREADY shown earlier in this conversation (they appear in "Previously shown products" below). Use this whenever the user is asking about existing picks rather than asking for different/more/new ones — e.g. "which one is better?", "what's the difference between X and Y?", "tell me more about the first one", "is that one true to size?". Reference ONLY the exact ids from "Previously shown products" for this action — never substitute a different product, and never pull from the fresh candidate catalog for an "info" response.

How to tell "recommend" apart from "info": if the user wants to see something different/more/else, use "recommend" with the fresh candidate catalog. If the user is asking a question ABOUT products they already have in front of them, use "info" and reference those exact previously-shown ids — do not swap in new products just because they're unavailable for re-recommending.

Rules:
- Only recommend products that appear in the given candidate catalog (use their exact "id").
- Only reference products in an "info" response that appear in "Previously shown products" (use their exact "id").
- Prefer recommending over asking again and again — only ask a clarifying question if you genuinely cannot narrow down to good options.
- Never invent products or ids that are not in one of the two given lists.
- Respond with ONLY raw JSON, no markdown fences, no preamble, matching exactly one of these shapes:
  {"action": "clarify", "question": "..."}
  {"action": "recommend", "productIds": ["id1", "id2"], "reasoning": "one short sentence"}
  {"action": "info", "productIds": ["id1", "id2"], "message": "your answer to their question, referencing the products naturally"}`;

  if (systemPromptSuffix) {
    prompt += `\n\n${systemPromptSuffix}`;
  }
  return prompt;
}

function buildUserMessage(query, history, candidates, shownProducts) {
  const conversation = (history || [])
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
  return [
    conversation ? `Conversation so far:\n${conversation}\n` : '',
    `Latest user message: ${query}`,
    `\nCandidate catalog — NEW products available to recommend (JSON):\n${JSON.stringify(candidates)}`,
    `\nPreviously shown products — already shown to the user this session, for "info" answers only, do NOT re-recommend these (JSON):\n${JSON.stringify(shownProducts)}`,
  ].join('\n');
}

async function decide({ query, products, vocabulary, previousFilters, excludeIds = [], history, llmConfig, maxRecommendations = 3, systemPromptSuffix = '', skills = [] }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('LLM engine called without a valid provider/apiKey — this should not happen.');
  }

  const { pool, filters, exhausted } = buildCandidateList(query, products, vocabulary, previousFilters, excludeIds);

  if (exhausted) {
    return {
      action: 'clarify',
      question: "I've actually shown you everything I have that matches this — want to loosen the budget, style, or category so I can find more?",
      filters,
    };
  }

  const candidates = pool.map(condenseProduct);
  const shownProducts = resolveShownProducts(products, excludeIds);
  const systemPrompt = buildSystemPrompt(maxRecommendations, systemPromptSuffix);
  const userMessage = buildUserMessage(query, history, candidates, shownProducts);

  const { rawText, usage } = await runWithTools({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, skills, jsonMode: true,
  });
  const parsed = parseModelJson(rawText);

  if (parsed.action === 'clarify') {
    return { action: 'clarify', question: parsed.question, filters, usage };
  }

  if (parsed.action === 'info') {
    const byId = new Map(products.map((p) => [p.id, p]));
    const resolved = (parsed.productIds || []).map((id) => byId.get(id)).filter(Boolean);
    return { action: 'info', message: parsed.message, products: resolved, filters, usage };
  }

  if (parsed.action === 'recommend') {
    const byId = new Map(products.map((p) => [p.id, p]));
    const excludeSet = new Set(excludeIds);
    const resolved = (parsed.productIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      // belt-and-suspenders: re-verify gender and non-repetition even on the
      // LLM's chosen ids, in case it picks something outside the pre-filtered pool
      .filter((p) => !filters.gender || p.tagList.includes(filters.gender))
      .filter((p) => !excludeSet.has(p.id))
      .slice(0, maxRecommendations);

    if (resolved.length === 0) {
      throw new Error('LLM recommended ids not present in catalog or failed gender filter');
    }

    return { action: 'recommend', products: resolved, filters, reasoning: parsed.reasoning, usage };
  }

  throw new Error(`Unrecognized LLM action: ${parsed.action}`);
}

module.exports = { decide };
