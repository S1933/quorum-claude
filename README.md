# Quorum

Provider-agnostic orchestration runtime for AI coding agents and multi-model consensus review.

The differentiator: run the **same reviewer persona across multiple providers**, then aggregate findings with a consensus engine that surfaces which issues multiple independent models agreed on.

---

## How it works

1. **Define providers** — OpenRouter (any model), local Claude Code SDK, or your own adapter.
2. **Define personas** — a system prompt + role declaration (security, performance, architecture, …).
3. **Bind reviewers** — `(persona, provider)` pairs. Same persona on two providers = one consensus signal.
4. **Run a pipeline** — parallel or sequential reviewers execute against a diff or prompt. The consensus engine groups findings by file + line overlap and emits an agreement badge.

```
┌──────────────────────────────────────────────────────────────┐
│  Distribution: Claude Code plugin · CLI                       │
├──────────────────────────────────────────────────────────────┤
│  UI: terminal renderer · markdown report · event subscribers  │
├──────────────────────────────────────────────────────────────┤
│  Runtime: event bus · plugin lifecycle · config loader        │
├──────────────────────────────────────────────────────────────┤
│  Pipelines: parallel/sequential executor · timeout · retry    │
├──────────────────────────────────────────────────────────────┤
│  Reviewers (Persona+Provider binding)   Consensus engine      │
├──────────────────────────────────────────────────────────────┤
│  Provider adapters: openrouter · claude-code · (ollama …)    │
├──────────────────────────────────────────────────────────────┤
│  Core: types, schemas, pure logic — no I/O                    │
└──────────────────────────────────────────────────────────────┘
```

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.1

---

## Installation

```bash
git clone https://github.com/your-org/quorum-claude-code
cd quorum-claude-code
bun install
```

---

## Configuration

Copy the example config and fill in your API key:

```bash
cp quorum.yaml.example quorum.yaml
export OPENROUTER_API_KEY=sk-or-...
```

`quorum.yaml` has three layers:

```yaml
version: 1

providers:
  openrouter-claude:
    type: openrouter
    api_key: env:OPENROUTER_API_KEY   # env: prefix for secrets
    model: anthropic/claude-opus-4
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

reviewers:
  sec-opus:  { persona: security, provider: openrouter-claude }
  sec-local: { persona: security, provider: claude-code-local }

pipelines:
  # Same persona, two providers — findings that both flag get an agreement badge
  consensus-security:
    parallel: true
    reviewers: [sec-opus, sec-local]
    consensus: { strategy: overlap-v1, requireAgreement: 2 }
```

`env:VAR` and `${VAR}` are both supported. Missing env vars fail at provider instantiation, not at parse time, so you get a clear error pointing to the right reviewer.

---

## CLI usage

```bash
# Review the current git diff against the default branch
bun quorum review

# Run a specific pipeline
bun quorum review --pipeline consensus-security

# Delegate an agent task to the default provider
bun quorum agent "refactor the auth module to use the new session API"

# Show the loaded config (env: values redacted)
bun quorum config
```

---

## Claude Code plugin

Quorum ships as a Claude Code plugin. Once installed, three slash commands are available inside Claude Code:

| Command | What it does |
|---|---|
| `/quorum-review` | Run the `default` pipeline on the current diff, render the consensus report inline |
| `/quorum-agent <task>` | Delegate a task to the default agent provider, stream output |
| `/quorum-config` | Show the loaded `quorum.yaml` with secrets redacted |

The plugin is a thin shell around the same CLI entry point — zero domain logic in the command files.

---

## Consensus: `overlap-v1`

V1 ships one consensus strategy. Two findings are grouped together when:

1. Same file path
2. Line ranges overlap (or are within ±2 lines)
3. Same category (`security` | `performance` | `architecture` | `correctness` | `style`)

Each group gets an **N reviewers agreed** badge. Findings raised by only one reviewer are surfaced separately.

Semantic dedup (embedding-based), contradiction detection, and per-reviewer trust scores are roadmap items — see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Project structure

```
src/
├── core/          # Types, schemas, pure logic. No I/O.
├── providers/     # openrouter + claude-code adapters
├── reviewers/     # Persona+Provider binding logic
├── consensus/     # overlap-v1 strategy + registry
├── config/        # YAML schema, loader, env interpolation
├── runtime/       # Event bus, plugin lifecycle, workspace
├── ui/            # Terminal renderer, markdown report writer
└── cli/           # Bun entrypoint (reused by Claude Code commands)
```

Dependencies flow downward only. `core/` imports nothing from the project.

---

## Development

```bash
bun test        # run tests
bun typecheck   # type-check without emitting
```

---

## Roadmap

See [ARCHITECTURE.md § V1 milestones](docs/ARCHITECTURE.md) for the six-milestone implementation plan, and [§ Out of scope](docs/ARCHITECTURE.md#14-out-of-scope-for-v1) for explicit deferrals (DAG pipelines, CI integration, Codex/Gemini providers, web dashboard).
