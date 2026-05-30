# Codebase Audit - Quorum

Generated: 2026-05-30  
Scope: local files in `/Users/jp/Projects/quorum-claude` only

## Executive Summary

- General state: small Bun/TypeScript CLI and Claude Code skill with clear module boundaries, strict TypeScript, and good unit coverage for config, providers, diff handling, output parsing, and pipelines.
- Main strengths: strict `tsconfig`, compact architecture, provider schemas with restricted `extra_args`, shared subprocess runner, no circular dependencies, no dependency vulnerabilities from `bun audit`, and 165 passing tests.
- Main weaknesses: safety boundaries around local agent CLIs are not consistently enforced, documented hook behavior does not match JSON output, some config options are accepted but dropped before execution, and runtime/resource bounds are optional rather than default.
- Biggest risks: Codex CLI runs with a dangerous bypass flag by default; the pre-commit hook documented as blocking high/critical findings appears not to inspect the actual JSON report shape; large diffs and subprocess output can consume unbounded memory/tokens/cost.
- Immediate priorities: remove or gate Codex dangerous bypass mode, fix the hook JSON query, propagate `maxConcurrency`, add default diff/output caps, and sanitize terminal output from model-controlled content.
- Verification run: `bun run typecheck` passed; `bun test` passed 165 tests; `bun test --coverage` reported 89.87% line coverage; `bun audit` reported no vulnerabilities; `npx --yes madge --circular src` found no cycles; `npx --yes knip --reporter compact` found unused exports and one `bun-types` resolution warning.

## Repository Overview

- Detected technologies: Bun 1.3.3, TypeScript ESM, Zod, YAML, Bun test, Claude Code skill markdown commands, GitHub Actions.
- Main directories:
  - `src/core`: domain types, errors, events.
  - `src/config`: YAML loading, env interpolation, schema validation, redaction metadata.
  - `src/providers`: OpenRouter/Ollama HTTP providers and local subprocess agent providers.
  - `src/pipelines`: pipeline execution and consensus orchestration.
  - `src/consensus`: `overlap-v1` grouping strategy.
  - `src/runtime`: provider/consensus registry wiring, event bus, git workspace probing.
  - `src/cli`: CLI entrypoint and command modules.
  - `src/ui`: terminal, Markdown, JSON renderers.
  - `skill`: Claude Code skill definitions.
  - `tests`: Bun unit/integration tests.
- Entry points:
  - CLI binary: `src/cli/index.ts:1`
  - CLI commands: `src/cli/commands/review.ts`, `reviewer.ts`, `reviewers.ts`, `install-skills.ts`
  - Package exports: `src/index.ts:1`
  - Runtime factory: `src/runtime/runtime.ts:42`
  - Pipeline executor: `src/pipelines/executor.ts:19`
  - Skill: `skills/review/SKILL.md:1`
- Build/test/dev commands from `package.json:10`:
  - `bun run typecheck`
  - `bun test`
  - `bun test --coverage`
  - `bun run lint` (currently aliases typecheck)
  - `bun quorum ...`
- CI/CD:
  - GitHub Actions runs checkout, Bun 1.3.3 setup, frozen install, typecheck, and tests in `.github/workflows/ci.yml:21`.
- Docker/deployment:
  - No Dockerfile, compose file, deployment script, release workflow, rollback plan, or observability setup found.

## Architectural Mental Model

Quorum is a local review orchestrator. It probes the current git workspace, builds one review instruction containing the diff, binds configured reviewers to configured providers, runs those reviewers in parallel or sequentially, parses structured findings, groups overlapping findings through `overlap-v1`, and renders terminal plus Markdown/JSON reports. Providers are either HTTP adapters (`openrouter`, `ollama`) or subprocess adapters that invoke local AI agent CLIs.

The architecture mostly matches the documented layer model: core types are pure, runtime wires registries, providers own transport, the pipeline executor owns orchestration, and UI renderers subscribe to events or render final results. The main drift is around skill/devops documentation and runtime behavior: accepted config such as `maxConcurrency` is not fully mapped into the runtime pipeline, and the hook documentation claims blocking semantics that the current JSON schema does not support.

## Critical Issues

### F001 - Codex provider bypasses sandbox/approvals by default

