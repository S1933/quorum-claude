# Tech Debt Audit - Quorum

Generated: 2026-05-27

## Executive summary

- Quorum is a Bun/TypeScript CLI and Claude Code plugin that runs several AI reviewers against a git diff, parses structured findings, then groups them with a consensus strategy.
- Quality baseline is decent for a young project: `tsc --noEmit` passes, `bun test` passes with 71 tests, `bun audit` reports no known vulnerabilities.
- Main risk is subprocess-provider hardening: several adapters pass full review prompts through argv, allow arbitrary `extra_args`, and duplicate process lifecycle code.
- The CLI entry point has become a god module: command dispatch, review orchestration, init UI, redaction, prompt building, and file writes live in one 450-line file.
- Prompt-injection resistance is weak: raw diffs are inserted inside a markdown fence, so changed code can close the fence and inject reviewer instructions.
- Workspace probing hides important git failures: an invalid base ref can become "No diff detected" instead of an actionable error.
- Performance and cost controls are missing: full diffs, provider outputs, terminal previews, and parallel reviewers are buffered or launched without global budgets.
- Documentation is already drifting from implementation, especially around V1 scope, built-in providers, and external plugin loading.
- Test count is strong for the project size, but coverage is uneven: config interpolation, runtime resolution, renderer edge cases, HTTP error paths, and interactive select are weak.
- Overall project quality: **7.0/10**. The core shape is sound, but release-readiness depends on hardening subprocess execution, diff handling, and CLI boundaries.

## Architectural mental model

The application is a provider-agnostic review runtime. `src/cli/index.ts` is the public entry point. It loads `quorum.yaml`, probes the current git workspace, builds a review instruction from the diff, creates a runtime, resolves a pipeline, and runs reviewers. A reviewer is a persona bound to a provider. Providers are either HTTP adapters (`openrouter`, `ollama`) or subprocess wrappers around local AI CLIs (`claude-code`, `codex-cli`, `continue-dev`, `cursor-agent`, `gemini-cli`, `kilo-code`, `opencode-go`). Results are parsed as JSON findings and aggregated by `overlap-v1`.

Layering mostly follows the architecture doc: `core/` is type-only/pure, `runtime/` wires registries and the event bus, `pipelines/` orchestrates reviewers, `providers/` own transport, `ui/` renders output, and `plugin/commands` shells out to the CLI. The biggest mismatch is plugin/provider extensibility: the architecture says external providers are registered by convention, but the runtime currently imports and registers all built-ins directly.

Important flows:

1. `quorum review` -> config load -> git diff probe -> runtime/provider resolution -> pipeline executor -> provider review -> JSON parse -> consensus -> terminal/markdown/json report.
2. `quorum config` -> config load -> recursive key-based redaction -> JSON print.
3. `quorum init` -> optional interactive provider/persona/model selection -> generated YAML from `quorum.yaml.example` persona templates.
4. Claude Code slash commands -> resolve target repo and CLI -> run `quorum review|config|init`.

Critical dependencies:

- Runtime: Bun >= 1.1, TypeScript, Node-compatible built-ins.
- Config: `yaml`, `zod`.
- External runtime dependencies: git, local AI CLIs (`claude`, `codex`, `gemini`, `kilo`, `opencode`, `cursor-agent`, `cn`) and/or OpenRouter/Ollama endpoints.
- Trust boundary: user git diff, user config, subprocess CLIs, remote AI provider responses.

## Tooling results

