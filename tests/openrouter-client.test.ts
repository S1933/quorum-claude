import { afterEach, describe, expect, test } from 'bun:test';
import { OpenRouterClient } from '../src/providers/openrouter/client.ts';
import { ProviderRuntimeError } from '../src/core/errors.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient(overrides: Record<string, unknown> = {}): OpenRouterClient {
  return new OpenRouterClient(
    {
      type: 'openrouter' as const,
      api_key: 'test-key',
      model: 'test-model',
      base_url: 'https://openrouter.test/api/v1',
      maxRetries: 2,
      retryBaseMs: 1,
      ...overrides,
    },
    'openrouter-test',
  );
}

describe('OpenRouterClient', () => {
  test('streams tokens and usage events from SSE chunks', async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"{\\"findings\\":"}}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"[]}"}}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = makeClient();

    const events = [];
    for await (const event of client.chatStream(
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'review' }],
        stream_options: { include_usage: true },
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(requestBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events).toEqual([
      { type: 'token', text: '{"findings":' },
      { type: 'token', text: '[]}' },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]);
  });

  test('chat retries on 429 and succeeds', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts <= 2) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response(JSON.stringify({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.chat(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    );
    expect(attempts).toBe(3);
    expect(result.id).toBe('ok');
  });

  test('chat retries on 502/503/504', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response('bad gateway', { status: 502 });
      if (attempts === 2) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ id: 'ok', choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.chat(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    );
    expect(attempts).toBe(3);
    expect(result.id).toBe('ok');
  });

  test('chat throws after exhausting retries on 429', async () => {
    globalThis.fetch = (async () => {
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    const client = makeClient({ maxRetries: 1 });
    await expect(
      client.chat(
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(ProviderRuntimeError);
  });

  test('chat retries on network errors', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts <= 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ id: 'ok', choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.chat(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    );
    expect(attempts).toBe(2);
    expect(result.id).toBe('ok');
  });

  test('chat does not retry on 400', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    await expect(
      client.chat(
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(ProviderRuntimeError);
    expect(attempts).toBe(1);
  });

  test('chatStream retries on 429 before reading SSE', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts <= 1) return new Response('rate limited', { status: 429 });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = makeClient();
    const events = [];
    for await (const event of client.chatStream(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: 'token', text: 'ok' }]);
  });

  test('chat respects retry-after header', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ id: 'ok', choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.chat(
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    );
    expect(result.id).toBe('ok');
  });
});