- Priority: Critical
- Category: Security
- File or area: `src/providers/codex-cli/schema.ts:16`, `src/providers/codex-cli/schema.ts:17`, `src/providers/codex-cli/index.ts:45`, `tests/codex-cli.test.ts:81`
- Problem: `approval_policy` defaults to `never`, and `buildArgs()` maps that to `--dangerously-bypass-approvals-and-sandbox` even when `sandbox` is `read-only`.
- Impact: If the Codex CLI flag behaves as named, reviewing an untrusted diff can give a prompt-influenced local agent unsandboxed, no-approval execution. This is the highest-risk path because Quorum's input is code diff text that can contain prompt injection.
- Recommendation: Do not pass this flag by default. Prefer a non-dangerous non-interactive mode, change the default to an approval-requiring policy, or disable `codex-cli` unless an explicit unsafe opt-in is set.
- Example fix:

```ts
// src/providers/codex-cli/schema.ts
approval_policy: z.enum(['untrusted', 'on-request']).default('on-request')

// src/providers/codex-cli/index.ts
if (this.cfg.approval_policy === 'never') {
  throw new ProviderRuntimeError(this.id, 'Unsafe no-approval Codex mode is disabled');
}
```

## Detailed Audit

### Architecture

#### F002 - `maxConcurrency` is accepted but dropped before execution

- Priority: High
- Category: Architecture
- File or area: `src/config/schema.ts:42`, `src/runtime/runtime.ts:117`, `src/runtime/runtime.ts:125`, `src/pipelines/executor.ts:74`
- Problem: The schema accepts `pipelines.*.maxConcurrency`, and the executor honors `pipeline.maxConcurrency`, but `toPipeline()` only copies `timeoutMs`; it never copies `maxConcurrency`.
- Impact: Users can configure rate limiting and believe it is active while all reviewers still launch concurrently. This can amplify API rate-limit failures and cost spikes.
- Recommendation: Copy `cfg.maxConcurrency` in `toPipeline()` and add a runtime-level integration test that loads YAML then verifies executor concurrency.
- Example fix:

```ts
if (cfg.maxConcurrency) pipeline.maxConcurrency = cfg.maxConcurrency;
```

#### F003 - Shared provider instantiation is racy under `resolveReviewers()`

- Priority: Medium
- Category: Architecture
- File or area: `src/runtime/runtime.ts:60`, `src/runtime/runtime.ts:65`, `src/runtime/runtime.ts:85`
- Problem: `resolveReviewers()` uses `Promise.all()`. If several reviewers reference the same provider id, concurrent `resolveProvider()` calls can all miss the cache before the first instantiation stores the provider.
- Impact: Duplicate providers can be created for the same id. Current providers are mostly stateless, but future providers with sessions, sockets, or `dispose()` will leak or double-init.
- Recommendation: Cache pending promises by provider id, not just resolved instances.
- Example fix:

```ts
const pendingProviders = new Map<string, Promise<Provider>>();
const resolveProvider = (id: string) => {
  const existing = providerInstances.get(id);
  if (existing) return Promise.resolve(existing);
  const pending = pendingProviders.get(id);
  if (pending) return pending;
  const created = providers.instantiate(id, cfg, opts.pluginCtx).then((p) => {
    providerInstances.set(id, p);
    pendingProviders.delete(id);
    return p;
  });
  pendingProviders.set(id, created);
  return created;
};
```

#### F004 - Config path resolution happens before repo-root inference

- Priority: Medium
- Category: Architecture
- File or area: `src/cli/commands/review.ts:21`, `src/cli/commands/review.ts:28`, `src/config/loader.ts:84`
- Problem: `cmdReview()` loads `quorum.yaml` from `process.cwd()` before calling `inferRepoRoot()`.
- Impact: Running the CLI from a repo subdirectory fails even though the repo root has a valid config. Verified with `bun run cli/index.ts config` from `src/`, which looked for `src/quorum.yaml`.
- Recommendation: Infer repo root first and default config lookup to `${root}/quorum.yaml`, or make `findConfigPath()` walk up to the git root.

#### F005 (Resolved) — `BUILTIN_PERSONAS` export removed

- Status: **FIXED** (2026-05-30). `src/reviewers/builtin/index.ts` was deleted and the export removed from `src/index.ts`. Personas are now defined exclusively in `quorum.yaml`.

#### F005a (Former F006) — Consensus config accepts arbitrary keys without validation

