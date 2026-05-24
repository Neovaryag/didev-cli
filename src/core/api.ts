import { logger } from '../utils/logger.js';
import { withTimeout, retryWithBackoff } from '../utils/resilience.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /** Override per-call timeout in ms (default: 150_000) */
  timeoutMs?: number;
  /** Called before each retry: (attemptNumber, totalAttempts, error) */
  onRetry?: (attempt: number, total: number, error: Error) => void;
}

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

// Only deepseek-reasoner and deepseek-v4-pro are actual thinking models (no temperature support).
// deepseek-v4-flash is a regular chat model — fast, 1M context, but NOT a thinking model.
function isThinkingModel(model: string): boolean {
  return model.includes('reasoner') || model.includes('v4-pro');
}

export class DeepSeekClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.deepseek.com/v1';
    this.defaultModel = config.model ?? 'deepseek-chat';
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.defaultTemperature = config.temperature ?? 0.3;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private buildBody(
    model: string,
    messages: Message[],
    options: ChatOptions,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const thinking = isThinkingModel(model);
    return {
      model,
      messages: messages.map(msg => this.serializeMessage(msg)),
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      // temperature is unsupported for thinking models — omit it
      ...(!thinking ? { temperature: options.temperature ?? this.defaultTemperature } : {}),
      ...extra,
    };
  }

  async chat(
    messages: Message[],
    model?: string,
    options: ChatOptions = {}
  ): Promise<ChatResponse> {
    const resolvedModel = model ?? this.defaultModel;
    const body = this.buildBody(resolvedModel, messages, options, {
      ...(options.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
    });

    logger.debug(`POST ${this.baseUrl}/chat/completions model=${resolvedModel} msgs=${messages.length}`);

    const timeoutMs = options.timeoutMs ?? 150_000;
    const res = await retryWithBackoff(
      () => withTimeout(
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        }),
        timeoutMs,
        'DeepSeek chat'
      ),
      {
        maxAttempts: 5,
        label: 'DeepSeek chat',
        onRetry: options.onRetry
          ? (attempt, total, err, _delay) => options.onRetry!(attempt, total, err)
          : undefined,
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 402) {
        throw new Error('💸 Закончился баланс на DeepSeek — пора закинуть деньжат на счёт!\n   👉 https://platform.deepseek.com/top_up');
      }
      throw new Error(`DeepSeek API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          content: string | null;
          reasoning_content?: string | null;
          tool_calls?: ToolCall[];
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    return {
      content: choice.message.content,
      reasoningContent: choice.message.reasoning_content ?? undefined,
      toolCalls: choice.message.tool_calls,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  // Streams response, yields content chunks, and also collects reasoning_content + tool_calls.
  async *streamFull(
    messages: Message[],
    model?: string,
    options: ChatOptions = {}
  ): AsyncGenerator<
    | { type: 'content'; chunk: string }
    | { type: 'done'; reasoningContent?: string; toolCalls?: ToolCall[]; usage?: TokenUsage },
    void,
    unknown
  > {
    const resolvedModel = model ?? this.defaultModel;
    const body = this.buildBody(resolvedModel, messages, options, {
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
    });

    const res = await retryWithBackoff(
      () => withTimeout(
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        }),
        90_000,
        'DeepSeek stream connect'
      ),
      { maxAttempts: 3, label: 'DeepSeek stream connect' }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 402) {
        throw new Error('💸 Закончился баланс на DeepSeek — пора закинуть деньжат на счёт!\n   👉 https://platform.deepseek.com/top_up');
      }
      throw new Error(`DeepSeek API error ${res.status}: ${text}`);
    }

    if (!res.body) throw new Error('No response body for streaming');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reasoningContent = '';
    let streamUsage: TokenUsage | undefined;
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

    while (true) {
      const { done, value } = await withTimeout(reader.read(), 120_000, 'Stream chunk');
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          const toolCalls = toolCallsMap.size > 0
            ? [...toolCallsMap.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, tc]) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }))
            : undefined;
          yield { type: 'done', reasoningContent: reasoningContent || undefined, toolCalls, usage: streamUsage };
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{
              delta: {
                content?: string | null;
                reasoning_content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens?: number;
              prompt_cache_hit_tokens?: number;
              prompt_cache_miss_tokens?: number;
            };
          };
          // usage-only chunk (sent before [DONE] when stream_options.include_usage = true)
          if (parsed.usage) {
            streamUsage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              cacheHitTokens: parsed.usage.prompt_cache_hit_tokens,
              cacheMissTokens: parsed.usage.prompt_cache_miss_tokens,
            };
          }
          const delta = parsed.choices[0]?.delta;
          if (!delta) continue;

          if (delta.reasoning_content) {
            reasoningContent += delta.reasoning_content;
          }
          if (delta.content) {
            yield { type: 'content', chunk: delta.content };
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
              toolCallsMap.set(tc.index, {
                id: tc.id ?? existing.id,
                name: (existing.name) + (tc.function?.name ?? ''),
                arguments: existing.arguments + (tc.function?.arguments ?? ''),
              });
            }
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
    // Stream ended without [DONE] — still yield with whatever usage we collected
    yield { type: 'done', reasoningContent: reasoningContent || undefined, usage: streamUsage };
  }

  // Run a tool-calling loop until the model stops requesting tools
  async runToolLoop(
    messages: Message[],
    tools: Tool[],
    executor: (name: string, args: Record<string, unknown>) => Promise<string>,
    model?: string,
    options: ChatOptions = {},
    maxRounds = 10
  ): Promise<{ messages: Message[]; finalContent: string }> {
    const msgs = [...messages];
    let round = 0;

    while (round < maxRounds) {
      const response = await this.chat(msgs, model, { ...options, tools, onRetry: options.onRetry });
      round++;

      msgs.push({
        role: 'assistant',
        content: response.content,
        reasoning_content: response.reasoningContent,
        tool_calls: response.toolCalls,
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { messages: msgs, finalContent: response.content ?? '' };
      }

      for (const tc of response.toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          logger.debug(`Tool call: ${tc.function.name}(${JSON.stringify(args)})`);
          result = await executor(tc.function.name, args);
        } catch (e) {
          result = `Error: ${(e as Error).message}`;
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    return { messages: msgs, finalContent: (msgs[msgs.length - 1]?.content ?? '') as string };
  }

  // Streams responses, executes tool calls, streams final answer in real-time.
  // Single API call per round — no double-billing.
  async runToolLoopStream(
    messages: Message[],
    tools: Tool[],
    executor: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk: (chunk: string) => void,
    onToolCall?: (name: string) => void,
    model?: string,
    options: ChatOptions = {},
    maxRounds = 10
  ): Promise<{ messages: Message[]; finalContent: string; usage?: TokenUsage }> {
    const msgs = [...messages];
    let round = 0;
    let lastUsage: TokenUsage | undefined;

    while (round < maxRounds) {
      round++;

      let finalContent = '';
      let reasoningContent: string | undefined;
      let toolCalls: ToolCall[] | undefined;

      for await (const event of this.streamFull(msgs, model, { ...options, tools })) {
        if (event.type === 'content') {
          finalContent += event.chunk;
          onChunk(event.chunk);
        } else {
          reasoningContent = event.reasoningContent;
          toolCalls = event.toolCalls;
          lastUsage = event.usage;
        }
      }

      if (!toolCalls || toolCalls.length === 0) {
        msgs.push({ role: 'assistant', content: finalContent, reasoning_content: reasoningContent });
        return { messages: msgs, finalContent, usage: lastUsage };
      }

      // Has tool calls — reasoning_content MUST be passed back per spec
      msgs.push({
        role: 'assistant',
        content: finalContent || null,
        reasoning_content: reasoningContent,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          logger.debug(`Tool call: ${tc.function.name}(${JSON.stringify(args)})`);
          onToolCall?.(tc.function.name);
          result = await executor(tc.function.name, args);
        } catch (e) {
          result = `Error: ${(e as Error).message}`;
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    return { messages: msgs, finalContent: (msgs[msgs.length - 1]?.content ?? '') as string, usage: lastUsage };
  }

  private serializeMessage(msg: Message): Record<string, unknown> {
    const out: Record<string, unknown> = { role: msg.role, content: msg.content };
    if (msg.reasoning_content != null) out['reasoning_content'] = msg.reasoning_content;
    if (msg.tool_call_id) out['tool_call_id'] = msg.tool_call_id;
    if (msg.tool_calls) out['tool_calls'] = msg.tool_calls;
    if (msg.name) out['name'] = msg.name;
    return out;
  }
}

let _client: DeepSeekClient | null = null;

export function getClient(config?: DeepSeekConfig): DeepSeekClient {
  if (!_client) {
    if (!config) throw new Error('DeepSeek client not initialized');
    _client = new DeepSeekClient(config);
  }
  return _client;
}

export function initClient(config: DeepSeekConfig): DeepSeekClient {
  _client = new DeepSeekClient(config);
  return _client;
}
