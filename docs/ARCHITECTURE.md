# Quorum — Architecture

> Status: **draft v0.1** · scope: design, not implementation · last updated 2026-05-22

Quorum is a provider-agnostic review runtime for AI-assisted code changes. Its differentiator is **multi-model consensus review**: when implementation is complete, the same reviewer persona is run across multiple providers, and a consensus engine aggregates and deduplicates findings like a team review meeting made only of LLM reviewers.

This document defines the domain model, layer boundaries, interfaces, and V1 cut. It deliberately defers anything not load-bearing for the first working version.

---

## 1. Design principles

1. **Provider ≠ Model.** Providers are access points (HTTP/subprocess/SDK). Models are configuration *within* a provider. OpenRouter, LiteLLM, and Ollama each expose many models — the abstraction must reflect that.
2. **Personas are portable.** A persona (system prompt + role) is decoupled from any provider. The same `paranoid-security` persona running on two different providers is the unit of consensus.
3. **Core has no I/O.** `core/` defines types and pure logic. All network, filesystem, and subprocess work lives in `providers/` or `runtime/`.
4. **Event-driven, not callback soup.** A single event bus carries lifecycle events. UIs subscribe; they do not poll.
5. **Provider variety validates the seam.** Quorum ships HTTP and local subprocess adapters, but they all satisfy the same review-focused provider interface.
6. **No premature consensus.** V1 consensus = group findings by file+line overlap and emit an "N agreed" badge. Embedding-based semantic dedup and trust scoring are roadmap, not V1.
7. **Claude Code plugin is a *distribution*, not the *runtime*.** The core is a Bun library + CLI; the plugin is a thin slash-command adapter.

---

## 2. Domain model

The vocabulary the rest of the codebase enforces.

| Concept | What it is | What it is *not* |
|---|---|---|
| **Provider** | A registered runtime that can review prompts/diffs. Owns auth, transport, model dispatch. | A specific model. A reviewer. A persona. |
| **Model** | A string identifier (e.g. `anthropic/claude-opus-4`) plus per-call parameters (temperature, max tokens). Lives inside provider config. | An object with behavior. It's data. |
| **Persona** | A system prompt + role declaration + (optional) output schema hint. | Bound to a provider. |
| **Reviewer** | `(Persona, ProviderRef, overrides)` — a persona *bound* to a provider for execution. | A persona. A provider. |
| **ReviewTask** | "Critique this." Diff, files, or prompt + persona-targeted instruction. Producer of `Finding[]`. | An implementation task. |
| **Finding** | One issue: `{file, lineRange, severity, category, title, body, reviewer}`. | A whole review. |
| **Pipeline** | A named, ordered or parallel set of `ReviewerRef`s with optional consensus config. | A reviewer. |
| **Consensus** | Aggregation/dedup/contradiction-detection across `ReviewResult`s. | Voting infrastructure (deferred). |

Three-tier hierarchy: **Provider → Reviewer → Pipeline.** Personas hang off Reviewers. Findings flow up through Consensus.

---

## 3. Layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Distribution: Claude Code plugin · CLI · (future: web UI)   │
├──────────────────────────────────────────────────────────────┤
│  UI: terminal renderer · markdown/json reports               │
├──────────────────────────────────────────────────────────────┤
│  Runtime: event bus · plugin lifecycle · config loader       │
├──────────────────────────────────────────────────────────────┤
│  Pipelines: parallel/sequential executor · timeout · retry   │
├──────────────────────────────────────────────────────────────┤
│  Reviewers (Persona+Provider binding)   Consensus engine     │
├──────────────────────────────────────────────────────────────┤
│  Provider adapters: openrouter · ollama · claude-code · codex-cli │
│  · gemini-cli · continue-dev · kilo-code · opencode-go · cursor  │
├──────────────────────────────────────────────────────────────┤
│  Core: types, schemas, pure logic — no I/O                   │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. `core/` imports nothing from the project. `providers/` import from `core/`. `pipelines/` import from `core/` + `providers/` (via interface). UI imports from runtime events. Distribution wraps everything.

---

