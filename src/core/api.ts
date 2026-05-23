import { logger } from '../utils/logger.js';
import { withTimeout, retryWithBackoff } from '../utils/resilience.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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
}

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
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

  async chat(
    messages: Message[],
    model?: string,
    options: ChatOptions = {}
  ): Promise<ChatResponse> {
    const body = {
      model: model ?? this.defaultModel,
      messages: messages.map(this.serializeMessage),
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      ...(options.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
    };

    logger.debug(`POST ${this.baseUrl}/chat/completions model=${body.model} msgs=${messages.length}`);

    const res = await retryWithBackoff(
      () => withTimeout(
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
        }),
        30_000,
        'DeepSeek chat'
      ),
      { maxAttempts: 3, label: 'DeepSeek chat' }
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
          tool_calls?: ToolCall[];
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls,
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async *stream(
    messages: Message[],
    model?: string,
    options: ChatOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const body = {
      model: model ?? this.defaultModel,
      messages: messages.map(this.serializeMessage),
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      stream: true,
    };

    const res = await withTimeout(
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      }),
      30_000,
      'DeepSeek stream connect'
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

    while (true) {
      const { done, value } = await withTimeout(reader.read(), 60_000, 'Stream chunk');
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string | null } }>;
          };
          const delta = parsed.choices[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
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
      const response = await this.chat(msgs, model, { ...options, tools });
      round++;

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      msgs.push(assistantMsg);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { messages: msgs, finalContent: response.content };
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
        msgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    return { messages: msgs, finalContent: msgs[msgs.length - 1]?.content ?? '' };
  }

  // Same as runToolLoop but streams the final (no-tool-call) response via onChunk.
  // Intermediate tool-call rounds use non-streaming; only the last response is streamed.
  async runToolLoopStream(
    messages: Message[],
    tools: Tool[],
    executor: (name: string, args: Record<string, unknown>) => Promise<string>,
    onChunk: (chunk: string) => void,
    onToolCall?: (name: string) => void,
    model?: string,
    options: ChatOptions = {},
    maxRounds = 10
  ): Promise<{ messages: Message[]; finalContent: string }> {
    const msgs = [...messages];
    let round = 0;

    while (round < maxRounds) {
      round++;

      // Use non-streaming to detect tool calls
      const probe = await this.chat(msgs, model, { ...options, tools });

      if (!probe.toolCalls || probe.toolCalls.length === 0) {
        // Final response — stream it for real-time output
        let finalContent = '';
        try {
          for await (const chunk of this.stream(msgs, model, options)) {
            finalContent += chunk;
            onChunk(chunk);
          }
        } catch {
          // Streaming failed — fall back to already-received content
          finalContent = probe.content;
          onChunk(probe.content);
        }
        const content = finalContent || probe.content;
        msgs.push({ role: 'assistant', content });
        return { messages: msgs, finalContent: content };
      }

      // Has tool calls — execute them (non-streaming)
      msgs.push({
        role: 'assistant',
        content: probe.content,
        tool_calls: probe.toolCalls,
      });

      for (const tc of probe.toolCalls) {
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

    return { messages: msgs, finalContent: msgs[msgs.length - 1]?.content ?? '' };
  }

  private serializeMessage(msg: Message): Record<string, unknown> {
    const out: Record<string, unknown> = { role: msg.role, content: msg.content };
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