- Priority: Low
- Category: Architecture
- File or area: `src/config/schema.ts:29`, `src/config/schema.ts:34`, `src/runtime/runtime.ts:142`
- Problem: `ConsensusConfigSchema` uses `.catchall(z.unknown())`, and runtime forwards unknown keys into the strategy config.
- Impact: Typos in consensus settings are accepted silently. With only `overlap-v1` available, most unknown consensus settings are no-ops.
- Recommendation: Make `overlap-v1` config strict now, or validate strategy-specific config during runtime creation.

### Code Quality

#### F007 (Mostly resolved) — Dead exports cleaned up

- Priority: Low (was Medium)
- Category: Code Quality
- File or area: `src/cli/report.ts:4`, `src/providers/subprocess.ts:152`
- Problem: `resolveConfigPath()` and `assertPathInside()` have been removed from `src/cli/report.ts`. `ProviderConfig` export was removed from `src/config/schema.ts`. `readPreviewedStdout()` was made private. Remaining `knip`-reported dead exports are negligible.
- Recommendation: Run `npx knip --reporter compact` to verify and address remaining warnings.

#### F008 (Resolved) — `writeReport()` path-safety design cleaned up

- Status: **FIXED** (2026-05-30). `assertPathInside()` and `resolveConfigPath()` were removed from `src/cli/report.ts`. `writeReport()` is now a minimal helper with no path-safety claims. Path restrictions are handled at the CLI command level via `--report` flag validation.

#### F009 - Unknown CLI flags are silently ignored

- Priority: Low
- Category: Code Quality
- File or area: `src/cli/args.ts:9`, `src/cli/commands/review.ts:187`
- Problem: `parseArgs()` accepts every `--flag`, but commands validate only a few values such as `--format`.
- Impact: Typos such as `--formt json` silently fall back to text output. This is risky for automation that expects JSON.
- Recommendation: Add per-command allowed flag sets and fail on unknown flags.

#### F010 - Invalid git errors are collapsed into "no diff"

- Priority: Medium
- Category: Code Quality
- File or area: `src/runtime/workspace.ts:64`, `src/runtime/workspace.ts:71`, `src/runtime/workspace.ts:75`, `src/runtime/workspace.ts:86`
- Problem: `getMergeBase()` and `runGit()` discard stderr and map non-zero git exits to `undefined`/`null`.
- Impact: `--base definitely-not-real` exits 0 with "No diff detected", masking a bad base ref as a clean review.
- Recommendation: Preserve stderr and raise `ConfigError` or `ProviderRuntimeError` for explicit user-supplied invalid refs.

#### F011 - File parsing uses newline-delimited git output

- Priority: Low
- Category: Code Quality
- File or area: `src/runtime/workspace.ts:108`, `src/runtime/workspace.ts:112`, `src/runtime/workspace.ts:119`
- Problem: Untracked files are read from `git ls-files` newline output and interpolated into synthetic diff headers.
- Impact: Filenames with newlines or unusual quoting can be split or rendered incorrectly.
- Recommendation: Use `git ls-files -z` and NUL-delimited parsing for file names.

### Security

#### F012 - Project config can execute arbitrary local binaries

- Priority: High
- Category: Security
- File or area: `src/providers/claude-code/schema.ts:7`, `src/providers/codex-cli/schema.ts:15`, `src/providers/subprocess.ts:21`, `skills/review/SKILL.md:8`
- Problem: Subprocess provider schemas allow arbitrary `binary` strings from `quorum.yaml`, and the skill explicitly runs the current project's configuration.
- Impact: Running the skill in an untrusted repo can execute a repo-controlled binary path if the repo supplies `quorum.yaml`. This is expected for power users but dangerous without a trust prompt or documentation.
- Recommendation: Treat project config as executable. Add a trust warning, require absolute trusted binary paths, or require an explicit `allow_project_binaries: true` opt-in for relative paths.

#### F013 - Terminal renderer prints model-controlled control characters

- Priority: High
- Category: Security
- File or area: `src/ui/terminal.ts:57`, `src/ui/terminal.ts:60`, `src/ui/terminal.ts:136`, `src/ui/terminal.ts:189`
- Problem: Token previews, finding titles, file paths, and bodies are written directly to the terminal.
- Impact: A malicious diff can influence model output containing ANSI escape/control sequences, causing terminal injection, hidden text, forged output, or clipboard escape abuse in vulnerable terminals.
- Recommendation: Strip or escape ASCII control characters except `\n`/`\t` before terminal rendering. Keep raw content only in JSON/Markdown reports if needed.
- Example fix:

```ts
const safe = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/g, '');
```

#### F014 - Hook documentation claims blocking but parses a nonexistent JSON path

- Priority: High
- Category: Security
- File or area: `docs/CLAUDE_CODE_HOOK.md:22`, `docs/claude-settings.json.example:9`, `src/ui/json.ts:35`, `src/ui/json.ts:54`
- Problem: The hook uses `jq -r ".findings[] ..."`, but `renderJsonReport()` emits findings under `reviews[].findings`, `consensus.groups[].members`, and `consensus.unique`.
- Impact: The hook can fail open and allow commits with high/critical findings while documentation says it blocks them.
- Recommendation: Update the hook to inspect actual report paths and add a test fixture for the hook query.
- Example fix:

```sh
jq '[.reviews[].findings[], .consensus.unique[], .consensus.groups[].members[]]
    | flatten
    | map(select(.severity=="critical" or .severity=="high"))
    | length'
```

#### F015 - Local provider defaults forward broad environment context

- Priority: Medium
- Category: Security
- File or area: `src/runtime/plugin.ts:6`, `src/runtime/plugin.ts:9`, `src/providers/cursor-agent/index.ts:58`
- Problem: `defaultPluginCtx()` copies the whole `process.env`, and `cursor-agent` explicitly forwards it to the child process.
- Impact: A configured subprocess provider gets all ambient environment variables, not only the credentials it needs. This increases blast radius if a provider binary is compromised or project config points to a malicious binary.
- Recommendation: Prefer an allowlist of environment variables per provider, with an explicit config option for passing through additional variables.

#### F016 - Report path can write outside the repository

- Priority: Medium
- Category: Security
- File or area: `src/cli/commands/review.ts:84`, `src/cli/commands/review.ts:89`, `src/cli/report.ts:4`
- Problem: `--report` accepts any path and `writeReport()` writes it directly.
- Impact: In interactive CLI use this is expected. In the Claude Code skill surface, argument parsing mistakes or prompt/tool misuse can write files outside the target repo.
- Recommendation: For skill invocations, restrict reports to the repository by default or require `--allow-report-outside-root`.

### Performance

#### F017 - Diff payload has no default budget

- Priority: High
- Category: Performance
- File or area: `src/runtime/workspace.ts:16`, `src/runtime/workspace.ts:17`, `src/cli/commands/review.ts:34`, `src/cli/commands/review.ts:147`
- Problem: Full git diff plus untracked file content is sent unless the user configures `maxDiffBytes` or passes a flag.
- Impact: Large diffs can blow model context, increase costs, slow all providers, and create huge terminal/report output.
- Recommendation: Add a conservative default diff budget with an override. Print a clear error that points to `--max-diff-bytes`, `--include`, and `--exclude`.

#### F018 - Untracked file collection has per-file cap but no count/total cap

- Priority: Medium
- Category: Performance
- File or area: `src/runtime/workspace.ts:11`, `src/runtime/workspace.ts:111`, `src/runtime/workspace.ts:113`, `src/runtime/workspace.ts:125`
- Problem: Each untracked file is capped at 24 KiB, but there is no cap on untracked file count or aggregate bytes before prompt construction.
- Impact: A generated directory with many small untracked text files can produce a very large prompt and many sequential filesystem reads.
- Recommendation: Add `maxUntrackedFiles` and aggregate byte caps, or skip untracked files by default unless requested.

#### F019 - Subprocess stdout/stderr are buffered without size limits

- Priority: High
- Category: Performance
- File or area: `src/providers/subprocess.ts:48`, `src/providers/subprocess.ts:58`, `src/providers/subprocess.ts:158`, `src/providers/subprocess.ts:164`
- Problem: `runSubprocess()` reads all stdout and stderr into memory. `stderr.slice(0, 500)` happens only after the full stderr has already been read.
- Impact: A noisy or stuck provider can consume large memory before timeout, and terminal preview can stream a large volume of model output.
- Recommendation: Add maximum stdout/stderr byte limits and kill the process once exceeded.

#### F020 - Concurrency-limited worker starts reviewers after timeout