## 4. Provider abstraction

The single load-bearing interface.

```ts
// src/core/provider.ts
export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind; // 'http' | 'subprocess' | 'sdk'

  capabilities(): ProviderCapabilities;

  review?(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult>;

  // Optional: providers that natively stream emit events; orchestrator falls back to non-streaming.
  stream?(task: ReviewTask, ctx: ExecCtx): AsyncIterable<ProviderEvent>;

  dispose?(): Promise<void>;
}

export interface ProviderCapabilities {
  review: boolean;         // can it produce structured findings?
  streaming: boolean;
  tools: boolean;          // function/tool calling
  mcp: boolean;            // MCP server support
  localExecution: boolean; // runs on-host (ollama, claude-code SDK)
  backgroundJobs: boolean; // can detach long-running tasks
  costReporting: boolean;  // returns token/$ usage
}

export interface ExecCtx {
  bus: EventBus;
  signal: AbortSignal;
  workspace: WorkspaceInfo;
  modelOverride?: ModelConfig;
}
```

**Design choices:**

- `review` is the load-bearing provider method. Providers may wrap HTTP APIs, local CLIs, or SDKs, but Quorum only asks them for structured review findings.
- `kind` exposes the *shape* of the adapter (HTTP, subprocess, SDK) so the runtime can apply shape-specific concerns (subprocess providers get spawn budgets; HTTP providers get rate-limit handling).
- `stream` is optional with a non-streaming fallback. Forces no provider to invent fake streaming.
- `ExecCtx` carries the event bus by reference — providers emit events, they don't return them. Decouples observability from return values.

**ProviderEvent contract:**

```ts
type ProviderEvent =
  | { type: 'token';   text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'finding'; finding: Finding }
  | { type: 'log';     level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'usage';   inputTokens: number; outputTokens: number; costUsd?: number };
```

Bounded, finite event set. Anything new requires a discriminator addition (caught by exhaustive switch in TS).

---

## 5. Provider registry & plugin lifecycle

Providers are registered, not imported, so external plugins can drop them in.

```ts
// src/runtime/registry.ts
export interface ProviderFactory {
  type: string;                                 // 'openrouter', 'claude-code', 'ollama', …
  schema: z.ZodTypeAny;                         // zod schema for this provider's config block
  create(config: unknown, ctx: PluginCtx): Promise<Provider>;
}

export class ProviderRegistry {
  register(factory: ProviderFactory): void;
  resolve(type: string): ProviderFactory | undefined;
  instantiate(type: string, cfg: unknown, ctx: PluginCtx): Promise<Provider>;
}
```

Lifecycle: `register` → (config load) → `create` → (use) → `dispose`. Built-in providers (openrouter, ollama, claude-code, codex-cli, gemini-cli, continue-dev, kilo-code, opencode-go, cursor-agent) are registered at runtime boot. External provider plugins are **not yet supported** — the registry API is designed to accommodate them, but no discovery or loading mechanism exists. A future `@quorum/plugin-*` package convention is under consideration for V1.x.

---

## 6. Configuration schema

YAML, validated via zod, env interpolation via `env:VAR` and `${VAR}`.

```yaml
# quorum.yaml
version: 1

defaults:
  pipeline: default

providers:
  openrouter-claude:
    type: openrouter
    api_key: env:OPENROUTER_API_KEY
    model: anthropic/claude-opus-4
    temperature: 0.2

  openrouter-gpt:
    type: openrouter
    api_key: env:OPENROUTER_API_KEY
    model: openai/gpt-5-codex
    temperature: 0.2

  claude-code-local:
    type: claude-code
    model: claude-opus-4-7

personas:
  security:
    description: Adversarial security review
    system: |
      You are an adversarial security reviewer. Focus on injection,
      authn/authz, secret handling, and unsafe deserialization. Be specific.

  performance:
    description: Latency and resource cost review
    system: |
      You are a performance reviewer. Flag N+1 queries, sync I/O on hot paths,
      unbounded loops, memory leaks. Cite line numbers.

  architecture:
    description: Maintainability and design review
    system: |
      You are a principal engineer. Focus on layering violations, leaky
      abstractions, and testability. Prefer fewer, deeper findings.

reviewers:
  sec-opus:    { persona: security,     provider: openrouter-claude }
  sec-gpt:     { persona: security,     provider: openrouter-gpt }
  perf-opus:   { persona: performance,  provider: openrouter-claude }
  arch-opus:   { persona: architecture, provider: openrouter-claude }

pipelines:
  default:
    parallel: true
    reviewers: [sec-opus, perf-opus, arch-opus]
    consensus: { strategy: overlap-v1 }

  consensus-security:
    parallel: true
    reviewers: [sec-opus, sec-gpt]      # same persona, different providers
    consensus: { strategy: overlap-v1, requireAgreement: 2 }
```

