# Roadmap

The dashboard's north star is simple: **the best local-first web dashboard for
understanding your AI coding spend.** Everything below is shaped by that.

> This is a living document. Open an issue if you want to push something up,
> down, or onto the list.

## Now (this quarter)

The highest-impact, lowest-risk items — keeping the Claude Code experience sharp.

- [ ] **Daily cost report** — a printable, shareable "today / this week" view
      with breakdown by project and model.
- [ ] **Budget alerts** — local OS notifications when spend crosses a
      user-configurable threshold for the day or month. No network. Stays
      strictly local.
- [ ] **Demo GIF in the README** — animated hero replacing the static PNG.
- [ ] **Privacy / security section** — already shipped (see [SECURITY.md](SECURITY.md)),
      now linked prominently from the README.
- [ ] **CI on every PR** — GitHub Actions matrix for Node 22 + 24 across
      Ubuntu, Windows, and macOS (in flight).

## Next (after the above lands)

- [ ] **Codex CLI adapter** — read `~/.codex/sessions/**/*.jsonl` alongside
      Claude's `~/.claude/`. Same JSONL shape, same walker pattern. This is the
      first step toward multi-tool support without overpromising.
- [ ] **Project / repo cost attribution** — a "spent on `<repo>` this week"
      view that survives across sessions and (eventually) across tools.
- [ ] **CLI improvements** — `--watch` mode that re-renders every N seconds for
      a TUI experience next to the web UI.
- [ ] **Export to CSV** — for users who want to drop their data into a
      spreadsheet or BI tool.

## Maybe later

Possibilities, not commitments. Open an issue if you want to champion one.

- [ ] **More tool adapters** — Cline, Continue.dev, Aider, Gemini CLI, Cursor
      (all confirmed to have local data). One adapter at a time, only when the
      previous one is rock-solid.
- [ ] **Cross-tool session stitching** — *"today on `acme-corp/api`: Claude $4,
      Cursor $1, 2.1M tokens total."* The one differentiator nobody else owns.
- [ ] **Team mode (self-hostable)** — multiple machines, one dashboard, still
      no SaaS. Optional, opt-in, off by default.
- [ ] **Plugin API** — let advanced users add their own data source without
      touching `stats.js`.

## Explicitly out of scope

These have been considered and declined. PRs implementing them will be closed.

- ❌ **Cloud / SaaS mode** — the whole point is local-first. Use one of the
      excellent commercial trackers (Helicone, LangSmith, Phase) if you want
      remote.
- ❌ **Outbound telemetry or analytics** — not now, not ever, not as an opt-in.
- ❌ **Runtime npm dependencies** — every dep has to be vendored. If a feature
      needs one, open an issue first.
- ❌ **Docker as the primary install method** — `npx-and-go` is the appeal.
      Containers reintroduce friction the tool doesn't need. A Dockerfile may
      land as a contributed convenience, but never as the recommended path.

## How to help

- Pick anything from **Now** or **Next** and open an issue saying you're going
  to try it.
- Have a different idea? [Open a feature request](https://github.com/ShaonPro/Tokrax/issues/new?template=feature_request.yml).
- See `good first issue` for entry-level tasks.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.
