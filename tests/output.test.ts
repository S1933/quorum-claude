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
});