- `bun run typecheck`: pass.
- `bun test`: pass, 71 tests.
- `bun test --coverage`: pass; overall 80.77% funcs / 88.18% lines, with weak spots in `src/ui/select.ts`, `src/runtime/runtime.ts`, `src/providers/openrouter/client.ts`, `src/config/interpolate.ts`.
- `bun audit`: pass after network access, no vulnerabilities found.
- `knip`, `madge`, `depcheck`, `ast-grep`, `eslint`: not installed/configured locally.
- Extra static check: `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters` fails on unused imports in `src/consensus/overlap-v1.ts:2`, `src/consensus/overlap-v1.ts:3`, and `tests/pipeline.test.ts:6`.

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|---|---|---:|---|---|---|---|
| F001 | Security | `plugin/commands/quorum-review.md:20` | High | M | Slash-command instructions interpolate `$ARGUMENTS` into a shell command shape without quoting or an argv-safe wrapper. `quorum-init` has the same pattern at `plugin/commands/quorum-init.md:38`. | Replace shell interpolation with a small checked script or explicit argv construction; reject shell metacharacters in plugin arguments. |
| F002 | Security / Performance | `src/providers/opencode-go/index.ts:33` | High | M | **RESOLVED 2026-05-27.** OpenCode Go, Cursor Agent, and Kilo Code now pass only a short stdin instruction in argv and send the full review prompt through stdin. | Keep regression tests that assert malicious prompt text is absent from argv and present in stdin. |
| F003 | Security | `src/providers/claude-code/schema.ts:8` | High | S | **RESOLVED 2026-05-27.** `claude-code.extra_args` and `opencode-go.extra_args` no longer accept arbitrary strings; both now reject unaudited extra args. | Add explicit enum entries only after auditing provider-specific flag safety. |
| F004 | Security | `src/providers/codex-cli/index.ts:46` | High | M | Default `approval_policy: never` maps to `--dangerously-bypass-approvals-and-sandbox`, while the schema defaults to `approval_policy: never` at `src/providers/codex-cli/schema.ts:17`. That makes the safe default questionable for a review-only tool. | Make the default non-bypassing; require explicit opt-in for bypass mode and document the risk. |
| F005 | Security | `src/cli/index.ts:436` | High | M | Diffs are embedded in a markdown code fence with no escaping or delimiter hardening. A malicious diff can include triple backticks and inject reviewer instructions. | Wrap diffs in a length-delimited payload or JSON string; add explicit instruction hierarchy and tests for fence-breaking diffs. |
| F006 | Correctness | `src/runtime/workspace.ts:46` | High | S | Invalid or unreachable base refs are converted to `undefined`, then the CLI reports "No diff detected" at `src/cli/index.ts:186`. This hides configuration/user errors. | Distinguish "no diff" from "git failed"; surface stderr and fail non-zero on invalid `--base`. |
| F007 | Performance / Cost | `src/runtime/workspace.ts:16` | High | M | The full branch diff and untracked diff are buffered, then embedded into a single prompt at `src/cli/index.ts:434`. There is no max total diff size, file filter, or token budget. | Add total byte/token budgets, include/exclude filters, truncation summaries, and an explicit "too large" failure mode. |
| F008 | Architecture | `src/providers/continue-dev/index.ts:42` | High | M | Subprocess lifecycle logic is duplicated across providers: spawn, abort, timeout, stdout preview, stderr read, exit handling, and finding emission. | Extract a shared subprocess runner with timeout classification, stdin/argv policy, env handling, preview events, and normalized errors. |
| F009 | Correctness / Observability | `src/providers/claude-code/index.ts:63` | Medium | S | Claude Code has a timeout timer but no `timedOut` flag, so timeouts are reported as generic exit-code failures at `src/providers/claude-code/index.ts:80`. Other providers classify timeouts distinctly. | Mirror the `timedOut` handling used in `opencode-go`, `codex-cli`, and others. |
| F010 | Architecture | `src/providers/continue-dev/index.ts:132` | Medium | S | JSON-output unwrapping is duplicated in continue, cursor, kilo, and opencode (`normalise*Output`, `parseJson`, `unwrapJsonOutput`). | Move this to a shared provider-output normalizer with provider-specific key lists. |
| F011 | Architecture | `src/runtime/runtime.ts:47` | Medium | M | Built-in providers are manually imported and registered in runtime; init provider metadata is separately duplicated in `src/config/init.ts:40` and `src/config/init.ts:197`. | Introduce provider metadata modules that export factory, init defaults, safe args, and display name from one source. |
| F012 | Consistency | `src/reviewers/builtin/index.ts:3` | Medium | S | Exported `BUILTIN_PERSONAS` has 3 shorter personas, while `quorum.yaml.example:15` has 4 richer personas including `backend-senior`. Consumers and `quorum init` see different defaults. | Use one persona source of truth; generate the example or built-ins from it. |
| F013 | Documentation drift | `docs/ARCHITECTURE.md:441` | Medium | S | Architecture says several implemented providers are out of scope for V1, including Codex, Cursor, Gemini, and Continue at `docs/ARCHITECTURE.md:455`. | Update architecture docs to reflect the actual V1/V1.x state. |
| F014 | Documentation drift | `docs/ARCHITECTURE.md:145` | Medium | M | Docs describe third-party provider plugin discovery by package convention, but runtime only registers hardcoded built-ins at `src/runtime/runtime.ts:47`. | Either implement external provider loading or mark it explicitly as future work. |
| F015 | Maintainability | `src/cli/index.ts:73` | Medium | M | `src/cli/index.ts` is a 450-line mixed-responsibility module: parsing, dispatch, review, init UI, redaction, prompt building, and writing. | Split into `commands/review.ts`, `commands/config.ts`, `commands/init.ts`, `args.ts`, and `report-writer.ts`. |
| F016 | UX / Correctness | `src/cli/index.ts:273` | Low | S | `quorum init` prompts for providers/personas/model before checking repo root, config path, and overwrite status at `src/cli/index.ts:276`. | Resolve path and overwrite decision before interactive prompts. |
| F017 | Correctness | `src/cli/index.ts:439` | Low | S | `writeReport` derives directories with string slicing on `/`, not `path.dirname`, which is non-portable and brittle. | Use `dirname`/`resolve`; normalize report paths consistently. |
| F018 | Correctness | `src/pipelines/executor.ts:47` | Medium | S | Parallel results are pushed as reviewers finish, so report and JSON review order are nondeterministic when `Promise.all` runs at `src/pipelines/executor.ts:73`. | Return `{index,result}` from each reviewer and sort by pipeline reviewer order. |
| F019 | Performance / Cost | `src/pipelines/executor.ts:73` | Medium | M | Parallel pipelines launch all reviewers at once with no concurrency limit, rate-limit handling, or budget guard. | Add `maxConcurrency`, per-provider concurrency, and optional cost/token caps. |
| F020 | Observability | `src/runtime/bus.ts:32` | Low | S | Event listener failures are swallowed to `console.error`, outside Quorum's event/error model. | Emit an internal log/error event or allow a configurable logger. |
| F021 | Observability | `src/runtime/runtime.ts:93` | Low | S | Provider dispose failures are caught and discarded at `src/runtime/runtime.ts:95`. | Record disposal errors in a debug log or aggregate them after best-effort cleanup. |
| F022 | Config / Security | `src/config/interpolate.ts:24` | Medium | S | `env:VAR` can be lazy, but `${VAR}` is resolved eagerly at `src/config/interpolate.ts:47`, despite README/docs presenting both as config interpolation mechanisms. | Make template interpolation lazy too, or document the difference and add tests. |
| F023 | Test debt | `tests/config.test.ts:5` | Medium | S | Config tests cover one schema rejection only; env interpolation, lazy resolution, cross-reference errors, defaults, and provider-specific validation are mostly untested. | Add table-driven config tests for interpolation, missing envs, unknown refs, invalid consensus, and provider schema failures. |
| F024 | Type hygiene | `tsconfig.json:3` | Low | S | Strict mode is enabled, but unused locals/parameters are not. Enabling them currently finds unused imports in `src/consensus/overlap-v1.ts:2`. | Enable `noUnusedLocals` and `noUnusedParameters`; remove current unused imports. |
| F025 | Tooling | `package.json:10` | Medium | S | Scripts only cover CLI run, typecheck, and tests. No lint, format, coverage, dead-code, or circular-dependency check is configured. | Add `lint`, `format:check`, `test:coverage`, `depcheck/knip`, and circular import checks. |
| F026 | DevOps | `.github/workflows/ci.yml:20` | Medium | S | CI uses `bun-version: latest`; `package.json:20` also uses `@types/bun: latest`. Builds can change under the same commit. | Pin Bun and Bun types; update intentionally with dependency PRs. |
| F027 | HTTP resilience | `src/providers/openrouter/client.ts:59` | Medium | M | HTTP clients rely on caller abort signals and provider responses, but there is no provider-level timeout/retry/backoff. Pipeline timeout is optional at `src/config/schema.ts:40`. | Add default provider request timeouts and retry/backoff for retryable failures. |
| F028 | Observability | `src/providers/openrouter/client.ts:124` | Medium | S | Malformed SSE chunks are silently ignored. Ollama stream parsing similarly returns null on parse errors at `src/providers/ollama/client.ts:121`. | Count malformed chunks and emit a debug/warn event; fail if the stream ends without valid content. |
| F029 | API surface | `src/providers/openrouter/index.ts:85` | Low | M | Provider `stream()` methods exist but `PipelineExecutor` always calls `review()` at `src/pipelines/executor.ts:54`; the streaming API is effectively unused. | Either integrate `stream()` into orchestration or remove it until needed. |
| F030 | Report safety | `src/ui/markdown.ts:68` | Low | S | Markdown escaping only handles `<` and `>`. LLM-supplied titles/bodies can inject headings, links, tables, or misleading report structure. | Escape or sanitize markdown-sensitive characters, or render finding bodies in fenced/plain blocks. |
| F031 | Consensus correctness | `src/consensus/overlap-v1.ts:16` | Medium | M | Grouping compares new findings to the current representative only. Since representative can change by severity at `src/consensus/overlap-v1.ts:23`, grouping can become order-dependent. | Match against all group members or use connected components over pairwise matches. |
| F032 | Output contract | `src/reviewers/output.ts:81` | Medium | S | Missing/invalid lines default to line 1, and unknown severity/category default to medium/correctness at `src/reviewers/output.ts:118`. This hides provider contract drift. | Treat invalid required fields as parse errors unless explicitly running in permissive mode. |
| F033 | Output parsing | `src/reviewers/output.ts:135` | Medium | M | Fallback JSON recovery slices from first `{` to last `}`, which can misparse prose containing multiple JSON objects or braces. | Use a small balanced-brace scanner or require exact JSON for providers that support structured output. |
| F034 | Privacy | `src/runtime/workspace.ts:107` | Medium | M | Untracked text files are included by default up to 24KB each; there is a per-file cap at `src/runtime/workspace.ts:125` but no total cap or confirmation. | Add config flags for untracked inclusion, total cap, and denylist for sensitive file patterns. |
| F035 | Privacy / UX | `src/cli/index.ts:197` | Medium | S | Live preview is enabled by default for text output, and `TerminalRenderer` prints raw token previews at `src/ui/terminal.ts:146`. Provider output may quote sensitive code. | Default previews off or redact/truncate more aggressively; keep `--preview` opt-in. |
| F036 | Packaging | `package.json:6` | Low | M | Published entrypoints point directly at TypeScript source (`main` and `bin`) with no build artifact. This is fine for Bun-only usage but fragile for broader npm/library consumers. | Decide whether this is Bun-only; otherwise add a build step and `exports` mapping. |
| F037 | Error handling | `src/runtime/workspace.ts:79` | Medium | S | `runGit` returns `null` on any git failure and discards stderr. Callers cannot explain why workspace probing failed. | Return a discriminated result with stdout, stderr, exit code; map failures to `ConfigError`/`ProviderRuntimeError`. |
| F038 | Config redaction | `src/cli/index.ts:398` | Low | S | Redaction is key-name based only. Secrets stored under nonstandard keys or nested provider-specific headers will print in `quorum config`. | Add provider schema metadata for sensitive fields and redact lazy/template env refs by value origin. |

