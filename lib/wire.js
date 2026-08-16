/**
 * Wire layer for the Grok CLI chat proxy: harness `GenerateOptions` to
 * Responses-API / chat-completions request bodies, raw SSE parsing, and
 * provider event translation into the harness `StreamChunk` protocol.
 * @module dsh-llm-grok-oauth/wire
 */
import { LlmError } from '@deepseek-ai/dsh-llm';

/** Flatten one content-block list to plain text for wire slots that take text. */
function flattenText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text);
    else if (block.type === 'image') parts.push('[image attachment omitted]');
  }
  return parts.join('\n');
}

/** Tool-result output text; empty results cross the wire as a literal marker. */
function toolOutputText(block) {
  const text = flattenText(block.content);
  const output = text.length > 0 ? text : '(no output)';
  return block.isError === true ? `[tool error] ${output}` : output;
}

//#region Responses API

/** Serialize one request for `POST {base}/responses`. */
export function serializeResponsesRequest(options, defaults) {
  const input = [];
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.length === 0) continue;
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text }],
          });
        } else if (block.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: String(block.id),
            name: block.name,
            arguments: block.arguments,
          });
        }
        // reasoning blocks are not replayed: the proxy is stateless and does
        // not require reasoning passback for tool round trips.
      }
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        input.push({
          type: 'function_call_output',
          call_id: String(block.toolCallId),
          output: toolOutputText(block),
        });
      }
      continue;
    }
    const text = flattenText(message.content);
    if (text.length === 0) continue;
    input.push({
      type: 'message',
      role: message.role === 'system' ? 'system' : 'user',
      content: [{ type: 'input_text', text }],
    });
  }
  const body = {
    model: options.model,
    stream: true,
    store: false,
    input,
  };
  if (options.system !== undefined && options.system.length > 0) body.instructions = options.system;
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  const effort = options.reasoningEffort ?? defaults.reasoningEffort;
  if (effort !== undefined) body.reasoning = { effort: String(effort) };
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

/**
 * Translate Responses-API SSE events into `StreamChunk`s. Emits usage before
 * the terminal finish and nothing after it.
 */
