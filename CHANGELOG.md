# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-30

First public release of **Tokrax** — a local-first usage, cost, and
live-monitor dashboard for AI coding tools.

### Highlights
- **Multi-tool.** Reads **Claude Code** (`~/.claude/projects/**/*.jsonl`) and
  **Codex CLI** (`~/.codex/sessions/**/rollout-*.jsonl`). A **Claude · Codex ·
  All** switcher appears in the header when more than one tool is detected; the
  same aggregation pipeline powers every view for both.
- **Always-current data.** The Claude reader parses live transcripts (the
  real-time source of truth) rather than the slow-to-rebuild `usage.db` cache,
  so the numbers never go stale. Parsing is cached by file mtime.
- **Real-time live monitor.** See active sessions across tools, with
  last-5-minute turn / token / cost rollups and recent tool calls.
- **Token-saving advisor.** Per-project session health
  (`fresh · healthy · getting-full · near-max · stale · abandoned`) with a
  concrete next move for each.
- **Monthly cost forecast** from your recent burn rate.
- **Sessions table** — sortable, searchable, paginated, with a per-session
  deep-dive modal (per-turn context timeline + tool breakdown).
- **MCP server breakdown** with per-tool drill-down.
- **Shareable captures.** Any card (or the KPI grid) → **PNG** (portable, opens
  in Photoshop / Preview / anywhere, also copied to clipboard) or **SVG**
  (vector), Mac-window-framed with six gradient backgrounds and a low-key
  watermark.
- **Terminal mode** — `tokrax-cli` renders the same stats with ANSI color;
  supports `--source claude|codex|all`.

### Privacy & footprint
- Binds to **`127.0.0.1` only**; all data read **read-only**; **no telemetry**,
  **no outbound network**, **zero runtime dependencies** (no `npm install`).
- Cost is computed locally from token counts using published API list prices.

### Platform
- macOS, Linux, **and Windows** — CI matrix runs Node 22 + 24 across all three.
- Node's built-in `node:sqlite`; auto-relaunches with `--experimental-sqlite`
  on Node versions that still gate it (22.5–22.12, 23.0–23.3).
- Default port **47776** (`776` = "PRO" on a phone keypad ✦); `PORT` overrides.

### Quality
- Zero-dependency test suite (`node --test`) that builds its own throwaway
  fixtures — never touches real data.
- Community health files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, ROADMAP,
  issue + PR templates.

[1.0.0]: https://github.com/ShaonPro/Tokrax/releases/tag/v1.0.0
