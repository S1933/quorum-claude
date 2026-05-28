import type { OpenRouterConfig } from './schema.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  response_format?: { type: 'json_object' };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
}

export interface ChatResponse {
  id: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
}

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'chunk_parse_error'; raw: string };

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number, baseMs: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return baseMs * 2 ** attempt;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenRouterClient {
  constructor(
    private readonly cfg: OpenRouterConfig,
    private readonly providerId: string,
  ) {}

  private get maxRetries(): number { return this.cfg.maxRetries ?? 3; }
  private get retryBaseMs(): number { return this.cfg.retryBaseMs ?? 1000; }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.cfg.api_key}`,
      'Content-Type': 'application/json',
    };
    if (this.cfg.referer) headers['HTTP-Referer'] = this.cfg.referer;
    if (this.cfg.title) headers['X-Title'] = this.cfg.title;
    return headers;
  }

  private get url(): string {
    return `${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const body = JSON.stringify(req);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body,
          signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        if (attempt < this.maxRetries) {
          await sleep(retryDelay(attempt, this.retryBaseMs), signal);
          continue;
        }
        throw new ProviderRuntimeError(this.providerId, `Network error: ${(err as Error).message}`, err);
      }

      if (!res.ok) {
        const resBody = await res.text().catch(() => '<no body>');
        if (isRetryable(res.status) && attempt < this.maxRetries) {
          await sleep(retryDelay(attempt, this.retryBaseMs, res.headers.get('retry-after')), signal);
          continue;
        }
        throw new ProviderRuntimeError(
          this.providerId,
          `HTTP ${res.status} ${res.statusText}: ${resBody.slice(0, 500)}`,
        );
      }

      try {
        return (await res.json()) as ChatResponse;
      } catch (err) {
        throw new ProviderRuntimeError(this.providerId, `Invalid JSON response: ${(err as Error).message}`, err);
      }
    }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const body = JSON.stringify({ ...req, stream: true });
    const headers = { ...this.buildHeaders(), 'Accept': 'text/event-stream' };

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(this.url, { method: 'POST', headers, body, signal });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        if (attempt < this.maxRetries) {
          await sleep(retryDelay(attempt, this.retryBaseMs), signal);
          continue;
        }
        throw new ProviderRuntimeError(this.providerId, `Network error: ${(err as Error).message}`, err);
      }

      if (!res.ok || !res.body) {
        const resBody = await res.text().catch(() => '<no body>');
        if (isRetryable(res.status) && attempt < this.maxRetries) {
          await sleep(retryDelay(attempt, this.retryBaseMs, res.headers.get('retry-after')), signal);
          continue;
        }
        throw new ProviderRuntimeError(
          this.providerId,
          `HTTP ${res.status} ${res.statusText}: ${resBody.slice(0, 500)}`,
        );
      }
      break;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: ChatUsage | null;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield { type: 'token', text: delta };
          if (parsed.usage) yield { type: 'usage', usage: parsed.usage };
        } catch {
          yield { type: 'chunk_parse_error', raw: payload };
        }
      }
    }
  }
}