- Priority: Medium
- Category: Performance
- File or area: `src/pipelines/executor.ts:39`, `src/pipelines/executor.ts:43`, `src/pipelines/executor.ts:73`, `src/pipelines/executor.ts:115`
- Problem: Sequential mode checks `controller.signal.aborted`, but `runWithConcurrencyLimit()` does not.
- Impact: With `maxConcurrency` fixed and a timeout reached, workers can continue starting queued reviewers with an already-aborted signal.
- Recommendation: Pass the abort signal into `runWithConcurrencyLimit()` and break before launching new reviewers when aborted.

#### F021 - OpenRouter retry sleep leaks abort listeners

- Priority: Low
- Category: Performance
- File or area: `src/providers/openrouter/client.ts:55`, `src/providers/openrouter/client.ts:60`
- Problem: `sleep()` adds an abort listener but never removes it after normal timeout resolution.
- Impact: Retry-heavy requests accumulate listeners on the same `AbortSignal`.
- Recommendation: Clear the timer and remove the listener in both resolve and reject paths.

#### F022 - OpenRouter SSE parser drops final unterminated buffer

- Priority: Medium
- Category: Performance
- File or area: `src/providers/openrouter/client.ts:162`, `src/providers/openrouter/client.ts:166`, `src/providers/openrouter/client.ts:185`
- Problem: `chatStream()` processes complete newline-delimited lines but does not parse the remaining buffer after the stream ends.
- Impact: A final SSE event without a trailing newline can be dropped, losing the last token or usage event.
- Recommendation: Mirror the Ollama client pattern: decode tail and process the remaining buffer after the read loop.

### Tests

#### F023 - No runtime integration test proves `maxConcurrency` survives config mapping

- Priority: High
- Category: Tests
- File or area: `tests/config.test.ts:199`, `tests/pipeline.test.ts:86`, `src/runtime/runtime.ts:117`
- Problem: Config tests prove YAML accepts `maxConcurrency`, and executor tests prove a manually constructed pipeline honors it, but no test connects both through `createRuntime()`.
- Impact: The current `maxConcurrency` production bug was not caught.
- Recommendation: Add a test that loads config, calls `runtime.resolvePipeline()`, and expects `pipeline.maxConcurrency` to be set.

#### F024 - Hook behavior is not tested against JSON report schema

- Priority: High
- Category: Tests
- File or area: `docs/claude-settings.json.example:9`, `src/ui/json.ts:35`, `tests/cli.test.ts:95`
- Problem: JSON output is tested, but the documented hook `jq` query is not.
- Impact: CI cannot catch the hook fail-open mismatch.
- Recommendation: Extract the hook checker into a small script or document-tested command and run it against a fixture JSON report with high and low findings.

#### F025 - Invalid base refs and nested config discovery are untested

- Priority: Medium
- Category: Tests
- File or area: `tests/workspace.test.ts:9`, `src/runtime/workspace.ts:64`, `src/config/loader.ts:84`
- Problem: Workspace tests cover clean repos, default refs, untracked files, and filters, but not explicit invalid `--base` or CLI execution from a subdirectory.
- Impact: User-facing failure modes are misleading or brittle.
- Recommendation: Add CLI integration tests for `--base missing-ref` and running from a child directory.

#### F026 - Coverage is high but not enforced

- Priority: Low
- Category: Tests
- File or area: `package.json:14`, `.github/workflows/ci.yml:32`
- Problem: `test:coverage` exists but CI runs only `bun test`.
- Impact: Coverage can regress silently.
- Recommendation: Either add a coverage threshold step or publish coverage as a non-blocking artifact while the project is young.

### Dependencies and Configuration

#### F027 - `npm audit` is not usable for this Bun-only lockfile

- Priority: Low
- Category: Dependencies
- File or area: `bun.lock`, `package.json:17`
- Problem: `npm audit --omit=dev` fails with `ENOLOCK` because there is no npm lockfile.
- Impact: Developers following generic Node audit habits will get a false dead end.
- Recommendation: Document `bun audit` as the dependency audit command and add it to CI if network access is acceptable.

#### F028 - Linting is only typechecking

- Priority: Medium
- Category: Dependencies
- File or area: `package.json:12`, `package.json:15`
- Problem: `lint` is an alias for `tsc --noEmit`.
- Impact: TypeScript catches many issues, but formatting, import hygiene, unsafe patterns, and dead exports are not continuously checked.
- Recommendation: Add a lightweight lint/static-analysis path: `knip` for unused exports and either ESLint or Biome for style/safety rules.

