// The Assistant's Google Gemini connection (Gemini API, generativelanguage.googleapis.com), used
// for testing on Gemini's free tier. Same tools and cards as with Claude (assistant.js); the
// conversation is kept in Gemini's own format. Note: on the free tier Google may use what is
// sent to improve its products.
import config from './config.js';
import { HttpError } from './errors.js';
import { settings } from './assistant-settings.js';

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

const CALL_TIMEOUT_MS = 90_000;
let noThinkingLevel = false; // the model said it doesn't take a thinking level

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
  if (status === 400 && /api key/i.test(said)) return new HttpError(502, 'The Gemini API key isn’t valid. The admin can check it in Admin console → Assistant → AI settings.');
  if (status === 403) return new HttpError(502, 'Gemini refused the request. Check the Gemini key in Admin console → Assistant → AI settings.');
  if (/no longer available|not found|not supported|is deprecated/i.test(said)) {
    return new HttpError(502, `The Gemini model “${settings().geminiModel}” can’t be used: ${said.slice(0, 200)} The admin can choose another in AI settings.`);
  }
  if (status >= 500) return new HttpError(502, 'Gemini is overloaded right now. Try again in a minute.');
  return new HttpError(502, `Gemini couldn’t take that request${said ? `: ${said.slice(0, 200)}` : ` (${status})`}`);
}

/**
 * One model call, streamed. `onText(delta)` gets text as it arrives. Returns { message (for the
 * history, as Gemini sent it), uses: [{ id, name, input }], stop, usage }.
 */
export async function callGemini({ system, history, tools, onText, signal: cancel }) {
  const { geminiKey, geminiModel, geminiUrl, geminiThinking } = settings();
  const started = Date.now();
  // Never wait forever: a call that takes longer than this ends with a message.
  // (Combined by hand: AbortSignal.any() needs Node 20, and the host may run an older one.)
  const both = new AbortController();
  const timer = setTimeout(() => both.abort(), CALL_TIMEOUT_MS);
  timer.unref?.();
  const timeout = { get aborted() { return both.signal.aborted && !cancel?.aborted; } };
  if (cancel?.aborted) both.abort();
  else cancel?.addEventListener('abort', () => both.abort(), { once: true });
  const signal = both.signal;
  const tooSlow = () => new HttpError(504, 'Gemini took too long to answer. Try again, or ask something shorter.');
  const send = (thinking) =>
    fetch(`${geminiUrl}/models/${encodeURIComponent(geminiModel)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: history,
        ...(tools.length && { tools: declarations(tools), toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }),
        generationConfig: { maxOutputTokens: 8192, ...(thinking && { thinkingConfig: { thinkingLevel: thinking } }) },
      }),
      signal,
    });
  let res;
  try {
    const thinking = geminiThinking !== 'off' && !noThinkingLevel ? geminiThinking : null;
    res = await send(thinking);
    // A model that doesn't take a thinking level: ask again without it, and remember.
    if (thinking && res.status === 400) {
      const said = await res.clone().json().catch(() => null);
      if (/thinking/i.test(said?.error?.message || '')) {
        noThinkingLevel = true;
        res = await send(null);
      }
    }
  } catch (err) {
    if (cancel?.aborted) throw err;
    if (timeout.aborted) throw tooSlow();
    throw new HttpError(502, 'Couldn’t reach Gemini. Check the connection and try again.');
  }
  if (!res.ok) throw failure(res.status, await res.json().catch(() => null));
  const firstByte = Date.now() - started;

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
    let value;
    let done;
    try {
      ({ value, done } = await reader.read());
    } catch (err) {
      if (!cancel?.aborted && timeout.aborted) throw tooSlow();
      throw err;
    }
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
  clearTimeout(timer);
  // In the host's logs: where the time goes (no message content).
  console.info(`[assistant] gemini ${geminiModel}: first reply ${firstByte} ms, total ${Date.now() - started} ms, ${uses.length} tool call(s), ${usage.thoughtsTokenCount || 0} thinking tokens`);
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
