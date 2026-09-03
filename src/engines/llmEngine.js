const ruleEngine = require('./ruleEngine');
const { parseModelJson } = require('./providers');
const { runWithTools } = require('./toolLoop');

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

function buildSystemPrompt(maxRecommendations, systemPromptSuffix, conversionSignal, quickReplies) {
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

  if (conversionSignal && conversionSignal.enabled && conversionSignal.name) {
    prompt += `\n\nIf, at any point, you call the "${conversionSignal.name}" tool, you must still produce your final reply in the normal raw JSON shape above (clarify or recommend) afterward — the tool call is tracked separately and does not change your response format.`;
  }

  if (quickReplies && quickReplies.enabled) {
    const pool = (quickReplies.optionsPool || []).filter((o) => String(o || '').trim());
    const hasPool = pool.length > 0;

    prompt += `\n\nAlso include an "options" field in your JSON response (both shapes above): an array of exactly 2 WhatsApp quick-reply BUTTON LABELS shown to the user.`;

    if (hasPool) {
      prompt += ` You MUST choose exactly 2 items from this approved list — copy the text EXACTLY as written, do not paraphrase, shorten, or invent new options:
${pool.map((o) => `- "${o}"`).join('\n')}

Pick the 2 most relevant to what was just discussed, and different from anything already offered earlier in the conversation. Example full response: {"action": "clarify", "question": "...", "options": ["${pool[0]}", "${pool[1] || pool[0]}"]}`;
    } else {
      prompt += ` Each must be a COMPLETE short phrase of ${quickReplies.maxChars || 20} characters or fewer (including spaces/punctuation) that makes sense standing alone as a button — not a sentence. If your first idea for a phrase doesn't fit, express the same idea more concisely rather than writing a longer phrase and letting it be cut off — a truncated fragment is worse than a shorter idea. They must be genuinely relevant to what was just discussed and different from anything already offered earlier in the conversation. Good examples: "Under 5000?", "Something festive?", "Compare styles". Bad (too long / reads like a cut-off sentence): "What's your budget for this occasion". Example full response: {"action": "clarify", "question": "...", "options": ["Under 5000?", "Something festive?"]}`;
    }

    prompt += ` Do NOT include a call-to-action / "buy now" style option yourself — that is added separately, automatically.`;
  }

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

async function decide({ query, products, vocabulary, previousFilters, history, llmConfig, maxRecommendations = 3, systemPromptSuffix = '', skills = [], conversionSignal = null, quickReplies = null }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('LLM engine called without a valid provider/apiKey — this should not happen.');
  }

  const candidates = buildCandidateList(query, products, vocabulary, previousFilters).map(condenseProduct);
  const systemPrompt = buildSystemPrompt(maxRecommendations, systemPromptSuffix, conversionSignal, quickReplies);
  const userMessage = buildUserMessage(query, history, candidates);

  const { rawText, usage, signal } = await runWithTools({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, skills, jsonMode: true, conversionSignal,
  });
  const parsed = parseModelJson(rawText);

  if (parsed.action === 'clarify') {
    return { action: 'clarify', question: parsed.question, filters: previousFilters || {}, usage, signal, dynamicOptions: parsed.options };
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

    return { action: 'recommend', products: resolved, filters: previousFilters || {}, reasoning: parsed.reasoning, usage, signal, dynamicOptions: parsed.options };
  }

  throw new Error(`Unrecognized LLM action: ${parsed.action}`);
}

module.exports = { decide };
