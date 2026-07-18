function parseModelJson(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function callOpenAI({ apiKey, model, systemPrompt, userMessage, jsonMode = true }) {
  const body = {
    model: model || 'gpt-5.4-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.4,
    max_completion_tokens: 600,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

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
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no message content');
  const usage = {
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
  return { rawText: content, usage };
}

async function callAnthropic({ apiKey, model, systemPrompt, userMessage }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Anthropic returned no text content');
  const usage = {
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
  return { rawText: textBlock.text, usage };
}

/** Calls the configured provider, returns { rawText, usage }. jsonMode only affects OpenAI (forces JSON object output). */
async function callProvider({ provider, apiKey, model, systemPrompt, userMessage, jsonMode = true }) {
  if (provider === 'openai') return callOpenAI({ apiKey, model, systemPrompt, userMessage, jsonMode });
  if (provider === 'anthropic') return callAnthropic({ apiKey, model, systemPrompt, userMessage });
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

module.exports = { callProvider, parseModelJson };