#### F029 - README runtime requirement is looser than tested runtime

- Priority: Low
- Category: Dependencies
- File or area: `README.md:36`, `.github/workflows/ci.yml:24`, `package.json:22`
- Problem: README says Bun `>= 1.1`, while CI pins Bun `1.3.3` and dev types are `@types/bun` 1.3.14.
- Impact: Users on older Bun versions may hit behavior that CI never exercises.
- Recommendation: Set `engines.bun` and README to the oldest version actually tested, or add a CI matrix for the minimum supported version.

#### F030 - `bunfig.toml` references `bun.lockb` while repo has `bun.lock`

- Priority: Low
- Category: Dependencies
- File or area: `bunfig.toml:8`, `bunfig.toml:9`, `bun.lock`
- Problem: Config says `lockfile = "bun.lockb"`, but the repository contains `bun.lock`.
- Impact: `bun install --frozen-lockfile` passed locally, so this is not currently breaking. It is still confusing configuration drift.
- Recommendation: Remove the stale lockfile setting or update it to match the current Bun text lockfile behavior.

### Documentation

#### F031 - Architecture document is stale in several places

- Priority: Low (was Medium)
- Category: Documentation
- File or area: `docs/ARCHITECTURE.md:322`
- Problem: The doc had stale mentions of `plugin/`, slash commands, `src/reviewers/builtin/`, and "open questions" from pre-implementation design phase.
- Impact: Contributors may reference outdated terms.
- Recommendation: (Updated 2026-05-30) Architecture doc now reflects current `skills/` layout, `src/cli/commands/*`, and resolved design questions in §15.

#### F032 - Hook docs conflict with `.gitignore`

- Priority: Low
- Category: Documentation
- File or area: `docs/CLAUDE_CODE_HOOK.md:9`, `docs/CLAUDE_CODE_HOOK.md:11`, `.gitignore:4`
- Problem: The docs label project-level `.claude/settings.json` as "checked in", while `.gitignore` ignores `.claude/`.
- Impact: Users may think the hook is versioned when it is not.
- Recommendation: Clarify that `docs/claude-settings.json.example` is checked in and users copy it to an ignored local `.claude/settings.json`, or unignore the intended project settings file.

#### F033 - README does not explain trust boundaries for local agent providers

- Priority: High
- Category: Documentation
- File or area: `README.md:15`, `README.md:20`, `README.md:140`
- Problem: The README lists local agent CLI providers but does not warn that they execute local binaries against untrusted diff content and may have file/tool access.
- Impact: Users can treat Quorum like a pure API linter while it can run local agents with powerful permissions.
- Recommendation: Add a "Security model" section covering trusted repos, trusted `quorum.yaml`, provider binary trust, diff prompt injection, sandbox/approval expectations, and secret handling.

### DevOps

#### F034 - CI omits audit/static-analysis checks that already found issues

- Priority: Medium
- Category: DevOps
- File or area: `.github/workflows/ci.yml:29`, `.github/workflows/ci.yml:32`
- Problem: CI runs typecheck and tests only. It does not run `bun audit`, `knip`, `madge`, or coverage.
- Impact: Dependency issues, dead exports, and dependency cycles can enter main unnoticed.
- Recommendation: Add separate CI jobs or non-blocking scheduled checks for `bun audit`, `npx --yes knip --reporter compact`, and `npx --yes madge --circular src`.

#### F035 - No release/deployment workflow exists

- Priority: Low
- Category: DevOps
- File or area: `.github/workflows/ci.yml:1`, `package.json:1`
- Problem: The repo has package metadata but no release, versioning, changelog, or publish workflow.
- Impact: Releases are likely manual and easy to drift from the tested commit.
- Recommendation: Add a release checklist or GitHub workflow that verifies tests/audit, tags the version, and publishes artifacts.

#### F036 - No operational logging/observability policy for provider failures

- Priority: Low
- Category: DevOps
- File or area: `src/pipelines/executor.ts:67`, `src/runtime/runtime.ts:95`, `src/runtime/bus.ts:36`
- Problem: Reviewer errors are captured, but provider dispose errors are swallowed and event listener errors go directly to `console.error`.
- Impact: Debugging skill/CI runs can be hard when cleanup failures or renderer failures disappear outside structured reports.
- Recommendation: Emit structured warning events for dispose/listener failures and include them in JSON/Markdown reports.

