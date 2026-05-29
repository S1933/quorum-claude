import type { EventBus } from '../core/events.ts';
import type { Finding, Severity } from '../core/finding.ts';

const PRIORITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

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
  private readonly previews = new Map<string, string>();
  private readonly lastPreviewAt = new Map<string, number>();

  constructor(opts: TerminalRendererOptions) {
    this.stream = opts.stream;
    this.color = opts.color ?? true;
    this.showTokens = opts.showTokens ?? false;
  }

  attach(bus: EventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('pipeline.started', (e) => {
        this.line(`${this.c('cyan', '🧭')}  pipeline ${this.c('bold', e.pipelineId)} · ${e.reviewers.length} reviewer(s)`);
        this.line(this.c('dim', `    ${e.reviewers.join(', ')}`));
      }),
    );
    unsubs.push(
      bus.on('reviewer.started', (e) => {
        this.line(`${this.c('dim', '  ⏳')} ${e.reviewerId} started`);
      }),
    );
    unsubs.push(
      bus.on('reviewer.event', (e) => {
        if (e.event.type === 'token' && this.showTokens) {
          this.renderPreview(e.reviewerId, e.event.text);
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
        this.line(`${this.c('green', '  ✅')} ${e.reviewerId} finished · ${n} finding${n === 1 ? '' : 's'} ${this.c('dim', `(${this.formatDuration(e.result.durationMs)})`)}`);
      }),
    );
    unsubs.push(
      bus.on('reviewer.failed', (e) => {
        this.line(`${this.c('red', '  ❌')} ${e.reviewerId} failed: ${e.error.message}`);
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
        this.renderSummary(e.result.consensus.groups, e.result.consensus.unique, e.result.errors.length);
        this.line('');
        this.line(this.c('bold', '── 🔎 Findings by priority ──'));
        this.renderConsensus(e.result.consensus.groups, e.result.consensus.unique);
        this.line('');
        this.line(this.c('dim', `pipeline ${e.result.pipelineId} done in ${this.formatDuration(e.result.durationMs)} (${e.result.reviews.length} reviews, ${e.result.errors.length} errors)`));
      }),
    );

    return () => {
      for (const u of unsubs) u();
    };
  }

  private renderSummary(
    groups: Array<{ id: string; representative: Finding; members: Finding[]; reviewers: string[] }>,
    unique: Finding[],
    errors: number,
  ): void {
    const allFindings = [...groups.flatMap((g) => g.members), ...unique];
    const total = allFindings.length;
    const counts = PRIORITIES
      .map((priority) => `${this.severityIcon(priority)} ${priority}:${allFindings.filter((f) => f.severity === priority).length}`)
      .join('  ');

    this.line(this.c('bold', '── 📊 Review summary ──'));
    this.line(`   ${total} finding${total === 1 ? '' : 's'} · ${groups.length} agreement group${groups.length === 1 ? '' : 's'} · ${unique.length} single-reviewer · ${errors} error${errors === 1 ? '' : 's'}`);
    this.line(`   ${counts}`);
  }

  private renderConsensus(
    groups: Array<{ id: string; representative: Finding; members: Finding[]; reviewers: string[] }>,
    unique: Finding[],
  ): void {
    if (groups.length === 0 && unique.length === 0) {
      this.line(this.c('green', '  ✅ no findings'));
      return;
    }

    for (const priority of PRIORITIES) {
      const priorityGroups = groups
        .filter((g) => g.representative.severity === priority)
        .sort((a, b) => b.reviewers.length - a.reviewers.length);
      const priorityUnique = unique.filter((f) => f.severity === priority);
      if (priorityGroups.length === 0 && priorityUnique.length === 0) continue;

      this.line('');
      this.line(this.c('bold', `${this.severityIcon(priority)} ${this.severityLabel(priority)} (${priorityGroups.length + priorityUnique.length})`));
      for (const g of priorityGroups) {
        const f = g.representative;
        const badge = this.c('magenta', `🤝 ${g.reviewers.length} agreed`);
        this.line(`${this.severityIcon(f.severity)} ${this.c('bold', f.title)} ${badge} ${this.c('dim', `(${f.file}:${f.lineRange.start}-${f.lineRange.end})`)}`);
        if (f.body) this.line(`   ${f.body.replace(/\n/g, '\n   ')}`);
        this.line(this.c('dim', `   ${this.categoryIcon(f.category)} ${f.category} · reviewers: ${g.reviewers.join(', ')}`));
      }
      for (const f of priorityUnique) {
        this.line(`${this.severityIcon(f.severity)} ${f.title} ${this.c('dim', `(${f.file}:${f.lineRange.start}-${f.lineRange.end}, ${this.categoryIcon(f.category)} ${f.category}, ${f.reviewer})`)}`);
      }
    }
  }

  private severityIcon(s: Finding['severity']): string {
    switch (s) {
      case 'critical': return this.c('red', '🚨');
      case 'high':     return this.c('red', '🔥');
      case 'medium':   return this.c('yellow', '⚠️');
      case 'low':      return this.c('cyan', '🧊');
      case 'info':     return this.c('gray', 'ℹ️');
    }
  }

  private severityLabel(s: Finding['severity']): string {
    return s[0]!.toUpperCase() + s.slice(1);
  }

  private categoryIcon(category: Finding['category']): string {
    switch (category) {
      case 'security': return '🔐';
      case 'performance': return '⚡';
      case 'architecture': return '🏗️';
      case 'correctness': return '✅';
      case 'style': return '🎨';
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private renderPreview(reviewerId: string, chunk: string): void {
    const next = `${this.previews.get(reviewerId) ?? ''}${chunk}`;
    this.previews.set(reviewerId, next);

    const now = Date.now();
    const last = this.lastPreviewAt.get(reviewerId) ?? 0;
    if (now - last < 500 && next.length < 240) return;
    this.lastPreviewAt.set(reviewerId, now);

    const preview = next
      .replace(/\s+/g, ' ')
      .trim()
      .slice(-220);
    if (!preview) return;
    this.line(`${this.c('gray', `   [${reviewerId}]`)} ${preview}`);
  }

  private c(name: keyof typeof COLORS, text: string): string {
    if (!this.color) return text;
    return `${COLORS[name]}${text}${COLORS.reset}`;
  }

  private line(s: string): void {
    this.stream.write(`${s}\n`);
  }
}
