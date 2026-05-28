import type { Finding, Severity, Category } from '../core/finding.ts';
import { CATEGORIES, SEVERITIES } from '../core/finding.ts';
import { ReviewerOutputError } from '../core/errors.ts';

export const REVIEW_OUTPUT_INSTRUCTIONS = `Respond with a single JSON object — no prose, no preamble, no markdown fence, no thinking written outside the object — matching this shape:
{
  "findings": [
    {
      "file": "relative/path.ts",
      "lineStart": 12,
      "lineEnd": 18,
      "severity": "low|medium|high|critical|info",
      "category": "security|performance|architecture|correctness|style",
      "title": "Short, concrete title",
      "body": "One or two sentences. Cite the specific issue. Suggest a fix."
    }
  ]
}
Do not invent files or line numbers — only cite what you were shown.
This applies even when the code looks clean: if you find no issues, your entire reply must be exactly {"findings": []} — never a sentence such as "No issues found". The first character you output must be "{" and the last must be "}".`;

// Appended to the prompt on a single automatic retry when a reviewer's first
// reply could not be parsed as the JSON envelope above (e.g. it answered in prose).
export const RETRY_REMINDER = `Your previous reply could not be parsed: it did not contain the required JSON object. Reply again with ONLY the JSON object described above — start with "{", end with "}", and include nothing else. If there are no issues, reply with exactly {"findings": []}.`;

interface RawFinding {
  file?: unknown;
  lineStart?: unknown;
  lineEnd?: unknown;
  line_start?: unknown;
  line_end?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  body?: unknown;
  recommendation?: unknown;
}

export function parseFindings(raw: string, reviewerId: string): Finding[] {
  const text = stripFence(raw).trim();
  if (!text) throw new ReviewerOutputError(reviewerId, 'Reviewer returned empty output');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const recovered = extractJsonObject(text);
    if (!recovered) {
      throw new ReviewerOutputError(reviewerId, 'Reviewer output did not contain JSON', err);
    }
    try {
      parsed = JSON.parse(recovered);
    } catch (recoveredErr) {
      throw new ReviewerOutputError(
        reviewerId,
        'Reviewer output contained malformed JSON',
        recoveredErr,
      );
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ReviewerOutputError(reviewerId, 'Reviewer output JSON must be an object');
  }
  const findingsRaw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) {
    throw new ReviewerOutputError(reviewerId, 'Reviewer output must contain a findings array');
  }

  const out: Finding[] = [];
  for (const [idx, item] of findingsRaw.entries()) {
    const normalised = normaliseFinding(item as RawFinding, reviewerId);
    if (!normalised) {
      throw new ReviewerOutputError(reviewerId, `Invalid finding at index ${idx}`);
    }
    out.push(normalised);
  }
  return out;
}

function normaliseFinding(item: RawFinding, reviewerId: string): Finding | null {
  if (!item || typeof item !== 'object') return null;
  const file = typeof item.file === 'string' ? item.file : null;
  if (!file) return null;

  const lineStart = toInt(item.lineStart ?? item.line_start) ?? 1;
  const lineEndRaw = toInt(item.lineEnd ?? item.line_end);
  const lineEnd = lineEndRaw ?? lineStart;

  const severity = normaliseSeverity(item.severity);
  const category = normaliseCategory(item.category);
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const body = normaliseBody(item.body, item.recommendation);
  if (!title) return null;

  return {
    file,
    lineRange: { start: lineStart, end: Math.max(lineStart, lineEnd) },
    severity,
    category,
    title,
    body,
    reviewer: reviewerId,
  };
}

function normaliseBody(body: unknown, recommendation: unknown): string {
  const parts = [body, recommendation]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return [...new Set(parts)].join('\n\n');
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(1, Math.floor(v));
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return Math.max(1, n);
  }
  return null;
}

function normaliseSeverity(v: unknown): Severity {
  if (typeof v !== 'string') return 'medium';
  const lc = v.toLowerCase().trim();
  return (SEVERITIES as readonly string[]).includes(lc) ? (lc as Severity) : 'medium';
}

function normaliseCategory(v: unknown): Category {
  if (typeof v !== 'string') return 'correctness';
  const lc = v.toLowerCase().trim();
  return (CATEGORIES as readonly string[]).includes(lc) ? (lc as Category) : 'correctness';
}

function stripFence(s: string): string {
  const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m.exec(s.trim());
  return fenceMatch ? fenceMatch[1]! : s;
}

function extractJsonObject(s: string): string | null {
  let searchFrom = 0;
  while (searchFrom < s.length) {
    const candidate = extractBalancedBraces(s, searchFrom);
    if (!candidate) return null;
    try {
      JSON.parse(candidate.text);
      return candidate.text;
    } catch {
      searchFrom = candidate.startIndex + 1;
    }
  }
  return null;
}

function extractBalancedBraces(s: string, from: number): { text: string; startIndex: number } | null {
  const start = s.indexOf('{', from);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: s.slice(start, i + 1), startIndex: start };
    }
  }
  return null;
}
