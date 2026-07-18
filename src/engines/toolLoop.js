const { callProvider } = require('./providers');
const { executeSkill } = require('../skillExecutor');
const { decrypt } = require('../crypto');

const MAX_ITERATIONS = 3;

function skillToToolDef(skill) {
  const properties = {};
  const required = [];
  (skill.params || []).forEach((p) => {
    properties[p.name] = { type: p.type || 'string', description: p.description || '' };
    if (p.required) required.push(p.name);
  });
  return {
    name: skill.name,
    description: skill.description,
    parameters: { type: 'object', properties, required },
  };
}

function buildToolResultMessage(provider, toolCall, resultText) {
  if (provider === 'openai') {
    return { role: 'tool', tool_call_id: toolCall.id, content: resultText };
  }
  // anthropic: batched below, this helper returns just the content block
  return { type: 'tool_result', tool_use_id: toolCall.id, content: resultText };
}

async function runSkill(skill, args) {
  try {
    const authValue = skill.authValueEnc ? decrypt(skill.authValueEnc) : null;
    const result = await executeSkill(skill, args, authValue);
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

/**
 * Runs the LLM with optional tool access, executing any requested skills
 * and feeding results back, up to MAX_ITERATIONS rounds. Returns
 * { rawText, usage } once the model produces a final (non-tool-call) reply.
 * Throws if the model never converges to a final answer within the limit —
 * callers should treat that the same as any other LLM failure.
 */
async function runWithTools({ provider, apiKey, model, systemPrompt, userMessage, skills = [], jsonMode = true }) {
  const enabledSkills = skills.filter((s) => s.enabled);
  const toolDefs = enabledSkills.map(skillToToolDef);
  const skillByName = new Map(enabledSkills.map((s) => [s.name, s]));

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const result = await callProvider({ provider, apiKey, model, messages, toolDefs, jsonMode });
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;

    if (result.type === 'text') {
      return { rawText: result.text, usage: totalUsage, toolRoundsUsed: i };
    }

    // Model requested one or more tool calls — execute them and continue the loop.
    messages.push(result.rawAssistantMessage);

    if (provider === 'openai') {
      for (const tc of result.toolCalls) {
        const skill = skillByName.get(tc.name);
        const resultText = skill ? await runSkill(skill, tc.args) : JSON.stringify({ error: `Unknown skill: ${tc.name}` });
        messages.push(buildToolResultMessage('openai', tc, resultText));
      }
    } else {
      // Anthropic wants all tool_result blocks for a turn batched into one user message.
      const blocks = [];
      for (const tc of result.toolCalls) {
        const skill = skillByName.get(tc.name);
        const resultText = skill ? await runSkill(skill, tc.args) : JSON.stringify({ error: `Unknown skill: ${tc.name}` });
        blocks.push(buildToolResultMessage('anthropic', tc, resultText));
      }
      messages.push({ role: 'user', content: blocks });
    }
  }

  throw new Error(`Tool-calling loop exceeded ${MAX_ITERATIONS} rounds without a final answer.`);
}

module.exports = { runWithTools };
