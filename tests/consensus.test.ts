import { describe, expect, test } from 'bun:test';
import type { Category, Finding, Severity } from '../src/core/finding.ts';
import type { ReviewResult } from '../src/core/task.ts';
import { overlapV1 } from '../src/consensus/overlap-v1.ts';

describe('overlap-v1', () => {
  test('keeps only groups that satisfy requireAgreement and returns non-passing findings as unique', () => {
    const agreedA = finding({ reviewer: 'sec-a', lineStart: 10 });
    const agreedB = finding({ reviewer: 'sec-b', lineStart: 11 });
    const single = finding({
      reviewer: 'sec-c',
      file: 'src/other.ts',
      lineStart: 40,
      title: 'Only one reviewer saw this',
    });

    const result = overlapV1.aggregate(
      [
        review('sec-a', [agreedA]),
        review('sec-b', [agreedB]),
        review('sec-c', [single]),
      ],
      { strategy: 'overlap-v1', requireAgreement: 2 },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.reviewers).toEqual(['sec-a', 'sec-b']);
    expect(result.groups[0]?.members).toEqual([agreedA, agreedB]);
    expect(result.unique).toEqual([single]);
  });

  test('groups line ranges that are within the two-line tolerance', () => {
    const first = finding({ reviewer: 'arch-a', lineStart: 20, lineEnd: 22 });
    const second = finding({ reviewer: 'arch-b', lineStart: 24, lineEnd: 25 });

    const result = overlapV1.aggregate(
      [review('arch-a', [first]), review('arch-b', [second])],
      { strategy: 'overlap-v1' },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.members).toEqual([first, second]);
    expect(result.unique).toEqual([]);
  });

  test('does not group findings with different categories even when file and lines overlap', () => {
    const security = finding({
      reviewer: 'sec',
      category: 'security',
      lineStart: 12,
    });
    const correctness = finding({
      reviewer: 'correctness',
      category: 'correctness',
      lineStart: 13,
    });

    const result = overlapV1.aggregate(
      [review('sec', [security]), review('correctness', [correctness])],
      { strategy: 'overlap-v1' },
    );

    expect(result.groups).toEqual([]);
    expect(result.unique).toEqual([security, correctness]);
  });

  test('groups findings regardless of iteration order via member matching', () => {
    const a = finding({ reviewer: 'r-a', lineStart: 10, lineEnd: 12, severity: 'low', title: 'A' });
    const b = finding({ reviewer: 'r-b', lineStart: 12, lineEnd: 14, severity: 'critical', title: 'B' });
    const c = finding({ reviewer: 'r-c', lineStart: 10, lineEnd: 11, severity: 'medium', title: 'C' });

    const result = overlapV1.aggregate(
      [review('r-a', [a]), review('r-b', [b]), review('r-c', [c])],
      { strategy: 'overlap-v1' },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.members).toHaveLength(3);
    expect(result.groups[0]?.reviewers.sort()).toEqual(['r-a', 'r-b', 'r-c']);
  });

  test('uses the highest severity finding as the group representative', () => {
    const low = finding({
      reviewer: 'perf-a',
      severity: 'low',
      title: 'Low severity version',
    });
    const critical = finding({
      reviewer: 'perf-b',
      severity: 'critical',
      title: 'Critical severity version',
      lineStart: 9,
    });
    const medium = finding({
      reviewer: 'perf-c',
      severity: 'medium',
      title: 'Medium severity version',
      lineStart: 11,
    });

    const result = overlapV1.aggregate(
      [review('perf-a', [low]), review('perf-b', [critical]), review('perf-c', [medium])],
      { strategy: 'overlap-v1' },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.representative).toBe(critical);
    expect(result.groups[0]?.reviewers).toEqual(['perf-a', 'perf-b', 'perf-c']);
  });
});

function review(reviewerId: string, findings: Finding[]): ReviewResult {
  return {
    taskId: `task:${reviewerId}`,
    reviewerId,
    findings,
    rawOutput: JSON.stringify({ findings: [] }),
    durationMs: 1,
  };
}

function finding(opts: {
  reviewer: string;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  severity?: Severity;
  category?: Category;
  title?: string;
}): Finding {
  const start = opts.lineStart ?? 10;
  return {
    file: opts.file ?? 'src/app.ts',
    lineRange: { start, end: opts.lineEnd ?? start },
    severity: opts.severity ?? 'medium',
    category: opts.category ?? 'correctness',
    title: opts.title ?? 'Shared issue',
    body: 'Issue body',
    reviewer: opts.reviewer,
  };
}
