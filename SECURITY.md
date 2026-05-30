# Security Policy

The Tokrax is built around one promise: **your usage data never
leaves your machine.** This document explains how that's enforced, what the
threat model is, and how to report a problem.

## The local-first guarantees

These are not aspirations — they're enforced in code, and CI would catch a
regression:

| Guarantee | How it's enforced | Where |
| --- | --- | --- |
| **Loopback only** | The HTTP server binds to `127.0.0.1`. It is not reachable from your LAN or the internet. | `server.js` (`HOST = '127.0.0.1'`) |
| **Read-only data** | The SQLite database is opened with `{ readOnly: true }`. The app cannot modify `~/.claude/usage.db`. | `stats.js` (`new DatabaseSync(DB_PATH, { readOnly: true })`) |
| **No outbound network** | There is no `fetch`, no HTTP client, no socket that dials out. The only network surface is the inbound loopback server. | `server.js`, `stats.js`, `cli.js` |
| **No telemetry** | Nothing is logged to, reported to, or fetched from any remote service. No analytics, no crash reporting, no "phone home." | entire codebase |
| **Zero runtime dependencies** | No `npm install`. Nothing third-party executes at runtime, so there is no supply-chain surface for a transitive dependency to exfiltrate data. | `package.json` (no `dependencies`) |

> **Cost numbers** shown in the dashboard are computed locally from token counts
> using Anthropic's published list prices. They are an *estimate of equivalent
> API value* — not your actual subscription bill — and require no network call.

## Threat model

**In scope:**
- Any change that would send your data off the machine.
- Any path that opens the database writable or corrupts it.
- Injection (SQL, shell, HTML/XSS) reachable from DB-derived or request-derived
  values.
- Binding to a non-loopback interface by default.

**Out of scope:**
- Telemetry sent by Claude Code itself (that's Anthropic's product, not this
  dashboard).
- Physical/local access to your own machine (if an attacker is already on your
  box reading `~/.claude`, this tool is not your problem).
- Running the server behind your own deliberately-configured reverse proxy
  (that's your choice and your responsibility).

## Hardening already in place

- The server uses `execFile` (never `exec`) for opening the browser, so no
  shell interpolation of environment-derived values.
- `GET /api/session/:id` validates the id against `^[A-Za-z0-9_-]{1,80}$` before
  it touches the database.
- All SQL uses positional `?` placeholders — no string-built queries.
- All DB-derived values are HTML-escaped before interpolation into the page.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **hi@shaon.pro** with:
- A description of the issue and its impact.
- Steps to reproduce (a minimal case is ideal).
- The version / commit you're on.

You'll get an acknowledgement within **72 hours**. Valid reports will be fixed
as a priority, and you'll be credited in the release notes (unless you prefer to
stay anonymous).

## Supported versions

This is an actively maintained single-track project. Security fixes land on
`main` and are tagged in a new release. Please run the latest version.