## Top 5: If You Fix Nothing Else

1. F001: Remove Codex `--dangerously-bypass-approvals-and-sandbox` default. This is the only finding with potential local execution impact from prompt-influenced review input.
2. F014: Fix the hook JSON query. The current documented pre-commit blocker appears fail-open.
3. F002: Propagate `maxConcurrency` from config to runtime pipeline and test it end to end.
4. F017/F019: Add default diff and subprocess output caps to control cost, latency, and memory.
5. F013/F033: Sanitize terminal output and document the local-agent trust model.

## Prioritized Action Plan

### Immediate fixes

- Fix F001 by removing the Codex dangerous bypass flag or putting it behind an explicit unsafe opt-in.
- Fix F014 by updating `docs/CLAUDE_CODE_HOOK.md` and `docs/claude-settings.json.example` to query the actual JSON report schema.
- Fix F002 and F023 together with a runtime integration test for `maxConcurrency`.
- Add terminal control-character sanitization for F013.

### Short-term improvements

- Add default `maxDiffBytes`, aggregate untracked-file limits, and stdout/stderr caps.
- Improve git error handling for invalid explicit base refs.
- Fix nested config discovery.
- Remove dead exports or configure `knip` for intentional public exports.
- Add CI jobs for `bun audit`, `knip`, and `madge`.

### Medium-term improvements

- Formalize a trust model for project configs and local subprocess providers.
- Add provider instantiation promise caching.
- Refresh architecture docs to match current implementation.
- Add a release workflow or documented release checklist.

## Quick Wins

- [ ] Add `if (cfg.maxConcurrency) pipeline.maxConcurrency = cfg.maxConcurrency;` in `src/runtime/runtime.ts`.
- [ ] Change the hook jq query to inspect `.reviews[].findings`, `.consensus.unique`, and `.consensus.groups[].members`.
- [ ] Fail on unknown CLI flags.
- [ ] Parse `git ls-files -z` for untracked files.
- [ ] Process the final OpenRouter SSE buffer after stream end.
- [ ] Add `bun audit` to CI.
- [ ] Update README Bun version to match tested support.

## Things That Look Bad But Are Actually Fine

- `tsconfig.json:7` uses `types: ["bun-types"]`, and `knip` reports it as unresolved, but `bun run typecheck` passes and `bun list --all` shows `bun-types@1.3.14` installed through `@types/bun`. Treat this as a knip configuration issue unless it fails in CI.
- `src/config/schema.ts:46` uses `.catchall(z.unknown())` for provider configs. That is appropriate at the top-level provider map because each provider factory validates its own strict schema later in `src/providers/registry.ts:47`.
- The subprocess provider files are repetitive, but the duplication is mostly command-shape glue around the shared `runSubprocess()` helper. Prematurely abstracting all provider argument building would likely make the provider-specific security review harder.
- `quorum.yaml` exists locally, but `.gitignore:8` ignores it and `git ls-files quorum.yaml` returned nothing. No committed API key was found in the tracked config surface.
- No Dockerfile exists. For a Bun CLI/plugin library with no service runtime, that is not a problem by itself.

## Open Questions for Maintainers

- Is `codex-cli` intended to be safe for reviewing untrusted diffs, or is it explicitly a trusted-local-agent mode?
- Should `--report` intentionally allow writing outside the repository for standalone CLI use?
- Should untracked files be included by default, or should users opt in?
- Are built-in personas intended to become runtime fallbacks, or only examples?
- Is Bun `>= 1.1` a real support target, or should support start at the pinned CI/runtime version?

## Suggested Verification Commands

```sh
bun run typecheck
bun test
bun test --coverage
bun audit
npx --yes knip --reporter compact
npx --yes madge --circular src
bun run src/cli/index.ts review --base definitely-not-real --config quorum.yaml --json
```

## Final Summary Table

