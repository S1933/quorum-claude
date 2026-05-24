import type { OllamaConfig } from './schema.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  top_p?: number;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  format?: 'json';
  options?: OllamaOptions;
  keep_alive?: string | number;
}

export interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export type OllamaStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; prompt_eval_count: number; eval_count: number };

export class OllamaClient {
  constructor(
    private readonly cfg: OllamaConfig,
    private readonly providerId: string,
  ) {}

  async chat(req: OllamaChatRequest, signal: AbortSignal): Promise<OllamaChatResponse> {
    const res = await this.post({ ...req, stream: false }, signal);
    try {
      return (await res.json()) as OllamaChatResponse;
    } catch (err) {
      throw new ProviderRuntimeError(this.providerId, `Invalid JSON response: ${(err as Error).message}`, err);
    }
  }

  async *chatStream(req: OllamaChatRequest, signal: AbortSignal): AsyncIterable<OllamaStreamEvent> {
    const res = await this.post({ ...req, stream: true }, signal);
    if (!res.body) {
      throw new ProviderRuntimeError(this.providerId, 'HTTP response had no body');
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
        const event = parseStreamLine(line);
        if (!event) continue;
        yield event;
      }
    }

    buffer += decoder.decode();
    const event = parseStreamLine(buffer);
    if (event) yield event;
  }

  private async post(req: OllamaChatRequest, signal: AbortSignal): Promise<Response> {
    const url = `${this.cfg.base_url.replace(/\/$/, '')}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    return res;
  }
}

function parseStreamLine(line: string): OllamaStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as OllamaChatResponse;
    const text = parsed.message?.content;
    if (text) return { type: 'token', text };
    if (
      parsed.done &&
      typeof parsed.prompt_eval_count === 'number' &&
      typeof parsed.eval_count === 'number'
    ) {
      return {
        type: 'usage',
        prompt_eval_count: parsed.prompt_eval_count,
        eval_count: parsed.eval_count,
      };
    }
  } catch {
    return null;
  }
  return null;
}
