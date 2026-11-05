// The Assistant through OpenRouter (openrouter.ai), whose API is the common "OpenAI-style" chat
// format; any service with that format works too (OPENROUTER_URL). Used for testing on free
// models. Same tools and cards as with Claude (assistant.js); the conversation is kept in this
// format. Note: providers of free models may log or train on what is sent.
import config from './config.js';
import { HttpError } from './errors.js';
import { settings } from './assistant-settings.js';

const CALL_TIMEOUT_MS = 90_000;
// Answers that mean "busy right now, try again": asked again after these waits.
const BUSY = new Set([500, 502, 503, 504]);
const RETRY_WAITS_MS = [2000, 5000];

const functions = (tools) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export const openrouterUserMessage = (text, image) => ({
  role: 'user',
  content: image
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
      ]
    : text,
});

/** Tool results: one "tool" message per call, as this format wants. */
export const openrouterToolResults = (results) =>
  results.map(({ use, content, isError }) => ({ role: 'tool', tool_call_id: use.id, content: isError ? `Error: ${content}` : content }));

function failure(status, body) {
  const said = body?.error?.message || '';
  const model = settings().openrouterModel;
  if (status === 401) return new HttpError(502, 'The OpenRouter API key isn’t valid. The admin can check it in Admin console → Assistant → AI settings.');
  if (status === 402) return new HttpError(502, 'OpenRouter says there is no credit left for this model. Choose a free model (ending in :free) in AI settings.');
  if (status === 429) return new HttpError(429, 'The free model’s limit has been reached for now. Try again in a minute (or tomorrow if the daily limit was used up).');
  if (status === 404 || /tool use|no endpoints|not a valid model|not found/i.test(said)) {
    return new HttpError(502, `The model “${model}” can’t be used${said ? `: ${said.slice(0, 200)}` : ''}. Choose a free model that supports tools on openrouter.ai/models and put its name in AI settings.`);
  }
  if (status >= 500) return new HttpError(502, 'OpenRouter or the model’s provider is overloaded right now. Try again in a minute.');
  return new HttpError(502, `OpenRouter couldn’t take that request${said ? `: ${said.slice(0, 200)}` : ` (${status})`}`);
}

/**
 * One model call, streamed. `onText(delta)` gets text as it arrives. Returns { message (for the
 * history), uses: [{ id, name, input }], stop, usage }.
 */
export async function callOpenRouter({ system, history, tools, onText, signal: cancel, fast = false }) {
  const { openrouterKey, openrouterModel, openrouterUrl } = settings();
  const started = Date.now();
  // Never wait forever (combined by hand: AbortSignal.any() needs Node 20).
  const both = new AbortController();
  const timer = setTimeout(() => both.abort(), CALL_TIMEOUT_MS);
  timer.unref?.();
  if (cancel?.aborted) both.abort();
  else cancel?.addEventListener('abort', () => both.abort(), { once: true });
  const tooSlow = () => new HttpError(504, 'The model took too long to answer. Try again, or ask something shorter.');
  const timedOut = () => both.signal.aborted && !cancel?.aborted;

  let res;
  const send = () =>
    fetch(`${openrouterUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openrouterKey}`,
        // OpenRouter shows these on its dashboard.
        ...(config.appUrl && { 'HTTP-Referer': config.appUrl }),
        'X-Title': 'Nextspace',
      },
      body: JSON.stringify({
        model: openrouterModel,
        messages: [{ role: 'system', content: system }, ...history],
        ...(tools.length && { tools: functions(tools), tool_choice: 'auto' }),
        stream: true,
        max_tokens: fast ? 1200 : 4096,
        usage: { include: true },
      }),
      signal: both.signal,
    });
  try {
    res = await send();
    // The model's provider is busy: it usually passes in seconds, so wait and ask again.
    for (const wait of RETRY_WAITS_MS) {
      if (!BUSY.has(res.status) || cancel?.aborted || both.signal.aborted) break;
      console.info(`[assistant] openrouter ${openrouterModel} busy (${res.status}), asking again in ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
      res = await send();
    }
  } catch (err) {
    clearTimeout(timer);
    if (cancel?.aborted) throw err;
    if (timedOut()) throw tooSlow();
    throw new HttpError(502, 'Couldn’t reach OpenRouter. Check the connection and try again.');
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw failure(res.status, await res.json().catch(() => null));
  }
  const firstByte = Date.now() - started;

  // Server-Sent Events: "data: {chunk}" lines, then "data: [DONE]".
  let text = '';
  const calls = []; // by index: { id, name, args }
  let finish = null;
  let usage = {};
  let streamError = null;
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.error) streamError = chunk.error;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      const slot = (calls[call.index ?? calls.length] ||= { id: '', name: '', args: '' });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.args += call.function.arguments;
    }
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) take(line);
    }
    if (buffer) take(buffer);
  } catch (err) {
    if (!cancel?.aborted && timedOut()) throw tooSlow();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (streamError) throw failure(Number(streamError.code) || 502, { error: streamError });

  const made = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  const uses = made.map((c) => {
    let input = {};
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = { _unreadable: c.args.slice(0, 200) };
    }
    return { id: c.id, name: c.name, input };
  });
  const stop = finish === 'content_filter' ? 'refusal' : uses.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end';
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  console.info(`[assistant] openrouter ${openrouterModel}: first reply ${firstByte} ms, total ${Date.now() - started} ms, ${uses.length} tool call(s)`);
  return {
    message: {
      role: 'assistant',
      content: text || null,
      ...(made.length && { tool_calls: made.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) }),
    },
    uses,
    stop,
    usage: { input: Math.max(0, (usage.prompt_tokens || 0) - cached), output: usage.completion_tokens || 0, cacheRead: cached, cacheWrite: 0 },
  };
}
