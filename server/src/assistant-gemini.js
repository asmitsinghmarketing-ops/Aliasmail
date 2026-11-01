// The Assistant's Google Gemini connection (Gemini API, generativelanguage.googleapis.com), used
// for testing on Gemini's free tier. Same tools and cards as with Claude (assistant.js); the
// conversation is kept in Gemini's own format. Note: on the free tier Google may use what is
// sent to improve its products.
import config from './config.js';
import { HttpError } from './errors.js';

// Gemini takes a subset of JSON Schema for function parameters.
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'enum', 'items', 'minimum', 'maximum']);
function schema(value) {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, schema(s)]));
    else if (SCHEMA_KEYS.has(key)) out[key] = schema(v);
  }
  return out;
}

const declarations = (tools) => [{
  functionDeclarations: tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.input_schema.properties || {}).length && { parameters: schema(t.input_schema) }),
  })),
}];

export const geminiUserMessage = (text) => ({ role: 'user', parts: [{ text }] });

/** Tool results, answered in one turn: [{ use: { id, name }, content, isError }]. */
export const geminiToolResults = (results) => ({
  role: 'user',
  parts: results.map(({ use, content, isError }) => ({
    functionResponse: { ...(use.id && !use.id.startsWith('g_') && { id: use.id }), name: use.name, response: isError ? { error: content } : { result: content } },
  })),
});

function failure(status, body) {
  const said = body?.error?.message || '';
  if (status === 429) return new HttpError(429, 'Gemini’s free limit has been used up for now. Try again in a minute (or tomorrow if the daily limit was reached).');
  if (status === 400 && /api key/i.test(said)) return new HttpError(502, 'The Gemini API key isn’t valid. The admin needs to check GEMINI_API_KEY.');
  if (status === 403) return new HttpError(502, 'Gemini refused the request. Check that GEMINI_API_KEY is right and the Gemini API is enabled.');
  if (/no longer available|not found|not supported|is deprecated/i.test(said)) {
    return new HttpError(502, `The Gemini model “${config.assistant.geminiModel}” can’t be used: ${said.slice(0, 200)} The admin can choose another with GEMINI_MODEL.`);
  }
  if (status >= 500) return new HttpError(502, 'Gemini is overloaded right now. Try again in a minute.');
  return new HttpError(502, `Gemini couldn’t take that request${said ? `: ${said.slice(0, 200)}` : ` (${status})`}`);
}

/**
 * One model call, streamed. `onText(delta)` gets text as it arrives. Returns { message (for the
 * history, as Gemini sent it), uses: [{ id, name, input }], stop, usage }.
 */
export async function callGemini({ system, history, tools, onText, signal }) {
  const { geminiKey, geminiModel, geminiUrl } = config.assistant;
  let res;
  try {
    res = await fetch(`${geminiUrl}/models/${encodeURIComponent(geminiModel)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: history,
        tools: declarations(tools),
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { maxOutputTokens: 8192 },
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new HttpError(502, 'Couldn’t reach Gemini. Check the connection and try again.');
  }
  if (!res.ok) throw failure(res.status, await res.json().catch(() => null));

  // Server-Sent Events: each "data:" line is a piece of the answer.
  const parts = [];
  let finish = null;
  let blocked = false;
  let usage = {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const chunk = JSON.parse(line.slice(5).trim());
    if (chunk.promptFeedback?.blockReason) blocked = true;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) finish = candidate.finishReason;
    for (const part of candidate.content?.parts || []) {
      parts.push(part);
      if (typeof part.text === 'string' && !part.thought && part.text) onText(part.text);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) take(line);
  }
  if (buffer) take(buffer);

  const uses = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({ id: p.functionCall.id || `g_${Date.now()}_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} }));
  const stop = blocked || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(finish)
    ? 'refusal'
    : uses.length
      ? 'tool_use'
      : finish === 'MAX_TOKENS'
        ? 'max_tokens'
        : 'end';
  const cached = usage.cachedContentTokenCount || 0;
  return {
    // Kept exactly as sent (thought signatures included): Gemini needs them back unchanged.
    message: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
    uses,
    stop,
    usage: {
      input: Math.max(0, (usage.promptTokenCount || 0) - cached),
      output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
      cacheRead: cached,
      cacheWrite: 0,
    },
  };
}