**Schema notes:**

- `providers` is a map keyed by *instance id*, not by type — you can have many `openrouter`-typed providers with different models.
- `reviewers` are the binding layer. Three-tier hierarchy is visible in the file structure.
- Pipelines reference reviewers by id; they never embed persona/provider inline. Forces reuse.
- `consensus.strategy` is a registry key; V1 ships `overlap-v1` only.

Loader resolves `env:` lazily so missing keys fail at provider instantiation, not at config-parse time — better error locality.

---

## 7. Orchestration engine

Two execution modes for V1: **parallel** and **sequential**. No DAG yet.

```ts
// src/pipelines/pipeline.ts
export interface PipelineExecutor {
  run(pipeline: Pipeline, task: ReviewTask, ctx: ExecCtx): Promise<PipelineResult>;
}

export interface PipelineResult {
  pipelineId: string;
  reviews: ReviewResult[];         // one per reviewer
  consensus: ConsensusResult;       // produced by the consensus engine
  durationMs: number;
  errors: ReviewerError[];          // partial-failure tolerated
}
```

**Failure policy (V1):** *continue on reviewer failure*, surface the error in the report. Aborting the whole pipeline because one reviewer's API key is bad is the wrong default — the user wants partial signal.

**Cancellation:** Single `AbortSignal` from the entry point propagates to all reviewers via `ExecCtx`. Pipeline-level timeout cancels all in-flight reviewers and emits a `pipeline.timeout` event.

**Backpressure:** Parallel pipelines run all reviewers concurrently. If a user configures 10 reviewers all hitting OpenRouter with the same key, that's their bandwidth problem in V1; rate-limit-aware scheduling is V2.

---

## 8. Consensus engine

The interesting part. Kept deliberately minimal in V1.

```ts
// src/consensus/consensus.ts
export interface ConsensusStrategy {
  id: string;
  aggregate(reviews: ReviewResult[], cfg: unknown): ConsensusResult;
}

export interface ConsensusResult {
  groups: FindingGroup[];           // overlapping/duplicate findings collapsed
  agreement: Record<string, number>; // groupId -> # of reviewers that raised it
  unique: Finding[];                // findings raised by exactly one reviewer
  contradictions: Contradiction[];  // V2 — empty array in V1
}

export interface FindingGroup {
  id: string;
  representative: Finding;          // chosen for display
  members: Finding[];               // every finding in this group
  reviewers: string[];              // unique reviewer ids that contributed
}
```

**V1 strategy: `overlap-v1`**

Group two findings together iff:
1. Same file path, *and*
2. Line ranges overlap (or are within ±2 lines), *and*
3. Same category (`security` | `performance` | `architecture` | `correctness` | `style`).

Title/body are *not* compared semantically. Lexical near-duplicates may still be split — that's acceptable for V1. The "N reviewers agreed" badge gives the user signal even if grouping isn't perfect.

**V2 roadmap (not built):**
- Embedding-based semantic grouping (cosine similarity on title+body).
- LLM-based meta-reviewer for contradiction detection.
- Per-reviewer trust scores from user feedback (👍/👎 in the UI).
- Weighted voting where reviewers known to hallucinate get downweighted.

**Why this is enough:** the user gets *some* signal about which findings are widely agreed-upon — the central UX promise. Perfect dedup is not required to deliver that.

---