| Priority | Category | File/Area | Problem | Impact | Recommendation |
|---|---|---|---|---|---|
| Critical | Security | `src/providers/codex-cli/index.ts:45` | Codex default adds dangerous sandbox/approval bypass | Potential unsandboxed local agent execution | Remove default bypass or require explicit unsafe opt-in |
| High | Security | `docs/CLAUDE_CODE_HOOK.md:22` | Hook jq query reads nonexistent `.findings[]` | Pre-commit blocker can fail open | Query actual JSON schema paths |
| High | Architecture | `src/runtime/runtime.ts:117` | `maxConcurrency` dropped in runtime mapping | Configured throttling is ignored | Copy field and add integration test |
| High | Security | `src/ui/terminal.ts:57` | Raw model text printed to terminal | Terminal injection/log forgery | Strip control characters before rendering |
| High | Performance | `src/runtime/workspace.ts:16` | No default diff budget | Token/cost/memory blowups | Add default cap and clear override |
| High | Performance | `src/providers/subprocess.ts:48` | Subprocess output buffered without cap | Memory blowups from noisy providers | Add stdout/stderr byte limits |
| High | Security | `src/providers/subprocess.ts:21` | Project config can execute arbitrary binaries | Untrusted repo config can run code | Add trust prompt/absolute path policy |
| High | Documentation | `README.md:20` | Local-agent trust model not documented | Users underestimate execution risk | Add security model section |
| Medium | Architecture | `src/runtime/runtime.ts:60` | Provider instantiation race | Duplicate providers/leaks | Cache pending provider promises |
| Medium | Code Quality | `src/config/loader.ts:84` | Config lookup starts at cwd only | CLI fails from subdirectories | Resolve config from repo root |
| Medium | Code Quality | `src/runtime/workspace.ts:64` | Bad base refs become no-diff results | Misleading success | Surface git stderr for explicit refs |
| Medium | Security | `src/runtime/plugin.ts:9` | Full environment passed to plugin context | Larger secret exposure to subprocesses | Provider-specific env allowlists |
| Medium | Security | `src/cli/commands/review.ts:84` | Reports can write outside repo | Accidental writes from skill path | Restrict report paths or opt in |
| Medium | Performance | `src/runtime/workspace.ts:111` | Untracked aggregate size unbounded | Large prompts and sequential file I/O | Add count/aggregate caps |
| Medium | Performance | `src/pipelines/executor.ts:115` | Queued reviewers can start after timeout | Wasted provider calls | Stop workers when signal is aborted |
| Medium | Performance | `src/providers/openrouter/client.ts:162` | Final SSE buffer is not parsed | Lost last token/usage | Parse tail after stream end |
| Medium | Tests | `tests/config.test.ts:199` | No end-to-end test for config-to-runtime concurrency | Regression escaped tests | Add runtime integration test |
| Medium | Tests | `tests/cli.test.ts:95` | Hook query not tested | Fail-open hook not caught | Add fixture test/script |
| Medium | Tests | `tests/workspace.test.ts:9` | Invalid refs/subdir config untested | UX regressions | Add CLI workspace tests |
| Medium | Dependencies | `package.json:15` | `lint` only runs typecheck | Dead exports/style drift | Add knip and lint/format tool |
| Medium | Documentation | `docs/ARCHITECTURE.md:322` | Architecture doc had stale plugin/builtin refs | Contributor confusion | Updated 2026-05-30 |
| Medium | DevOps | `.github/workflows/ci.yml:29` | CI omits audit/static analysis | Issues enter main unnoticed | Add audit/knip/madge jobs |
| Low | Code Quality | `src/cli/args.ts:9` | Unknown flags ignored | Automation typos silently misbehave | Validate allowed flags |
| Low | Code Quality | `src/runtime/workspace.ts:108` | Git filenames parsed by newline | Odd filenames break diff handling | Use NUL-delimited git output |
| Low | Performance | `src/providers/openrouter/client.ts:55` | Abort listener not removed after sleep | Retry listener buildup | Remove listener in finally |
| Low | Dependencies | `README.md:36` | Bun minimum differs from CI | Untested runtime versions | Align docs/engines with CI |
| Low | Dependencies | `bunfig.toml:9` | Config references `bun.lockb` while repo has `bun.lock` | Confusing lockfile drift | Remove/update setting |
| Low | Documentation | `.gitignore:4` | Hook docs say checked-in `.claude/settings.json`, but `.claude` ignored | Setup confusion | Clarify local vs committed example |
| Low | DevOps | `package.json:1` | No release workflow | Manual release drift | Add release checklist/workflow |
| Low | DevOps | `src/runtime/runtime.ts:95` | Dispose errors swallowed | Harder debugging | Emit structured warnings |