export async function* translateResponses(events) {
  let nextIndex = 0;
  /** key -> { index, type, text, id, name, args } */
  const open = new Map();
  let sawToolCall = false;
  let usage;
  let finished = false;

  const begin = (key, blockType, extra) => {
    const state = { index: nextIndex++, type: blockType, text: '', args: '', ...extra };
    open.set(key, state);
    return state;
  };
  const endBlock = function* (key) {
    const state = open.get(key);
    if (state === undefined) return;
    open.delete(key);
    if (state.type === 'text') {
      yield { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } };
    } else if (state.type === 'reasoning') {
      yield { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } };
    } else {
      yield {
        type: 'block-end',
        index: state.index,
        block: { type: 'tool-call', id: state.id, name: state.name ?? '', arguments: state.args },
      };
    }
  };
  const usageOf = (response) => {
    const wire = response?.usage;
    if (wire === undefined || wire === null) return undefined;
    const cached = wire.input_tokens_details?.cached_tokens ?? 0;
    return {
      inputTokens: Math.max(0, (wire.input_tokens ?? 0) - cached),
      outputTokens: wire.output_tokens ?? 0,
      ...(cached > 0 ? { cacheReadTokens: cached } : {}),
      ...(wire.output_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: wire.output_tokens_details.reasoning_tokens }
        : {}),
    };
  };

  for await (const event of events) {
    if (finished) break;
    const kind = event.type;
    if (kind === 'response.output_item.added') {
      const item = event.item ?? {};
      if (item.type === 'function_call') {
        sawToolCall = true;
        const key = `item:${event.output_index}:fc`;
        const state = begin(key, 'tool-call', { id: item.call_id ?? item.id ?? `call_${event.output_index}`, name: item.name });
        yield { type: 'block-start', index: state.index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: '' };
        if (typeof item.arguments === 'string' && item.arguments.length > 0) {
          state.args += item.arguments;
          yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: item.arguments };
        }
      }
    } else if (kind === 'response.output_text.delta') {
      const key = `text:${event.output_index}:${event.content_index ?? 0}`;
      let state = open.get(key);
      if (state === undefined) {
        state = begin(key, 'text');
        yield { type: 'block-start', index: state.index, blockType: 'text' };
      }
      const delta = event.delta ?? '';
      if (delta.length > 0) {
        state.text += delta;
        yield { type: 'text-delta', index: state.index, text: delta };
      }
    } else if (kind === 'response.output_text.done' || kind === 'response.content_part.done') {
      const key = `text:${event.output_index}:${event.content_index ?? 0}`;
      const state = open.get(key);
      if (state !== undefined && kind === 'response.output_text.done' && typeof event.text === 'string') {
        state.text = event.text;
      }
      yield* endBlock(key);
    } else if (kind === 'response.reasoning_text.delta' || kind === 'response.reasoning_summary_text.delta') {
      const key = `reasoning:${event.output_index}:${event.summary_index ?? event.content_index ?? 0}`;
      let state = open.get(key);
      if (state === undefined) {
        state = begin(key, 'reasoning');
        yield { type: 'block-start', index: state.index, blockType: 'reasoning' };
      }
      const delta = event.delta ?? '';
      if (delta.length > 0) {
        state.text += delta;
        yield { type: 'reasoning-delta', index: state.index, text: delta };
      }
    } else if (kind === 'response.reasoning_text.done' || kind === 'response.reasoning_summary_text.done') {
      yield* endBlock(`reasoning:${event.output_index}:${event.summary_index ?? event.content_index ?? 0}`);
    } else if (kind === 'response.function_call_arguments.delta') {
      const key = `item:${event.output_index}:fc`;
      const state = open.get(key);
      if (state !== undefined) {
        const delta = event.delta ?? '';
        if (delta.length > 0) {
          state.args += delta;
          yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: delta };
        }
      }
    } else if (kind === 'response.output_item.done') {
      const item = event.item ?? {};
      if (item.type === 'function_call') {
        const key = `item:${event.output_index}:fc`;
        const state = open.get(key);
        if (state !== undefined) {
          if (typeof item.arguments === 'string' && item.arguments.length > 0) state.args = item.arguments;
          if (typeof item.name === 'string') state.name = item.name;
          yield* endBlock(key);
        }
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        // Close any text parts the proxy did not close explicitly.
        for (let contentIndex = 0; contentIndex < item.content.length; contentIndex += 1) {
          const key = `text:${event.output_index}:${contentIndex}`;
          if (open.has(key)) yield* endBlock(key);
        }
      }
    } else if (kind === 'response.completed' || kind === 'response.incomplete' || kind === 'response.failed') {
      for (const key of [...open.keys()]) yield* endBlock(key);
      usage = usageOf(event.response) ?? usage;
      if (usage !== undefined) yield { type: 'usage', usage };
      finished = true;
      if (kind === 'response.completed') {
        yield { type: 'finish', reason: { kind: sawToolCall ? 'tool-calls' : 'stop' } };
      } else if (kind === 'response.incomplete') {
        const reason = event.response?.incomplete_details?.reason;
        if (reason === 'max_output_tokens') {
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
        } else {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: `Grok response incomplete: ${reason ?? 'unknown reason'}`, code: 'INCOMPLETE' },
            },
          };
        }
      } else {
        const error = event.response?.error;
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: error?.message ?? 'Grok response failed',
              code: typeof error?.code === 'string' && error.code.length > 0 ? error.code.toUpperCase() : 'PROVIDER_FAILED',
            },
          },
        };
      }
    } else if (kind === 'error') {
      finished = true;
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: event.message ?? 'Grok stream error event', code: 'PROVIDER_FAILED' },
        },
      };
    }
  }
  if (!finished) throw new LlmError('Grok stream closed before a terminal response event', 'STREAM_CLOSED');
}

//#endregion

//#region chat completions

/** Serialize one request for `POST {base}/chat/completions`. */
export function serializeChatRequest(options, defaults) {
  const messages = [];
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system });
  }
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      const text = flattenText(message.content);
      const toolCalls = message.content
        .filter((block) => block.type === 'tool-call')
        .map((block) => ({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        }));
      const entry = { role: 'assistant', content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      if (entry.content !== null || toolCalls.length > 0) messages.push(entry);
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        messages.push({ role: 'tool', tool_call_id: String(block.toolCallId), content: toolOutputText(block) });
      }
      continue;
    }
    const text = flattenText(message.content);
    if (text.length === 0) continue;
    messages.push({ role: message.role === 'system' ? 'system' : 'user', content: text });
  }
  const body = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
  };
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  const effort = options.reasoningEffort ?? defaults.reasoningEffort;
  if (effort !== undefined) body.reasoning_effort = String(effort);
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop;
  return body;
}

