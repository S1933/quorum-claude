import type { EventBus } from '../core/events.ts';
import type { Finding } from '../core/finding.ts';
import { severityRank } from '../core/finding.ts';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

export interface WriteStreamLike {
  write(chunk: string): unknown;
}

export interface TerminalRendererOptions {
  stream: WriteStreamLike;
  showTokens?: boolean;
  color?: boolean;
}

export class TerminalRenderer {
  private readonly stream: WriteStreamLike;
  private readonly color: boolean;
  private readonly showTokens: boolean;

  constructor(opts: TerminalRendererOptions) {
    this.stream = opts.stream;
    this.color = opts.color ?? true;
    this.showTokens = opts.showTokens ?? false;
  }

  attach(bus: EventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('pipeline.started', (e) => {
        this.line(`${this.c('cyan', '▶')}  pipeline ${this.c('bold', e.pipelineId)} — ${e.reviewers.length} reviewer(s): ${e.reviewers.join(', ')}`);
      }),
    );
    unsubs.push(
      bus.on('reviewer.started', (e) => {
        this.line(`${this.c('dim', '  …')} ${e.reviewerId} started`);
      }),
    );
    unsubs.push(
      bus.on('reviewer.event', (e) => {
        if (e.event.type === 'token' && this.showTokens) {
          this.stream.write(e.event.text);
        } else if (e.event.type === 'finding') {
          this.line(`${this.c('dim', '   ·')} ${e.reviewerId}: ${this.severityIcon(e.event.finding.severity)} ${e.event.finding.title} ${this.c('dim', `(${e.event.finding.file}:${e.event.finding.lineRange.start})`)}`);
        } else if (e.event.type === 'log') {
          this.line(`${this.c('gray', `   [${e.reviewerId}]`)} ${e.event.msg}`);
        }
      }),
    );
    unsubs.push(
      bus.on('reviewer.finished', (e) => {
        const n = e.result.findings.length;
        this.line(`${this.c('green', '  ✓')} ${e.reviewerId} finished — ${n} finding${n === 1 ? '' : 's'} ${this.c('dim', `(${e.result.durationMs}ms)`)}`);
      }),
    );
    unsubs.push(
      bus.on('reviewer.failed', (e) => {
        this.line(`${this.c('red', '  ✗')} ${e.reviewerId} failed: ${e.error.message}`);
      }),
    );
    unsubs.push(
      bus.on('pipeline.timeout', () => {
        this.line(`${this.c('red', '⏱')}  pipeline timeout reached`);
      }),
    );
    unsubs.push(
      bus.on('pipeline.finished', (e) => {
        this.line('');
        this.line(this.c('bold', '── Consensus ──'));
        this.renderConsensus(e.result.consensus.groups, e.result.consensus.unique);
        this.line('');
        this.line(this.c('dim', `pipeline ${e.result.pipelineId} done in ${e.result.durationMs}ms (${e.result.reviews.length} reviews, ${e.result.errors.length} errors)`));
      }),
    );

    return () => {
      for (const u of unsubs) u();
    };
  }

  private renderConsensus(
    groups: Array<{ id: string; representative: Finding; members: Finding[]; reviewers: string[] }>,
    unique: Finding[],
  ): void {
    if (groups.length === 0 && unique.length === 0) {
      this.line(this.c('green', '  no findings'));
      return;
    }
    const sortedGroups = [...groups].sort(
      (a, b) =>
        severityRank(b.representative.severity) - severityRank(a.representative.severity) ||
        b.reviewers.length - a.reviewers.length,
    );
    for (const g of sortedGroups) {
      const f = g.representative;
      const badge = this.c('magenta', `[${g.reviewers.length} agreed]`);
      this.line(`${this.severityIcon(f.severity)} ${this.c('bold', f.title)} ${badge} ${this.c('dim', `(${f.file}:${f.lineRange.start}-${f.lineRange.end})`)}`);
      if (f.body) this.line(`   ${f.body.replace(/\n/g, '\n   ')}`);
      this.line(this.c('dim', `   reviewers: ${g.reviewers.join(', ')}`));
    }
    if (unique.length > 0) {
      this.line('');
      this.line(this.c('dim', '── Single-reviewer findings ──'));
      const sorted = [...unique].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
      for (const f of sorted) {
        this.line(`${this.severityIcon(f.severity)} ${f.title} ${this.c('dim', `(${f.file}:${f.lineRange.start}, ${f.reviewer})`)}`);
      }
    }
  }

  private severityIcon(s: Finding['severity']): string {
    switch (s) {
      case 'critical': return this.c('red', '⚠');
      case 'high':     return this.c('red', '●');
      case 'medium':   return this.c('yellow', '●');
      case 'low':      return this.c('cyan', '●');
      case 'info':     return this.c('gray', '·');
    }
  }

  private c(name: keyof typeof COLORS, text: string): string {
    if (!this.color) return text;
    return `${COLORS[name]}${text}${COLORS.reset}`;
  }

  private line(s: string): void {
    this.stream.write(`${s}\n`);
  }
}