## 9. Event system

Single in-process pub/sub. `EventBus` is the only cross-cutting collaborator besides `core/` types.

```ts
type QuorumEvent =
  | { type: 'pipeline.started';  pipelineId: string; reviewers: string[] }
  | { type: 'reviewer.started';  reviewerId: string }
  | { type: 'reviewer.event';    reviewerId: string; event: ProviderEvent }
  | { type: 'reviewer.finished'; reviewerId: string; result: ReviewResult }
  | { type: 'reviewer.failed';   reviewerId: string; error: ReviewerError }
  | { type: 'pipeline.finished'; result: PipelineResult }
  | { type: 'pipeline.timeout' };

export interface EventBus {
  emit(e: QuorumEvent): void;
  on<K extends QuorumEvent['type']>(type: K, fn: (e: Extract<QuorumEvent, {type: K}>) => void): () => void;
}
```

The terminal renderer subscribes to runtime events for live progress. Markdown and JSON reports render the final `PipelineResult`, keeping report generation deterministic and easy to test.

---

## 10. Claude Code plugin layer

V1 distribution. Lives under `plugin/`.

**Slash commands (initial):**
- `/quorum-review` — Run the `default` pipeline on the current diff (`git diff` vs default branch). Renders the consensus report inline.
- `/quorum-config` — Show the loaded `quorum.yaml`, with `env:` redacted.

**Optional surfaces (V1.x):**
- A hook that runs `/quorum-review` post-commit and writes a markdown report to `.quorum/last-review.md`.
- An MCP server exposing `quorum.review_diff` as a tool callable from Claude inside Claude Code.

**Boundary contract:** the slash command is a *thin* shell — it parses args, loads config, invokes the library entry point, subscribes to events, prints. Zero domain logic in the command file. This is what lets us extract a standalone CLI later for free.

---

## 11. Folder structure

```
quorum/
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json
│   └── commands/
│       ├── quorum-review.md
│       └── quorum-config.md
├── src/
│   ├── core/                # types, schemas, errors. No I/O.
│   │   ├── provider.ts
│   │   ├── task.ts
│   │   ├── finding.ts
│   │   ├── persona.ts
│   │   ├── pipeline.ts
│   │   ├── events.ts
│   │   └── errors.ts
│   ├── providers/
│   │   ├── registry.ts
│   │   ├── subprocess.ts          # shared runner + output normaliser
│   │   ├── openrouter/            # HTTP provider
│   │   ├── ollama/                # HTTP provider
│   │   ├── claude-code/           # subprocess provider
│   │   ├── codex-cli/             # subprocess provider
│   │   ├── gemini-cli/            # subprocess provider
│   │   ├── continue-dev/          # subprocess provider
│   │   ├── kilo-code/             # subprocess provider
│   │   ├── opencode-go/           # subprocess provider
│   │   └── cursor-agent/          # subprocess provider
│   ├── reviewers/
│   │   ├── reviewer.ts     # binding logic
│   │   └── builtin/        # ships with security/performance/architecture personas
│   ├── pipelines/
│   │   ├── executor.ts
│   │   └── parallel.ts
│   ├── consensus/
│   │   ├── registry.ts
│   │   └── overlap-v1.ts
│   ├── config/
│   │   ├── schema.ts
│   │   ├── loader.ts
│   │   └── interpolate.ts
│   ├── runtime/
│   │   ├── bus.ts
│   │   ├── plugin.ts
│   │   └── workspace.ts
│   ├── ui/
│   │   ├── terminal.ts
│   │   ├── markdown.ts
│   │   └── json.ts
│   └── cli/
│       └── index.ts        # bun entrypoint; reused by Claude Code commands
├── tests/
├── docs/
│   └── ARCHITECTURE.md     # this doc
├── quorum.yaml.example
├── bunfig.toml
├── package.json
├── tsconfig.json
└── README.md
```

**Key observation:** `src/cli/index.ts` is the single entry point. The Claude Code slash commands shell out to it with stable, scriptable args. The same binary is the future standalone CLI.

---

## 12. V1 implementation strategy

