import type { Finding, FindingGroup } from '../core/finding.ts';
import type { ConsensusResult } from '../core/pipeline.ts';
import { severityRank } from '../core/finding.ts';
import type { ConsensusStrategy } from './registry.ts';

const LINE_TOLERANCE = 2;

export const overlapV1: ConsensusStrategy = {
  id: 'overlap-v1',
  aggregate(reviews, cfg): ConsensusResult {
    const all: Finding[] = reviews.flatMap((r) => r.findings);
    const groups: FindingGroup[] = [];

    let nextId = 1;
    for (const finding of all) {
      const target = groups.find((g) => g.members.some((m) => matches(m, finding)));
      if (target) {
        target.members.push(finding);
        if (!target.reviewers.includes(finding.reviewer)) {
          target.reviewers.push(finding.reviewer);
        }
        if (severityRank(finding.severity) > severityRank(target.representative.severity)) {
          target.representative = finding;
        }
      } else {
        groups.push({
          id: `g${nextId++}`,
          representative: finding,
          members: [finding],
          reviewers: [finding.reviewer],
        });
      }
    }

    const agreement: Record<string, number> = {};
    for (const g of groups) agreement[g.id] = g.reviewers.length;

    const requireAgreement = cfg.requireAgreement ?? 1;
    const passing = groups.filter((g) => g.reviewers.length >= requireAgreement);
    const unique = groups
      .filter((g) => g.reviewers.length < requireAgreement && requireAgreement > 1)
      .flatMap((g) => g.members);

    const finalGroups =
      requireAgreement > 1
        ? passing
        : groups.filter((g) => g.reviewers.length >= 2);
    const finalUnique =
      requireAgreement > 1
        ? unique
        : groups.filter((g) => g.reviewers.length < 2).flatMap((g) => g.members);

    return {
      groups: finalGroups,
      agreement,
      unique: finalUnique,
      contradictions: [],
      strategyId: 'overlap-v1',
    };
  },
};

function matches(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (a.category !== b.category) return false;
  return rangesOverlap(a.lineRange.start, a.lineRange.end, b.lineRange.start, b.lineRange.end);
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  const lo1 = a1 - LINE_TOLERANCE;
  const hi1 = a2 + LINE_TOLERANCE;
  return !(b2 < lo1 || b1 > hi1);
}
