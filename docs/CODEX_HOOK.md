# Codex CLI Hook Configuration

Auto-run Quorum review before `git commit` using a Codex CLI hook.

## Setup

Codex discovers hooks from project-local `.codex/hooks.json`. See [`docs/codex-hooks.json.example`](codex-hooks.json.example) for the complete example.

Copy the example config into your project:

```bash
cp docs/codex-hooks.json.example .codex/hooks.json
```

The hook uses the shared check script at `scripts/quorum-hook-check.sh`, which must be present in your Quorum checkout.

## Usage

### Normal commit (with Quorum check)

```bash
git commit -m "your message"
```

The hook will:
1. Run `quorum review --json`
2. Check for `high` or `critical` severity findings
3. Block the commit if any are found

### Bypass the check

```bash
QUORUM_BYPASS=1 git commit -m "your message"
```

## How it works

The hook:
- Triggers before every `Bash` tool call in Codex
- Delegates to `scripts/quorum-hook-check.sh` which checks `git commit` commands
- Exit code `2` + JSON `decision: "block"` on stdout blocks the action
- Can be bypassed with `QUORUM_BYPASS=1`

## Trust

On first use, Codex will prompt you to review and trust the hook. Use `/hooks` in Codex to inspect, review, trust, or disable hooks.

## Requirements

- `jq` (for JSON parsing)
- `quorum` command or `./src/cli/index.ts` in the workspace
- `quorum.yaml` configuration file