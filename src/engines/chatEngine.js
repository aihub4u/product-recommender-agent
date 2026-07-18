const { runWithTools } = require('./toolLoop');
const { getAgentType } = require('../agentTypes');

function buildSystemPrompt(agentType, systemPromptSuffix) {
  const base = getAgentType(agentType).prompt || getAgentType('custom').prompt;
  let prompt = `${base}

How to talk: sound like a real, attentive person, not a script. Acknowledge what the user just said before responding. Never repeat yourself. Keep replies reasonably short — this is a chat conversation, not an essay.

Respond with plain conversational text only — no JSON, no markdown formatting, no preamble like "Sure, here's..."`;

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

async function decide({ query, history, llmConfig, agentType, systemPromptSuffix = '', skills = [] }) {
  if (!llmConfig || !llmConfig.provider || llmConfig.provider === 'none' || !llmConfig.apiKey) {
    throw new Error('Chat engine called without a valid provider/apiKey — this should not happen.');
  }

  const systemPrompt = buildSystemPrompt(agentType, systemPromptSuffix);
  const userMessage = buildUserMessage(query, history);

  const { rawText, usage } = await runWithTools({
    provider: llmConfig.provider, apiKey: llmConfig.apiKey, model: llmConfig.model,
    systemPrompt, userMessage, skills, jsonMode: false,
  });

  return { action: 'reply', message: rawText.trim(), usage };
}

module.exports = { decide };
