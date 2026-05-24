import { afterEach, describe, expect, test } from 'bun:test';
import { OllamaClient } from '../src/providers/ollama/client.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OllamaClient', () => {
  test('posts non-stream chat requests to /api/chat', async () => {
    let url = '';
    let requestBody: unknown;
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        message: { role: 'assistant', content: '{"findings":[]}' },
        prompt_eval_count: 9,
        eval_count: 3,
      });
    }) as typeof fetch;

    const client = new OllamaClient(
      {
        type: 'ollama',
        model: 'llama3.1',
        base_url: 'http://ollama.test',
      },
      'ollama-test',
    );

    const res = await client.chat(
      {
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'review' }],
        format: 'json',
      },
      new AbortController().signal,
    );

    expect(url).toBe('http://ollama.test/api/chat');
    expect(requestBody).toMatchObject({
      model: 'llama3.1',
      stream: false,
      format: 'json',
    });
    expect(res.message?.content).toBe('{"findings":[]}');
  });

  test('streams tokens and usage from newline-delimited JSON chunks', async () => {
    globalThis.fetch = (async (_input, _init) => new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('{"message":{"content":"{\\"findings\\":"},"done":false}\n'));
          controller.enqueue(enc.encode('{"message":{"content":"[]}"},"done":false}\n'));
          controller.enqueue(enc.encode('{"done":true,"prompt_eval_count":10,"eval_count":2}\n'));
          controller.close();
        },
      }),
      { status: 200 },
    )) as typeof fetch;

    const client = new OllamaClient(
      {
        type: 'ollama',
        model: 'llama3.1',
        base_url: 'http://ollama.test',
      },
      'ollama-test',
    );

    const events = [];
    for await (const event of client.chatStream(
      {
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'review' }],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', text: '{"findings":' },
      { type: 'token', text: '[]}' },
      { type: 'usage', prompt_eval_count: 10, eval_count: 2 },
    ]);
  });
});