/** Translate chat-completions SSE payloads into `StreamChunk`s. */
export async function* translateChat(events) {
  let nextIndex = 0;
  let text;
  let reasoning;
  /** wire tool index -> { index, id, name, args } */
  const tools = new Map();
  let finishReason;
  let usage;

  const closeAll = function* () {
    if (reasoning !== undefined) {
      yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } };
      reasoning = undefined;
    }
    if (text !== undefined) {
      yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } };
      text = undefined;
    }
    for (const state of tools.values()) {
      yield {
        type: 'block-end',
        index: state.index,
        block: { type: 'tool-call', id: state.id, name: state.name ?? '', arguments: state.args },
      };
    }
    tools.clear();
  };

  for await (const payload of events) {
    if (payload === '[DONE]') break;
    let data;
    try {
      data = JSON.parse(payload);
    } catch (error) {
      throw new LlmError('Grok chat stream sent malformed JSON', 'MALFORMED_RESPONSE', { cause: error });
    }
    if (data.usage !== undefined && data.usage !== null) {
      const cached = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, (data.usage.prompt_tokens ?? 0) - cached),
        outputTokens: data.usage.completion_tokens ?? 0,
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
      };
    }
    const choice = data.choices?.[0];
    if (choice === undefined) continue;
    const delta = choice.delta ?? {};
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      if (reasoning === undefined) {
        reasoning = { index: nextIndex++, text: '' };
        yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' };
      }
      reasoning.text += reasoningDelta;
      yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta };
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (text === undefined) {
        text = { index: nextIndex++, text: '' };
        yield { type: 'block-start', index: text.index, blockType: 'text' };
      }
      text.text += delta.content;
      yield { type: 'text-delta', index: text.index, text: delta.content };
    }
    for (const wireCall of delta.tool_calls ?? []) {
      const slot = wireCall.index ?? 0;
      let state = tools.get(slot);
      if (state === undefined) {
        state = {
          index: nextIndex++,
          id: wireCall.id ?? `call_${slot}`,
          name: wireCall.function?.name,
          args: '',
        };
        tools.set(slot, state);
        yield { type: 'block-start', index: state.index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: '' };
      }
      if (typeof wireCall.function?.name === 'string' && state.name === undefined) state.name = wireCall.function.name;
      const argsDelta = wireCall.function?.arguments ?? '';
      if (argsDelta.length > 0) {
        state.args += argsDelta;
        yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: argsDelta };
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason;
    }
  }

  yield* closeAll();
  if (usage !== undefined) yield { type: 'usage', usage };
  if (finishReason === undefined) {
    throw new LlmError('Grok chat stream closed without a finish reason', 'STREAM_CLOSED');
  }
  if (finishReason === 'tool_calls') yield { type: 'finish', reason: { kind: 'tool-calls' } };
  else if (finishReason === 'length') yield { type: 'finish', reason: { kind: 'max-tokens' } };
  else if (finishReason === 'stop') yield { type: 'finish', reason: { kind: 'stop' } };
  else {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `Grok finished with unsupported reason "${finishReason}"`, code: 'UNSUPPORTED_FINISH' },
      },
    };
  }
}

//#endregion

//#region SSE

/**
 * Parse one SSE byte stream into event payloads.
 * @param body - the response `ReadableStream`.
 * @param mode - `'json'` yields parsed objects tagged with their event type
 * (Responses API); `'data'` yields raw data-line payloads (chat completions).
 * @param onActivity - called on every transport read, for idle watchdogs.
 */
export async function* parseSse(body, mode, onActivity) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType;
  let dataLines = [];

  const flush = function* () {
    if (dataLines.length === 0) {
      eventType = undefined;
      return;
    }
    const payload = dataLines.join('\n');
    dataLines = [];
    const type = eventType;
    eventType = undefined;
    if (mode === 'data') {
      yield payload;
      return;
    }
    if (payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new LlmError('Grok stream sent a malformed SSE payload', 'MALFORMED_RESPONSE', { cause: error });
    }
    if (parsed.type === undefined && type !== undefined) parsed.type = type;
    yield parsed;
  };

  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) {
        yield* flush();
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // comment lines (":" prefix) count as transport activity only
    }
  }
  yield* flush();
}

//#endregion