## Top 5 if you fix nothing else

1. **F002/F003/F008 - Standardize subprocess execution**
   - Create `src/providers/subprocess-runner.ts`.
   - Inputs: binary, cwd, args, stdin, env, timeout, abort signal, reviewer id.
   - Outputs: stdout, stderr, exit code, timedOut, token events.
   - Enforce stdin prompt delivery by default; require explicit exception for argv prompt CLIs.

2. **F005 - Harden prompt construction**
   - Replace markdown fenced diff with a structured envelope:
     ```json
     { "changedFiles": ["..."], "diff": "...", "instruction": "review only this diff" }
     ```
   - Add tests where the diff contains ``` fences, JSON-looking text, and prompt-injection phrases.

3. **F006/F037 - Make workspace probing fail loudly**
   - Replace `string | null` git helpers with `{ ok: true, stdout } | { ok: false, stderr, code }`.
   - Invalid `--base` should exit non-zero with the git error.

4. **F011/F012/F015 - Consolidate provider metadata and CLI modules**
   - Provider modules should export factory + init defaults + safe args + model defaults.
   - CLI command files should consume those modules instead of maintaining parallel switch statements.

5. **F007/F019/F027/F034 - Add budget controls**
   - Add `maxDiffBytes`, `includeUntracked`, `maxConcurrency`, `timeoutMs`, and provider request timeouts.
   - Fail with clear diagnostics when limits are exceeded instead of sending oversized prompts.

## Quick wins

- [ ] F009: Add `timedOut` handling to Claude Code provider.
- [ ] F016: Check overwrite/config path before `quorum init` prompts.
- [ ] F017: Replace `writeReport` string slicing with `path.dirname`.
- [ ] F018: Preserve reviewer order in parallel results.
- [ ] F022: Align `${VAR}` interpolation semantics with `env:VAR`.
- [ ] F024: Enable TypeScript unused checks and remove unused imports.
- [ ] F025: Add `test:coverage` and `lint` scripts.
- [ ] F026: Pin Bun version in CI and `@types/bun`.
- [ ] F028: Emit warnings for malformed stream chunks.
- [ ] F030: Harden markdown escaping.

## Roadmap priorisee

### Phase 1 - Security and correctness hardening

- Fix plugin argument handling and subprocess prompt delivery.
- Make git failures explicit.
- Harden prompt construction against fence-breaking and instruction injection.
- Turn on provider default timeouts.

### Phase 2 - Maintainability refactor

- Extract CLI commands from `src/cli/index.ts`.
- Introduce shared subprocess runner and shared output normalizer.
- Replace duplicated provider/init metadata with a single registry-driven model.
- Align built-in personas with `quorum.yaml.example`.

### Phase 3 - Test and tooling maturity

- Add config/interpolation tests, runtime resolver tests, stream error tests, markdown renderer tests, and plugin command tests.
- Add lint/format/coverage scripts and CI gates.
- Add dead-code and circular-dependency checks.

### Phase 4 - Product scalability

- Add diff size budgets, file filters, untracked-file policy, and concurrency/cost controls.
- Decide whether `stream()` is a supported provider API or future-only surface.
- Update docs to distinguish implemented V1 from future plugin/provider roadmap.

## Examples of concrete refactorings

### Shared subprocess runner

Target files: `src/providers/claude-code/index.ts`, `src/providers/codex-cli/index.ts`, `src/providers/gemini-cli/index.ts`, `src/providers/continue-dev/index.ts`, `src/providers/kilo-code/index.ts`, `src/providers/opencode-go/index.ts`, `src/providers/cursor-agent/index.ts`.

Sketch:

```ts
interface SubprocessRunOptions {
  providerId: string;
  reviewerId: string;
  binary: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal: AbortSignal;
  bus: EventBus;
}

