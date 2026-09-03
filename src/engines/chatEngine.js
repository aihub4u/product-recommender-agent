const { runWithTools } = require('./toolLoop');
const { parseModelJson } = require('./providers');
const { getAgentType } = require('../agentTypes');

function buildSystemPrompt(agentType, systemPromptSuffix, quickReplies) {
  const base = getAgentType(agentType).prompt || getAgentType('custom').prompt;
  const wantsQuickReplies = Boolean(quickReplies && quickReplies.enabled);

  let prompt = `${base}\n\nHow to talk: sound like a real, attentive person, not a script. Acknowledge what the user just said before responding. Never repeat yourself. Keep replies reasonably short — this is a chat conversation, not an essay.`;

  if (wantsQuickReplies) {
    const pool = (quickReplies.optionsPool || []).filter((o) => String(o || '').trim());
    const hasPool = pool.length > 0;

    prompt += `\n\nRespond with ONLY raw JSON, no markdown fences, no preamble, in exactly this shape:
{"message": "your reply text here", "options": ["short option 1", "short option 2"]}

"options" are WhatsApp quick-reply BUTTON LABELS shown to the user, not sentences.`;

    if (hasPool) {
      prompt += ` You MUST choose exactly 2 items from this approved list — copy the text EXACTLY as written below, do not paraphrase, shorten, or invent new options:
${pool.map((o) => `- "${o}"`).join('\n')}

Pick the 2 that are most relevant to what the user just asked or to a natural next question, given what's already been covered in this conversation. Never repeat an option you've already offered earlier in this conversation if a different relevant one from the list is available.`;
    } else {
      prompt += ` Rules:
- Exactly 2 options, each a COMPLETE short phrase of ${quickReplies.maxChars || 20} characters or fewer, INCLUDING spaces and punctuation. Count the characters before answering.
- Each must stand alone and make sense on its own as a button — never a phrase that only makes sense as the start of a longer sentence. If your first idea for a phrase doesn't fit the limit, don't shorten it by cutting words off the end — instead express the SAME idea more concisely (fewer/shorter words), or pick a simpler, narrower next-step idea that naturally fits.
  - GOOD (complete, fits, reads fine alone): "Check pricing", "Ask about parents", "See coverage", "Compare plans"
  - BAD (would need to be cut off to fit, or reads like a sentence fragment): "Check pricing for the family plan today", "What about my parents' coverage"
- They must be genuinely relevant to what was just discussed, and different from any option you've already offered earlier in this conversation.`;
    }

    prompt += `\n- Do NOT include a call-to-action / "sign up" style option yourself — that is added separately, automatically. Only provide the two most relevant next-step questions.
- Do NOT list these options inside "message" as well — they are shown separately by the app, so "message" should read as a complete, natural reply on its own without a trailing list of choices.`;
  } else {
    prompt += `\n\nRespond with plain conversational text only — no JSON, no markdown formatting, no preamble like "Sure, here's..."`;
  }

  if (systemPromptSuffix) {
    prompt += `\n\nOperator instructions for this specific agent (follow these strictly):\n${systemPromptSuffix}`;
  }
  return prompt;
}

function buildUserMessage(query, history) {
  const conversation = (history || [])
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');
  return conversation ? `Conversation so far:\n${conversation}\n\nLatest user message: ${query}` : query;
}

async function decide({ query, history, llmConfig, agentType, systemPromptSuffix = '', skills = [], conversionSignal = null, quickReplies = null }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('Chat engine called without a valid provider/apiKey — this should not happen.');
  }

  const wantsQuickReplies = Boolean(quickReplies && quickReplies.enabled);
  const systemPrompt = buildSystemPrompt(agentType, systemPromptSuffix, quickReplies);
  const userMessage = buildUserMessage(query, history);

  const { rawText, usage, signal } = await runWithTools({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, skills, jsonMode: wantsQuickReplies, conversionSignal,
  });

  if (!wantsQuickReplies) {
    return { action: 'reply', message: rawText.trim(), usage, signal };
  }

  try {
    const parsed = parseModelJson(rawText);
    return { action: 'reply', message: String(parsed.message || '').trim(), dynamicOptions: parsed.options, usage, signal };
  } catch (err) {
    // Model failed to follow the JSON contract — fall back to using the raw
    // text as the message rather than erroring the whole request; the
    // publicApi layer still guarantees a valid 3-item quickReplies array.
    return { action: 'reply', message: rawText.trim(), dynamicOptions: [], usage, signal };
  }
}

module.exports = { decide };
