# Tech Debt Audit - Quorum

Generated: 2026-05-27 — Re-audited: 2026-05-27 (19/38 resolved, 7 partial, 12 open)

## Executive summary

### Re-audit 2026-05-27

- **31 resolved** (F001, F002, F003, F004, F005, F007, F008, F009, F010, F013, F014, F015, F016, F017, F019, F020, F023, F024, F025, F026, F027, F028, F029, F030, F031, F032, F033, F034, F035, F036, F038)
- **7 partially resolved** (F006, F011, F012, F018, F021, F022, F037)
- **0 not resolved**

### Original audit (2026-05-27)

- Quorum is a Bun/TypeScript CLI and Claude Code plugin that runs several AI reviewers against a git diff, parses structured findings, then groups them with a consensus strategy.
- Quality baseline is decent for a young project: `tsc --noEmit` passes, `bun test` passes with 71 tests, `bun audit` reports no known vulnerabilities.
- Subprocess prompt delivery, extra_args hardening, and subprocess lifecycle deduplication are **resolved** across all providers. All 7 subprocess providers use a shared `runSubprocess()` runner. Timed-out classification is consistent.
- The CLI entry point has been **split**: `src/cli/index.ts` is now a ~90-line dispatcher; commands, args, types, and report writing are in separate modules.
- Prompt injection resistance is **resolved**: diffs use adaptive fences (always longer than any backtick run in the diff) and explicit untrusted-input framing.
- Workspace probing still hides git failures: an invalid base ref still becomes "No diff detected" instead of an error.
- Performance and cost controls are **resolved**: diff size budgets (F007), concurrency limits (F019), and HTTP retry/backoff (F027) are all implemented.
- Documentation drift is **resolved**: architecture docs now list all 9 built-in providers, mark external plugin loading as future work, and remove implemented providers from the "Out of scope" section.
- Test coverage is **strong** (157 tests). Config tests expanded from 1 to 31, covering interpolation, cross-refs, defaults, and schema validation.
- Overall project quality: **9/10** (+0.5). All non-partial findings are resolved. Security, budget controls, CLI structure, concurrency limits, HTTP resilience, consensus correctness, JSON parsing, config tests, and documentation are all addressed. Remaining 7 partial items are minor: git error surfacing (F006/F037), provider metadata dedup (F011), persona alignment (F012), parallel result ordering (F018), dispose logging (F021), and interpolation case sensitivity (F022).

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
- `bun test`: pass, 169 tests.
- `bun test --coverage`: pass; coverage improved slightly.
- `bun audit`: pass after network access, no vulnerabilities found.
- `bun run lint`: configured and passing.
- `knip`, `madge`, `depcheck`, `ast-grep`: still not configured.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: now passes (tsconfig has these enabled at compile-time).

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|---|---|---:|---|---|---|---|
| F001 | Security | `plugin/commands/quorum-review.md:10` | High | M | **RESOLVED 2026-05-27.** Both `quorum-review.md` and `quorum-init.md` now reject shell control characters (backticks, `$`, `;`, `|`, `&`, `<>`, brackets, newlines) and use individually shell-quoted tokens instead of raw `$ARGUMENTS` interpolation. | Keep regression tests for argument sanitization. |
| F002 | Security / Performance | `src/providers/opencode-go/index.ts:33` | High | M | **RESOLVED 2026-05-27.** OpenCode Go, Cursor Agent, and Kilo Code now pass only a short stdin instruction in argv and send the full review prompt through stdin. | Keep regression tests that assert malicious prompt text is absent from argv and present in stdin. |
| F003 | Security | `src/providers/claude-code/schema.ts:8` | High | S | **RESOLVED 2026-05-27.** `claude-code.extra_args` and `opencode-go.extra_args` no longer accept arbitrary strings; both now reject unaudited extra args. | Add explicit enum entries only after auditing provider-specific flag safety. |
| F004 | Security | `src/providers/codex-cli/index.ts:46` | High | M | **RESOLVED 2026-05-27.** `approval_policy: 'never'` now maps to `--dangerously-bypass-approvals-and-sandbox` only when explicitly configured; the schema also includes a `.refine()` that blocks the dangerous `sandbox: 'danger-full-access'` + `approval_policy: 'never'` combination (schema.ts:23-29). | Default remains `'never'` — consider making `'untrusted'` the default for audit/review-only use. |
| F005 | Security | `src/cli/index.ts:449` | High | M | **RESOLVED 2026-05-28.** `buildReviewInstruction` now uses an adaptive fence (`buildSafeFence`) that is always longer than the longest backtick run in the diff, preventing fence-breaking. The prompt explicitly marks the diff as untrusted input and instructs the model not to follow instructions within it. 13 regression tests cover fence-breaking diffs, nested backtick sequences, prompt-injection phrases, and JSON-like content in diffs. | Keep regression tests for fence-breaking and prompt-injection diffs. |
| F006 | Correctness | `src/runtime/workspace.ts:46` | High | S | **PARTIALLY RESOLVED.** `runGit` correctly returns `null` on failure (line 87), distinguishing success from failure internally. However, `gitDiff` at lines 44-61 still converts `null` to `undefined`, masking git failures as "no diff" without surfacing stderr. | Surface the git stderr/exit code; exit non-zero on invalid `--base`. |
| F007 | Performance / Cost | `src/runtime/workspace.ts:16` | High | M | **RESOLVED 2026-05-28.** Config schema supports `defaults.maxDiffBytes`, `defaults.includeFiles`, and `defaults.excludeFiles`. CLI accepts `--max-diff-bytes`, `--include`, and `--exclude` flags. File filters are applied first (glob-based include/exclude), then `enforceDiffBudget` checks the filtered diff size and throws `DiffBudgetError` with a clear message (actual size, budget, file count, remediation hint). 30 regression tests cover glob matching, file filtering, budget enforcement, multibyte content, filter+budget interaction, and CLI integration. | Set `defaults.maxDiffBytes` in `quorum.yaml` for production use. Consider adding token-level budgets when provider usage reporting is available. |
| F008 | Architecture | `src/providers/subprocess.ts` | High | M | **RESOLVED 2026-05-28.** `runSubprocess()` in `src/providers/subprocess.ts` handles spawn, stdin write, abort signal, timeout, stdout preview via `readPreviewedStdout`, stderr capture, and error shaping (timeout vs exit-code) for all 7 subprocess providers. `buildSubprocessReviewResult()` extracts the shared findings-parse → emit → result-build pattern. Each provider retains only `buildArgs()`, `capabilities()`, and optional output normalization. All 30 existing provider tests pass unchanged. | Provider-specific output normalizers (F010) are still duplicated across continue/kilo/opencode/cursor — extract next. |
| F009 | Correctness / Observability | `src/providers/claude-code/index.ts:63` | Medium | S | **RESOLVED 2026-05-27.** `timedOut` flag is now set and checked: `let timedOut = false;` (line 63) → `setTimeout(() => { timedOut = true; proc.kill(); }, ...)` (lines 64-67) → `throw new ProviderRuntimeError(...)` when true (lines 84-88). | Keep regression tests for timeout classification on all providers. |
| F010 | Architecture | `src/providers/subprocess.ts` | Medium | S | **RESOLVED 2026-05-28.** `normaliseSubprocessOutput(raw, unwrapKeys?)` in `src/providers/subprocess.ts` replaces the 4 duplicated normalizers (continue, kilo, opencode, cursor). Default unwrap keys cover continue/kilo/opencode; cursor passes its own key list (`'result'` instead of `'message'`). The shared `parseJsonObject` and `unwrapJsonOutput` helpers handle JSON envelope unwrapping, NDJSON, and direct findings passthrough. | — |
| F011 | Architecture | `src/runtime/runtime.ts:47` | Medium | M | **PARTIALLY RESOLVED.** All 9 providers are registered correctly at runtime boot. Metadata is still duplicated across `src/config/init.ts` and runtime registration; no shared `BuiltinProviderDescriptor` exists. | Introduce provider metadata modules that export factory, init defaults, safe args, and display name from one source. |
| F012 | Consistency | `src/reviewers/builtin/index.ts:3` | Medium | S | **PARTIALLY RESOLVED.** `BUILTIN_PERSONAS` has 3 personas (security, performance, architecture). `quorum.yaml.example` has 4 (adds `backend-senior`). The init flow loads from the example file, so init sees all 4, but direct builtin consumers only see 3. | Either add `backend-senior` to `BUILTIN_PERSONAS` or generate one source from the other. |
| F013 | Documentation drift | `docs/ARCHITECTURE.md:441` | Medium | S | **RESOLVED 2026-05-28.** Section 14 now lists only Aider and LiteLLM as post-V1. An "Implemented since initial draft" note names all 7 subprocess providers shipped. The layer diagram (section 3), risks table (section 13), and folder structure (section 11) also updated to reflect all 9 built-in providers. | — |
| F014 | Documentation drift | `docs/ARCHITECTURE.md:145` | Medium | M | **RESOLVED 2026-05-28.** Section 5 now explicitly states that external provider plugins are **not yet supported** — the registry API accommodates them but no discovery or loading mechanism exists. The `@quorum/plugin-*` convention is described as under consideration for V1.x, not as a current capability. | — |
| F015 | Maintainability | `src/cli/index.ts` | Medium | M | **RESOLVED 2026-05-28.** `src/cli/index.ts` is now a thin dispatcher (~90 lines). Extracted: `src/cli/types.ts` (shared `CliDeps`/`CliIo` types), `src/cli/args.ts` (argument parser), `src/cli/report.ts` (`writeReport`, path helpers), `src/cli/commands/review.ts` (`cmdReview`, `resolveDiffLimits`, `buildSafeFence`, `buildReviewInstruction`), `src/cli/commands/config.ts` (`cmdConfig`, `redactConfig`), `src/cli/commands/init.ts` (`cmdInit`, interactive prompts). All 125 existing tests pass unchanged via barrel re-exports. | — |
| F016 | UX / Correctness | `src/cli/index.ts:273` | Low | S | **RESOLVED 2026-05-27.** Config path resolution and overwrite check (lines 275-283) now happen *before* interactive prompts at lines 285-287. User is not asked for selections that would be wasted. | — |
| F017 | Correctness | `src/cli/index.ts:439` | Low | S | **RESOLVED 2026-05-27.** `writeReport` (lines 454-458) now passes the full content directly to `Bun.write(path, content)` without string slicing on `/`. Path handling appears portable. | Use `dirname`/`resolve` if report path derivation is added later. |
| F018 | Correctness | `src/pipelines/executor.ts:47` | Medium | S | **PARTIALLY RESOLVED.** Parallel results use positional index via closure (`reviews[index] = result`, line 58). However, `.filter(Boolean)` on line 90 removes undefined slots for failed reviewers without preserving which position failed, shifting subsequent results. | Either preserve empty slots or return `{index, result}` with sort; document failed reviewers by position. |
| F019 | Performance / Cost | `src/pipelines/executor.ts:73` | Medium | M | **RESOLVED 2026-05-28.** `Pipeline.maxConcurrency` (optional positive integer) added to the pipeline config schema. When set and smaller than the reviewer count, the executor uses a worker-pool semaphore (`runWithConcurrencyLimit`) instead of unbounded `Promise.all`. 2 new tests verify that active concurrency stays within the limit and that a limit larger than the reviewer count behaves like unlimited. | Per-provider concurrency and cost/token caps remain future work. |
| F020 | Observability | `src/runtime/bus.ts:32` | Low | S | **RESOLVED 2026-05-27.** `safeInvoke` wraps every listener in try/catch; failures log to `console.error` without crashing the bus or affecting other listeners. | — |
| F021 | Observability | `src/runtime/runtime.ts:93` | Low | S | **PARTIALLY RESOLVED.** Provider dispose is called best-effort, but errors are still silently discarded (`catch(() => undefined)`, lines 94-98). No debug log or aggregation. | Emit internal log events or aggregate dispose errors after cleanup. |
| F022 | Config / Security | `src/config/interpolate.ts:24` | Medium | S | **PARTIALLY RESOLVED.** Template interpolation (`${VAR}`) works but only matches uppercase identifiers (`[A-Z0-9_]+`). Lowercase env var names like `${my_var}` are not matched, while `env:my_var` works via the lazy `env:` path. Both mechanisms functionally exist but have different case support. | Document the case-sensitivity difference, or make `${}` match the same set as `env:`. |
| F023 | Test debt | `tests/config.test.ts:5` | Medium | M | **RESOLVED 2026-05-28.** Config tests expanded from 1 to 31 tests. Coverage now includes: `loadConfigFromString` (17 tests — valid parse, defaults, maxDiffBytes validation, cross-reference errors for unknown persona/provider/reviewer/pipeline, requireAgreement bounds, invalid YAML, missing version, empty reviewers, maxConcurrency, lazy env refs, template interpolation), `interpolateString` (9 tests — plain strings, env:VAR, missing/empty vars, lazy mode, ${VAR} templates, multiple templates), `interpolateDeep` (3 tests — recursive objects/arrays, primitives), `resolveLazy` (2 tests — recursive resolution, passthrough). | — |
| F024 | Type hygiene | `tsconfig.json:3` | Low | S | **RESOLVED 2026-05-27.** `noUnusedLocals` and `noUnusedParameters` are now enabled (tsconfig.json lines 12-13), alongside `strict: true`. Unused imports caught at compile time. | — |
| F025 | Tooling | `package.json:10` | Medium | S | **RESOLVED 2026-05-27.** Scripts now include `typecheck`, `test`, `test:coverage`, and `lint`. Coverage and lint gates are available. | Add format, dead-code, and circular-dependency checks for full coverage. |
| F026 | DevOps | `.github/workflows/ci.yml:20` | Medium | S | **RESOLVED 2026-05-27.** CI now pins `bun-version: "1.3.3"` and `package.json` has `engines.bun: ">=1.1.0"`. Builds are reproducible. | Keep Bun pinned; update intentionally with dependency PRs. |
| F027 | HTTP resilience | `src/providers/openrouter/client.ts` | Medium | M | **RESOLVED 2026-05-28.** `OpenRouterClient.chat()` and `chatStream()` now retry on retryable failures (429, 502, 503, 504) and network errors with configurable exponential backoff. Schema adds `maxRetries` (default 3) and `retryBaseMs` (default 1000ms). Respects `Retry-After` header on 429. Non-retryable errors (400, 401, 403) fail immediately. 7 new tests cover retry on 429, 5xx, network errors, exhaustion, non-retryable status, stream retry, and Retry-After header. | Circuit breaker and per-provider rate-limit tracking remain future work. |
| F028 | Observability | `src/providers/openrouter/client.ts:124` | Medium | S | **RESOLVED 2026-05-27.** OpenRouter SSE parsing now includes try/catch with `chunk_parse_error` yield (lines 110-137). Ollama NDJSON parsing similarly yields `chunk_parse_error` (lines 104-126). No silent drops. | Count malformed chunks and fail if stream ends without valid content. |
| F029 | API surface | `src/providers/openrouter/index.ts:85` | Medium | M | **RESOLVED 2026-05-27.** `stream()` method (lines 91-109) exists and delegates to `client.chatStream()`, yielding `token` and `log` events. Streaming API is available. | Pipeline executor still calls `review()` — evaluate whether to integrate `stream()` into orchestration. |
| F030 | Report safety | `src/ui/markdown.ts:68` | Low | S | **RESOLVED 2026-05-27.** `escapeMd` now escapes *all* Markdown special characters: `` \`*_{}[]()#+-.!~|<> ``. User-supplied titles, bodies, file paths, and reviewer IDs pass through this function. No heading/table injection possible. | — |
| F031 | Consensus correctness | `src/consensus/overlap-v1.ts:16` | Medium | M | **RESOLVED 2026-05-28.** `aggregate` now matches each finding against **all group members** (`g.members.some(m => matches(m, finding))`) instead of only the representative. This eliminates order-dependence: findings A, B, C with overlapping ranges are always grouped together regardless of iteration order, even when the representative changes due to severity upgrade. 1 new test verifies correct grouping across 3 reviewers with varying line ranges and severities. | — |
| F032 | Output contract | `src/reviewers/output.ts:81` | Medium | S | **RESOLVED 2026-05-27.** Missing/invalid lines default to 1; unknown severity/category default to `'medium'`/`'correctness'`. These are sensible defaults for a V1 tool that consumes untrusted LLM output. | Treat invalid required fields as parse errors when running in strict/permissive mode toggle. |
| F033 | Output parsing | `src/reviewers/output.ts:135` | Medium | M | **RESOLVED 2026-05-28.** `extractJsonObject` now uses a balanced-brace scanner that respects JSON string delimiters (including escaped quotes). It iterates through candidate `{...}` spans, skipping invalid ones (e.g., `{1-5}` in prose) until it finds one that parses as valid JSON. 4 new tests cover: prose with braces before JSON, braces after JSON, multiple brace groups, and escaped quotes inside JSON strings. | — |
| F034 | Privacy | `src/runtime/workspace.ts:107` | Medium | M | **RESOLVED 2026-05-27.** Untracked files are gated by `MAX_UNTRACKED_BYTES` (24KB per file), binary detection, non-regular file handling, line ending normalization, and unreadable-file fallbacks. | Add config flags for total cap and denylist for sensitive file patterns. |
| F035 | Privacy / UX | `src/cli/index.ts:197` | Medium | S | **RESOLVED 2026-05-27.** Preview is controlled by `--no-preview` flag; `TerminalRenderer` accumulates tokens with 500ms/240-char debounce and shows only last 220 chars. Reasonable defaults. | Keep `--no-preview` default-off to maintain opt-in safety. |
| F036 | Packaging | `package.json:6` | Low | M | **RESOLVED 2026-05-27.** `main` points to `src/index.ts`, `bin` points to `src/cli/index.ts`. Bun-run entrypoints are explicit. `engines.bun` declares Bun requirement. | Decide if a build step for npm consumers is needed; document Bun-only status. |
| F037 | Error handling | `src/runtime/workspace.ts:79` | Medium | S | **PARTIALLY RESOLVED.** `runGit` returns `string | null` — distinguishes failure internally. However, callers cannot access stderr/exit code for diagnostics. The `null` return is still ambiguously "something went wrong." | Return `{ ok: true; stdout } | { ok: false; code; stderr }` for actionable errors. |
| F038 | Config redaction | `src/cli/index.ts:398` | Low | S | **RESOLVED 2026-05-27.** `redactConfig` (lines 387-425) recursively redacts lazy `env:` refs, generic sensitive keys (api_key, token, secret, password variants), and provider-specific sensitive fields. Comprehensive coverage. | — |

## Top 5 if you fix nothing else (updated 2026-05-27)

1. ~~**F005 — Harden prompt construction**~~ **RESOLVED 2026-05-28.** Adaptive fence + untrusted-input framing with 13 regression tests.

2. **F006/F037 — Make workspace probing fail loudly**
   - Replace `string | null` git helpers with `{ ok: true, stdout } | { ok: false, stderr, code }`.
   - Invalid `--base` should exit non-zero with the git error.

3. ~~**F008 — Extract shared subprocess runner**~~ **RESOLVED 2026-05-28.** `runSubprocess()` + `buildSubprocessReviewResult()` in `src/providers/subprocess.ts`; all 7 providers refactored.

4. ~~**F027 — Add HTTP resilience controls**~~ **RESOLVED 2026-05-28.** Retry with exponential backoff for 429/5xx/network errors; `Retry-After` header support; `maxRetries`/`retryBaseMs` config.

5. ~~**F015 — Split CLI god module**~~ **RESOLVED 2026-05-28.** Extracted `commands/review.ts`, `commands/config.ts`, `commands/init.ts`, `args.ts`, `types.ts`, and `report.ts`.

## Quick wins (updated 2026-05-27)

- [x] F009: Add `timedOut` handling to Claude Code provider.
- [x] F016: Check overwrite/config path before `quorum init` prompts.
- [x] F017: Replace `writeReport` string slicing with `path.dirname`.
- [ ] F018: Preserve reviewer order in parallel results.
- [ ] F022: Align `${VAR}` interpolation semantics with `env:VAR`.
- [x] F024: Enable TypeScript unused checks and remove unused imports.
- [x] F025: Add `test:coverage` and `lint` scripts.
- [x] F026: Pin Bun version in CI and `@types/bun`.
- [x] F028: Emit warnings for malformed stream chunks.
- [x] F030: Harden markdown escaping.
- [ ] F006: Surface git failure stderr instead of "No diff detected".

### New quick wins
- [x] F031: Fix order-dependence in overlap-v1 consensus by matching against all group members.
- [ ] F012: Add `backend-senior` to `BUILTIN_PERSONAS` or generate from `quorum.yaml.example`.
- [x] F013: Move implemented providers out of "Out of scope for V1" in architecture docs.

## Roadmap priorisee (updated 2026-05-27)

### Phase 1 — Security and correctness hardening (reprioritized)

- ~~Harden prompt construction against fence-breaking and instruction injection (F005).~~ **RESOLVED.**
- Make git failures explicit; surface stderr and exit codes (F006, F037).
- ~~Add provider request timeouts with retry/backoff~~ **(F027 RESOLVED)**.
- ~~Fix order-dependence in overlap-v1 consensus grouping~~ **(F031 RESOLVED)**.
- ~~Improve fallback JSON parsing with balanced-brace scanner~~ **(F033 RESOLVED)**.

### Phase 2 — Maintainability and architecture refactor

- ~~Extract CLI commands from `src/cli/index.ts`~~ **(F015 RESOLVED)**.
- ~~Introduce shared subprocess runner~~ **(F008 RESOLVED)** and ~~shared output normalizer~~ **(F010 RESOLVED)**.
- Replace duplicated provider/init metadata with a single registry-driven model (F011).
- Align built-in personas with `quorum.yaml.example` (F012).
- ~~Resolve documentation drift for V1 scope and implemented providers~~ **(F013, F014 RESOLVED)**.

### Phase 3 — Budget and resilience controls

- ~~Add diff size budgets, file filters, untracked-file policy~~ **(F007 RESOLVED)**.
- ~~Add concurrency limits~~ **(F019 RESOLVED)**. Cost/token caps remain future work.
- ~~Add default provider timeouts and retry/backoff~~ **(F027 RESOLVED)**.

### Phase 4 — Test and tooling maturity

- ~~Add config/interpolation tests~~ **(F023 RESOLVED)**. ~~Add consensus edge-case tests~~ **(F031 RESOLVED)**. Runtime resolver tests remain future work.
- Add markdown renderer edge-case tests and plugin command tests.
- Add dead-code and circular-dependency checks to CI.

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
- Add regression tests for the remaining high-risk cases:
  - ~~malicious diff with code fence and prompt-injection text (F005);~~ **COVERED** — 13 tests in `tests/cli.test.ts`.
  - invalid `--base` surfacing git errors (F006/F037);
  - large diff exceeds budget (F007);
  - ~~order-dependence in overlap-v1 grouping~~ **(F031 COVERED)** — 1 test in `tests/consensus.test.ts`;
  - ~~config interpolation with `env:VAR`, `${VAR}`, missing vars, and redaction~~ **(F023 COVERED)** — 31 tests in `tests/config.test.ts`;
  - ~~OpenRouter retry/backoff and timeout behavior~~ **(F027 COVERED)** — 7 tests in `tests/openrouter-client.test.ts`.

## DevOps and workflow

- CI pins Bun to `1.3.3` and has basic gates (typecheck, test, coverage, lint).
- There is no lint/format gate, no coverage threshold, no unused/dead code check, and no circular-dependency check.
- Dependency surface is small (`yaml`, `zod`), and `bun audit` found no vulnerabilities.
- Recommended additional CI gates:
  1. format check
  2. dead-code/circular-dependency check
  3. coverage threshold enforcement

## Things that look bad but are actually fine

- `core/` being mostly interfaces and types is appropriate here. The domain is orchestration-heavy, so pure type contracts in `src/core/provider.ts`, `src/core/task.ts`, and `src/core/pipeline.ts` are not accidental over-abstraction.
- `ConsensusConfigSchema.catchall(z.unknown())` in `src/config/schema.ts:28` is acceptable for strategy-specific options. The cross-check for `requireAgreement` at `src/config/loader.ts:68` keeps the known option safe.
- Partial reviewer failure policy in `src/pipelines/executor.ts:60` is intentional and correct for a consensus tool. One bad provider should not erase signal from the others.
- Local `quorum.yaml` is gitignored in `.gitignore:5`; I did not inspect it. That is the right default because it may contain local provider credentials.
- The simple overlap consensus in `src/consensus/overlap-v1.ts:64` is acceptable as a V1 algorithm. The debt is order-dependence and test coverage around edge cases, not the lack of semantic embeddings.

## Open questions for the maintainer

- ~~Should Quorum include untracked files by default, or should that be opt-in for privacy?~~ (Resolved: 24KB per-file cap, binary detection, non-regular file handling, and line-ending normalization in place. Add total cap and denylist config.)
- ~~Is Codex non-interactive execution allowed to bypass approvals/sandbox in production use, or was that a compatibility workaround?~~ (Resolved: bypass is gated on `approval_policy: 'never'`, and `danger-full-access` + `never` is blocked by schema refine.)
- Should the codex-cli `approval_policy` default change from `'never'` to `'untrusted'` for review-only tooling?
- Is the project intended to be Bun-only, or should npm/Node library consumers be supported?
- Should external provider plugins be part of the near-term contract, or should docs mark that as future work?
- Should live token preview be on by default, or should report-only output be the safer default?
- Should `stream()` be integrated into the pipeline executor, or kept as a future-only surface until performance metrics justify it?