interface SubprocessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
```

Each provider would only build args and call the runner. Timeout, abort cleanup, stdout preview, and error shaping become consistent.

### Provider metadata

Target files: `src/runtime/runtime.ts`, `src/config/init.ts`, provider schema files.

Sketch:

```ts
interface BuiltinProviderDescriptor {
  type: InitProvider;
  factory: ProviderFactory;
  defaultModel?: string;
  initProviderId: string;
  initConfig(model?: string): Record<string, unknown>;
}
```

This removes the repeated provider list, default model switch, provider id switch, and manual runtime registration drift.

### Workspace probe result

Target file: `src/runtime/workspace.ts`.

Sketch:

```ts
type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; code: number; stderr: string };
```

Use it to distinguish clean workspace, invalid base, missing git, and unexpected git failure.

## Tests and quality strategy

- Keep current provider wrapper tests; they are valuable because they pin argv/stdin behavior.
- Add regression tests for the high-risk cases:
  - malicious diff with code fence and prompt-injection text;
  - invalid `--base`;
  - large diff exceeds budget;
  - subprocess timeout classification for every subprocess provider;
  - plugin command argument escaping;
  - config interpolation with `env:VAR`, `${VAR}`, missing vars, and redaction.
- Add behavior tests for report determinism: same reviewer order in JSON/markdown regardless of completion order.
- Add renderer tests for markdown escaping and terminal preview redaction/truncation.
- Add runtime tests for unknown provider/reviewer/pipeline and provider dispose failures.

## DevOps and workflow

- CI is minimal and useful, but not reproducible enough because Bun is `latest`.
- There is no lint/format gate, no coverage threshold, no unused/dead code check, and no circular-dependency check.
- Dependency surface is small (`yaml`, `zod`), and `bun audit` found no vulnerabilities.
- Recommended CI gates:
  1. `bun install --frozen-lockfile`
  2. `bun run typecheck`
  3. `bun test --coverage`
  4. lint/format check
  5. dependency audit
  6. dead-code/circular-dependency check once configured

## Things that look bad but are actually fine

- `core/` being mostly interfaces and types is appropriate here. The domain is orchestration-heavy, so pure type contracts in `src/core/provider.ts`, `src/core/task.ts`, and `src/core/pipeline.ts` are not accidental over-abstraction.
- `ConsensusConfigSchema.catchall(z.unknown())` in `src/config/schema.ts:28` is acceptable for strategy-specific options. The cross-check for `requireAgreement` at `src/config/loader.ts:68` keeps the known option safe.
- Partial reviewer failure policy in `src/pipelines/executor.ts:60` is intentional and correct for a consensus tool. One bad provider should not erase signal from the others.
- Local `quorum.yaml` is gitignored in `.gitignore:5`; I did not inspect it. That is the right default because it may contain local provider credentials.
- The simple overlap consensus in `src/consensus/overlap-v1.ts:64` is acceptable as a V1 algorithm. The debt is order-dependence and test coverage around edge cases, not the lack of semantic embeddings.

## Open questions for the maintainer

- Should Quorum include untracked files by default, or should that be opt-in for privacy?
- Is Codex non-interactive execution allowed to bypass approvals/sandbox in production use, or was that a compatibility workaround?
- Is the project intended to be Bun-only, or should npm/Node library consumers be supported?
- Should external provider plugins be part of the near-term contract, or should docs mark that as future work?
- Should live token preview be on by default, or should report-only output be the safer default?
