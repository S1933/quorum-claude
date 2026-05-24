# Quorum

Provider-agnostic multi-model consensus review for AI-assisted code changes.

The product focus: when an implementation is done in Claude Code, run a **parallel review meeting across multiple LLMs from multiple providers**, then aggregate findings with a consensus engine that surfaces which issues independent reviewers agreed on.

---

## How it works

1. **Define reviewer providers** — OpenRouter (any model), local Claude Code SDK, or your own adapter.
2. **Define personas** — a system prompt + role declaration (security, performance, architecture, …).
3. **Bind reviewers** — `(persona, provider)` pairs. Same persona on two providers = one consensus signal.
4. **Run a review pipeline** — parallel reviewers critique the finished diff. The consensus engine groups findings by file + line overlap and emits an agreement badge.

```
┌──────────────────────────────────────────────────────────────┐
│  Distribution: Claude Code review plugin · CLI                │
├──────────────────────────────────────────────────────────────┤
│  UI: terminal renderer · markdown report · event subscribers  │
├──────────────────────────────────────────────────────────────┤
│  Runtime: event bus · plugin lifecycle · config loader        │
├──────────────────────────────────────────────────────────────┤
│  Pipelines: parallel/sequential review executor · timeout     │
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

# Run a specific pipeline (short form)
bun quorum review consensus-security

# Equivalent explicit form
bun quorum review --pipeline consensus-security

# Show the loaded config (env: values redacted)
bun quorum config
```

---

## Claude Code plugin

Quorum ships as a Claude Code plugin. Once installed, two slash commands are available inside Claude Code:

Install from the Claude Code plugin marketplace:

```bash
claude plugin marketplace add S1933/quorum-claude
claude plugin install quorum@quorum-plugins
```

| Command | What it does |
|---|---|
| `/quorum-review` | Run the configured default pipeline on the current diff and render the consensus report inline |
| `/quorum-config` | Show the loaded `quorum.yaml` with secrets redacted |

Use `/quorum-review consensus-security` to run a named pipeline. The plugin is a thin shell around the same review CLI entry point — zero domain logic in the command files.

For local development, load it directly:

```bash
claude --plugin-dir ./plugin
```

Then use `/quorum:quorum-review` or `/quorum:quorum-config` inside Claude Code.

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
