import { describe, expect, test } from 'bun:test';
import { ReviewerOutputError } from '../src/core/errors.ts';
import { parseFindings } from '../src/reviewers/output.ts';

describe('parseFindings', () => {
  test('parses strict JSON findings', () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            lineStart: 3,
            lineEnd: 5,
            severity: 'high',
            category: 'security',
            title: 'Unsafe input',
            body: 'Validate the input.',
          },
        ],
      }),
      'sec-a',
    );

    expect(findings).toEqual([
      {
        file: 'src/app.ts',
        lineRange: { start: 3, end: 5 },
        severity: 'high',
        category: 'security',
        title: 'Unsafe input',
        body: 'Validate the input.',
        reviewer: 'sec-a',
      },
    ]);
  });

  test('recovers JSON wrapped in prose or a markdown fence', () => {
    expect(parseFindings('before {"findings":[]} after', 'rev-a')).toEqual([]);
    expect(parseFindings('```json\n{"findings":[]}\n```', 'rev-a')).toEqual([]);
  });

  test('throws when output is empty, non-JSON, or has the wrong top-level shape', () => {
    expect(() => parseFindings('', 'rev-a')).toThrow(ReviewerOutputError);
    expect(() => parseFindings('no structured output', 'rev-a')).toThrow(ReviewerOutputError);
    expect(() => parseFindings('{"issues":[]}', 'rev-a')).toThrow(ReviewerOutputError);
  });

  test('throws when a finding lacks required fields', () => {
    expect(() =>
      parseFindings(
        JSON.stringify({
          findings: [{ file: 'src/app.ts', lineStart: 1, title: '' }],
        }),
        'rev-a',
      ),
    ).toThrow(ReviewerOutputError);
  });

  test('normalises unknown severity, category, and line values', () => {
    const [finding] = parseFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            lineStart: 'abc',
            lineEnd: 0,
            severity: 'urgent',
            category: 'bug',
            title: 'Normalised finding',
          },
        ],
      }),
      'rev-a',
    );

    expect(finding?.lineRange).toEqual({ start: 1, end: 1 });
    expect(finding?.severity).toBe('medium');
    expect(finding?.category).toBe('correctness');
  });

  test('recovers JSON when prose contains braces before the JSON object', () => {
    const output = 'Here is my analysis (see lines {1-5} above):\n{"findings":[]}';
    const findings = parseFindings(output, 'rev-a');
    expect(findings).toEqual([]);
  });

  test('recovers JSON when prose contains braces after the JSON object', () => {
    const output = '{"findings":[]}\nNote: the function doStuff() { return 1; } is fine.';
    const findings = parseFindings(output, 'rev-a');
    expect(findings).toEqual([]);
  });

  test('recovers JSON from output with multiple brace groups', () => {
    const output = 'Here is {stuff} and then {"findings":[{"file":"a.ts","lineStart":1,"severity":"low","category":"style","title":"ok","body":"fine"}]} and more {stuff}';
    const findings = parseFindings(output, 'rev-a');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('a.ts');
  });

  test('balanced-brace scanner handles escaped quotes inside JSON strings', () => {
    const json = '{"findings":[{"file":"a\\"b.ts","lineStart":1,"severity":"low","category":"style","title":"has \\"quotes\\"","body":"ok"}]}';
    const output = `Some prose before. ${json} And after.`;
    const findings = parseFindings(output, 'rev-a');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('a"b.ts');
  });

  test('accepts snake_case line fields and appends recommendations', () => {
    const [finding] = parseFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            line_start: 7,
            line_end: 9,
            severity: 'Medium',
            category: 'Correctness',
            title: 'Snake case finding',
            body: 'The current code drops this variant.',
            recommendation: 'Accept common JSON field aliases.',
          },
        ],
      }),
      'rev-a',
    );

    expect(finding).toMatchObject({
      lineRange: { start: 7, end: 9 },
      severity: 'medium',
      category: 'correctness',
      body: 'The current code drops this variant.\n\nAccept common JSON field aliases.',
    });
  });
});
