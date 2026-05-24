import { afterEach, describe, expect, test } from 'bun:test';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { ollamaFactory } from '../src/providers/ollama/index.ts';
import { createRuntime } from '../src/runtime/runtime.ts';

const originalFetch = globalThis.fetch;

const bus: EventBus = {
  emit() {},
  on() {
    return () => {};
  },
  onAny() {
    return () => {};
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ollama provider', () => {
  test('runs review requests and parses structured findings', async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        message: { role: 'assistant', content: '{"findings":[]}' },
        prompt_eval_count: 7,
        eval_count: 2,
      });
    }) as typeof fetch;

    const provider = await ollamaFactory.create(
      'ollama-local',
      {
        type: 'ollama',
        model: 'llama3.1',
        base_url: 'http://ollama.test',
        temperature: 0.2,
        max_tokens: 1024,
        top_p: 0.9,
        keep_alive: '5m',
      },
      { workspaceRoot: '/tmp/quorum', env: {} },
    );

    const task: ReviewTask = {
      kind: 'review',
      id: 'task-1',
      reviewerId: 'security-ollama',
      systemPrompt: 'Review security issues.',
      instruction: 'Review this diff.',
      workspace: { root: '/tmp/quorum' },
    };

    const result = await provider.review!(task, {
      bus,
      signal: new AbortController().signal,
      workspace: { root: '/tmp/quorum' },
    });

    expect(requestBody).toMatchObject({
      model: 'llama3.1',
      format: 'json',
      stream: false,
      keep_alive: '5m',
      options: {
        temperature: 0.2,
        num_predict: 1024,
        top_p: 0.9,
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.rawOutput).toBe('{"findings":[]}');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  test('model overrides replace configured model and sampling options', async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ message: { content: '{"findings":[]}' } });
    }) as typeof fetch;

    const provider = await ollamaFactory.create(
      'ollama-local',
      {
        type: 'ollama',
        model: 'llama3.1',
        base_url: 'http://ollama.test',
        temperature: 0.2,
      },
      { workspaceRoot: '/tmp/quorum', env: {} },
    );

    await provider.review!(
      {
        kind: 'review',
        id: 'task-1',
        reviewerId: 'security-ollama',
        systemPrompt: 'Review security issues.',
        instruction: 'Review this diff.',
        workspace: { root: '/tmp/quorum' },
      },
      {
        bus,
        signal: new AbortController().signal,
        workspace: { root: '/tmp/quorum' },
        modelOverride: { model: 'qwen2.5-coder', temperature: 0.1, maxTokens: 256 },
      },
    );

    expect(requestBody).toMatchObject({
      model: 'qwen2.5-coder',
      options: {
        temperature: 0.1,
        num_predict: 256,
      },
    });
  });

  test('runtime registers ollama as a built-in provider', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'ollama-local': {
            type: 'ollama',
            model: 'llama3.1',
            base_url: 'http://ollama.test',
          },
        },
        personas: {
          security: {
            description: 'Security review',
            system: 'Find security issues.',
          },
        },
        reviewers: {
          'sec-ollama': {
            persona: 'security',
            provider: 'ollama-local',
          },
        },
        pipelines: {
          default: {
            parallel: true,
            reviewers: ['sec-ollama'],
          },
        },
      },
      pluginCtx: { workspaceRoot: '/tmp/quorum', env: {} },
    });

    expect(runtime.providers.list()).toContain('ollama');
    await runtime.dispose();
  });
});
