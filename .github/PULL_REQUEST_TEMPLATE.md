<!--
Thanks for sending a PR! A few notes before you submit:

1. Read CONTRIBUTING.md if you haven't yet.
2. Keep the change small and focused — one concern per PR.
3. Run `npm test` locally. CI will run it on Node 22 + 24 across
   Ubuntu, Windows, and macOS, so cross-platform breakage will be caught,
   but catching it locally is faster.
-->

## What this PR does

<!-- One paragraph. Don't list every file change — explain the user-visible
     or behaviour-visible impact. -->

## Why

<!-- The motivation. If it fixes an issue, link it: "Fixes #123". -->

## How I tested it

<!-- Walk through what you did to verify. Bullet list is fine.
     If you added tests, mention them. If this is UI work, attach a
     before/after screenshot from the DEMO seed (never real data). -->

- [ ] `npm test` passes locally
- [ ] `node --check` on every JS file I touched
- [ ] Tried it against the demo db: `npm run demo`
- [ ] (if UI) Captured a screenshot using the demo seed

## Checklist

- [ ] Reads `~/.claude/usage.db` in **read-only** mode (no writes)
- [ ] No outbound network calls added (the dashboard stays local-first)
- [ ] No runtime npm dependencies added
- [ ] Cross-platform paths (`path.join` / `path.sep`, no hardcoded `/` or `\`)
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`
- [ ] No real usage data appears anywhere in screenshots / fixtures / tests

## Type of change

<!-- Mark with an x or delete the ones that don't apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behaviour)
- [ ] Documentation / community files
- [ ] Refactor / cleanup (no behaviour change)