Six milestones, each independently shippable.

| # | Milestone | Definition of done |
|---|---|---|
| M1 | **Core types + config loader** | `quorum.yaml.example` parses, zod validates, env interpolation works, tests pass. No providers wired. |
| M2 | **OpenRouter provider** | A review request round-trips through OpenRouter and returns structured findings plus token usage. |
| M3 | **Claude Code provider** | The same review task runs against Claude Code locally. Validates the abstraction across HTTP vs subprocess shapes. |
| M4 | **Parallel pipeline + overlap-v1 consensus** | `quorum review` on a diff runs 2 reviewers in parallel, prints grouped findings with "N agreed" badges. |
| M5 | **Terminal + markdown renderers** | Both renderers subscribe to events, produce live terminal output, and write a final `.quorum/last-review.md`. |
| M6 | **Claude Code plugin shell** | `/quorum-review` works end-to-end inside Claude Code after an implementation is complete. |

Each milestone gates on the prior one. No provider work before M1's config loader is solid — fixing config-parsing bugs after providers exist is much more expensive.

---

## 13. Risks & pragmatic tradeoffs

| Risk | Mitigation |
|---|---|
| **Provider interface ossifies too early.** | Build M2 + M3 (HTTP + SDK) before generalizing. Two real implementations beat any amount of upfront design. |
| **Consensus engine becomes a research project.** | Ship `overlap-v1` and resist embedding work until users ask. The badge is more valuable than the algorithm. |
| **Subprocess providers have varied I/O.** | Validated. Seven subprocess providers (claude-code, codex-cli, gemini-cli, continue-dev, kilo-code, opencode-go, cursor-agent) share a common `runSubprocess()` runner with provider-specific args building and output normalization. The `kind: 'subprocess'` abstraction held up well. |
| **Streaming is inconsistent across providers.** | Capability flag + fallback. UI must work without streaming; streaming is an upgrade, not a contract. |
| **Claude Code plugin API drift.** | The plugin layer is intentionally thin (markdown commands shelling to `src/cli`). If Claude Code's plugin shape changes, only the plugin layer is affected. |
| **Cost runaway with parallel pipelines.** | V1 ships with per-pipeline reviewer count printed up front. V2 adds budget guards. |
| **YAML config sprawl.** | Built-in personas + a starter `quorum.yaml.example`. Most users should be able to run a sensible default with no config. |

---

## 14. Out of scope for V1

Explicit deferrals — capture here so they don't sneak in.

- DAG-based pipelines (parallel + sequential only).
- Embedding-based semantic dedup.
- Contradiction detection between reviewers.
- Per-reviewer trust scores and weighted voting.
- Web dashboard / SaaS UI.
- Distributed reviewer execution / remote workers.
- Provider marketplace / plugin registry.
- Cost-optimizing smart router.
- Persistent memory across reviews.
- GitHub Action / CI integration (planned for V1.x but not V1).
- Aider and LiteLLM review providers (planned post-V1).

**Implemented since initial draft:** Codex CLI, Cursor Agent, Gemini CLI, Continue.dev, Kilo Code, and OpenCode Go are now shipped as built-in subprocess providers alongside the original OpenRouter, Claude Code, and Ollama adapters.

---

## 15. Open questions

To resolve before M1:

1. **Reviewer config inheritance** — should `reviewers.sec-opus` be able to override `provider.openrouter-claude.temperature`? Leaning yes, but adds schema surface. *(Recommendation: yes, allow `overrides: { temperature, maxTokens, topP }` on the reviewer block only.)*
2. **How are findings parsed back from providers?** Options: ask the model for JSON via response-format; parse markdown headings; tool-call a `report_finding` function. *(Recommendation: tool-calling where the provider supports it; structured-output JSON fallback; markdown parsing as last resort.)*
3. **Workspace context boundary** — does Quorum read files itself or rely on the host (Claude Code) to provide diff content? *(Recommendation: Quorum reads via `git` directly; Claude Code passes only the repo root + base ref. Keeps the CLI usable standalone.)*

These are flagged but not blocking — defaults above are good enough to start M1.
