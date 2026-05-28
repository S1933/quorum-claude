import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { ConfigError } from '../core/errors.ts';
import type { WriteStreamLike } from './terminal.ts';

export interface SelectChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface SelectIo {
  stdout: WriteStreamLike;
}

export async function promptQuestion(question: string, io: SelectIo): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: io.stdout as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function selectManyCheckbox(
  question: string,
  choices: SelectChoice[],
  defaults: string[],
  io: SelectIo,
): Promise<string[]> {
  if (choices.length === 0) return [];
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    io.stdout.write(`${question}\n`);
    io.stdout.write('Select one or more choices by number or id, comma-separated. Use "all" for every choice.\n');
    choices.forEach((choice, index) => {
      const checked = defaults.includes(choice.value) ? 'x' : ' ';
      const hint = choice.hint ? ` - ${choice.hint}` : '';
      io.stdout.write(`  [${checked}] ${index + 1}. ${choice.label}${hint}\n`);
    });
    const answer = await promptQuestion('Choices: ', io);
    return answer.trim() ? parseSelection(answer, choices.map((choice) => choice.value)) : defaults;
  }

  let cursor = 0;
  const selected = new Set(defaults);
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) io.stdout.write(`\x1b[${renderedLines}A\x1b[J`);
    io.stdout.write(`${question}\n`);
    io.stdout.write('Use Up/Down, Space to toggle, Enter to confirm, a to toggle all.\n');
    choices.forEach((choice, index) => {
      const active = index === cursor ? '>' : ' ';
      const checked = selected.has(choice.value) ? 'x' : ' ';
      const hint = choice.hint ? ` - ${choice.hint}` : '';
      io.stdout.write(`${active} [${checked}] ${choice.label}${hint}\n`);
    });
    renderedLines = choices.length + 2;
  };

  return await new Promise<string[]>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const finish = () => {
      const values = selected.size > 0 ? [...selected] : [...defaults];
      cleanup();
      io.stdout.write('\n');
      resolve(values);
    };
    const onKeypress = (chunk: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new ConfigError('Init cancelled'));
        return;
      }
      const input = key.name ?? key.sequence ?? chunk;
      switch (input) {
        case 'up':
          cursor = cursor === 0 ? choices.length - 1 : cursor - 1;
          render();
          break;
        case 'down':
          cursor = cursor === choices.length - 1 ? 0 : cursor + 1;
          render();
          break;
        case 'space':
        case ' ': {
          const value = choices[cursor]!.value;
          if (selected.has(value)) selected.delete(value);
          else selected.add(value);
          render();
          break;
        }
        case 'a':
          if (selected.size === choices.length) selected.clear();
          else choices.forEach((choice) => selected.add(choice.value));
          render();
          break;
        case 'return':
        case 'enter':
          finish();
          break;
      }
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    render();
  });
}

function parseSelection(value: string, available: string[]): string[] {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === 'all') return available;
  return [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          if (/^\d+$/.test(item)) {
            const selected = available[Number(item) - 1];
            if (selected) return selected;
          }
          if (available.includes(item)) return item;
          throw new ConfigError(
            `Unsupported selection "${item}"; expected numbers 1-${available.length}, ids, or "all"`,
          );
        }),
    ),
  ];
}
