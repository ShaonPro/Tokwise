# Contributing to Tokwise

Thanks for considering a contribution! This project is small, dependency-free,
and local-first by design — those three constraints shape everything below.

## Ground rules

1. **Zero runtime dependencies.** The dashboard must run with `npx` and nothing
   else — no `npm install`, no CDN fetches at runtime. If a feature seems to
   need a library, open an issue first; the answer is usually "vendor a small
   file" or "don't."
2. **Local-first, always.** The server binds to `127.0.0.1`, the database is
   opened **read-only**, and nothing is ever sent off the machine. Any PR that
   adds an outbound network call, opens the DB writable, or binds to a public
   interface will be declined. See [SECURITY.md](SECURITY.md).
3. **Cross-platform.** macOS, Linux, and Windows all matter. Use `path.join` /
   `path.sep`, never hardcode `/`. CI runs on all three.
4. **Keep it readable.** Vanilla JS, no build step, no transpiler. The whole
   point is that a curious user can open `dashboard.html` and understand it.

## Dev setup

```bash
git clone https://github.com/ShaonPro/Tokwise
cd Tokwise

# Run the dashboard against your real data
node server.js
# → http://127.0.0.1:47776
```

Need fixture data instead of your own? The test suite builds its own throwaway
Claude/Codex fixtures in a temp dir (`npm test`), and you can point the data
layer anywhere with `CLAUDE_USAGE_DB`, `CLAUDE_USAGE_PROJECTS_DIR`, and
`CLAUDE_USAGE_CODEX_DIR`.

You need **Node.js 22.13+ / 23.4+ / 24+** recommended (older 22/23 work — the
app auto-adds `--experimental-sqlite`).

## Before you open a PR

```bash
# 1. Syntax-check everything
for f in server.js stats.js cli.js test/*.js; do node --check "$f"; done

# 2. Run the test suite (zero deps, builds its own fixtures)
npm test
```

CI runs the same checks on Node 22 + 24 across Ubuntu, Windows, and macOS.
A green check is required to merge.

## What makes a good PR

- **One focused change.** Small PRs get reviewed fast.
- **A test if you touched `stats.js`.** Add a case to `test/stats.test.js`.
- **A `CHANGELOG.md` entry** under `## [Unreleased]`.
- **No screenshots of real data.** Point the env overrides at throwaway
  fixtures for any visuals.

## Good first issues

Look for the [`good first issue`](https://github.com/ShaonPro/Tokwise/labels/good%20first%20issue)
label. Adding a new tool adapter (see [ROADMAP.md](ROADMAP.md)) is a great way
to get started — the data layer is built to make this a contained change.

## Reporting bugs / requesting features

Use the issue templates. For anything security-related, **do not** open a public
issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
