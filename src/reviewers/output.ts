import type { Finding, Severity, Category } from '../core/finding.ts';
import { CATEGORIES, SEVERITIES } from '../core/finding.ts';

export const REVIEW_OUTPUT_INSTRUCTIONS = `Respond with a single JSON object — no prose, no markdown fence — matching this shape:
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
If you find no issues, return {"findings": []}. Do not invent files or line numbers — only cite what you were shown.`;

interface RawFinding {
  file?: unknown;
  lineStart?: unknown;
  lineEnd?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  body?: unknown;
}

export function parseFindings(raw: string, reviewerId: string): Finding[] {
  const text = stripFence(raw).trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const recovered = extractJsonObject(text);
    if (!recovered) return [];
    try {
      parsed = JSON.parse(recovered);
    } catch {
      return [];
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return [];
  const findingsRaw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) return [];

  const out: Finding[] = [];
  for (const item of findingsRaw) {
    const normalised = normaliseFinding(item as RawFinding, reviewerId);
    if (normalised) out.push(normalised);
  }
  return out;
}

function normaliseFinding(item: RawFinding, reviewerId: string): Finding | null {
  if (!item || typeof item !== 'object') return null;
  const file = typeof item.file === 'string' ? item.file : null;
  if (!file) return null;

  const lineStart = toInt(item.lineStart) ?? 1;
  const lineEndRaw = toInt(item.lineEnd);
  const lineEnd = lineEndRaw ?? lineStart;

  const severity = normaliseSeverity(item.severity);
  const category = normaliseCategory(item.category);
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const body = typeof item.body === 'string' ? item.body.trim() : '';
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
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}
