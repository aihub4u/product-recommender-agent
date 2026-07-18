function parseModelJson(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function safeParseArgs(argsStr) {
  try { return JSON.parse(argsStr || '{}'); } catch (e) { return {}; }
}

function buildOpenAITools(toolDefs) {
  return toolDefs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function buildAnthropicTools(toolDefs) {
  return toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

async function callOpenAI({ apiKey, model, messages, toolDefs, jsonMode = true }) {
  const hasTools = toolDefs && toolDefs.length > 0;
  const body = {
    model: model || 'gpt-5.4-mini',
    messages,
    temperature: 0.4,
    max_completion_tokens: 700,
  };
  if (hasTools) body.tools = buildOpenAITools(toolDefs);
  // Forcing JSON mode alongside tool calls is unreliable across models, so
  // only force it when there are no tools in play for this turn.
  if (jsonMode && !hasTools) body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('OpenAI returned no message');
  const usage = {
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      type: 'tool_calls',
      toolCalls: message.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, args: safeParseArgs(tc.function.arguments) })),
      usage,
      rawAssistantMessage: message,
    };
  }
  return { type: 'text', text: message.content || '', usage };
}

async function callAnthropic({ apiKey, model, messages, toolDefs }) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const hasTools = toolDefs && toolDefs.length > 0;

  const body = {
    model: model || 'claude-sonnet-5',
    max_tokens: 700,
    system: systemMsg ? systemMsg.content : undefined,
    messages: rest,
  };
  if (hasTools) body.tools = buildAnthropicTools(toolDefs);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const usage = {
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };

  const toolUseBlocks = (data.content || []).filter((b) => b.type === 'tool_use');
  if (toolUseBlocks.length > 0) {
    return {
      type: 'tool_calls',
      toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      usage,
      rawAssistantMessage: { role: 'assistant', content: data.content },
    };
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return { type: 'text', text: textBlock ? textBlock.text : '', usage };
}

/** Normalized call across providers. Returns { type: 'text'|'tool_calls', ... , usage }. */
async function callProvider({ provider, apiKey, model, messages, toolDefs, jsonMode = true }) {
  if (provider === 'openai') return callOpenAI({ apiKey, model, messages, toolDefs, jsonMode });
  if (provider === 'anthropic') return callAnthropic({ apiKey, model, messages, toolDefs });
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

module.exports = { callProvider, parseModelJson };
