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

export class OpenRouterClient {
  constructor(
    private readonly cfg: OpenRouterConfig,
    private readonly providerId: string,
  ) {}

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.cfg.api_key}`,
      'Content-Type': 'application/json',
    };
    if (this.cfg.referer) headers['HTTP-Referer'] = this.cfg.referer;
    if (this.cfg.title) headers['X-Title'] = this.cfg.title;

    const url = `${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderRuntimeError(this.providerId, `Network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new ProviderRuntimeError(
        this.providerId,
        `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }

    try {
      return (await res.json()) as ChatResponse;
    } catch (err) {
      throw new ProviderRuntimeError(this.providerId, `Invalid JSON response: ${(err as Error).message}`, err);
    }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.cfg.api_key}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (this.cfg.referer) headers['HTTP-Referer'] = this.cfg.referer;
    if (this.cfg.title) headers['X-Title'] = this.cfg.title;

    const url = `${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '<no body>');
      throw new ProviderRuntimeError(
        this.providerId,
        `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
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
          const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }
}
