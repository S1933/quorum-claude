# OpenCode Go Hook Configuration

Auto-run Quorum review before `git commit` using an OpenCode plugin.

## Setup

Copy the plugin file into your project:

```bash
cp docs/opencode-quorum-hook.ts.example .opencode/plugins/quorum-hook.ts
```

OpenCode loads plugins from `.opencode/plugins/` automatically. No further config needed.

## Usage

### Normal commit (with Quorum check)

```bash
git commit -m "your message"
```

The plugin will:
1. Run `quorum review --json`
2. Check for `high` or `critical` severity findings
3. Throw an error blocking the commit if any are found

### Bypass the check

```bash
QUORUM_BYPASS=1 git commit -m "your message"
```

## How it works

The plugin:
- Subscribes to `tool.execute.before` events
- Intercepts `bash` tool calls matching `git commit`
- Delegates to `scripts/quorum-hook-check.sh`
- Throws on high/critical findings, which blocks the tool call

## Requirements

- [Bun](https://bun.sh) (the plugin uses `Bun.spawnSync`)
- `jq` (for JSON parsing)
- `quorum` command or `./src/cli/index.ts` in the workspace
- `quorum.yaml` configuration file