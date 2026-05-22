export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type Category =
  | 'security'
  | 'performance'
  | 'architecture'
  | 'correctness'
  | 'style';

export interface LineRange {
  start: number;
  end: number;
}

export interface Finding {
  file: string;
  lineRange: LineRange;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  reviewer: string;
}

export interface FindingGroup {
  id: string;
  representative: Finding;
  members: Finding[];
  reviewers: string[];
}

export interface Contradiction {
  groupId: string;
  reviewerA: string;
  reviewerB: string;
  note: string;
}

export const SEVERITIES: readonly Severity[] = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const;

export const CATEGORIES: readonly Category[] = [
  'security',
  'performance',
  'architecture',
  'correctness',
  'style',
] as const;

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}
