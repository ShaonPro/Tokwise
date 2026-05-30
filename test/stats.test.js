'use strict';

/* ============================================================================
 * test/stats.test.js — zero-dependency, self-contained tests
 * ----------------------------------------------------------------------------
 * Run:  npm test     (= node --test test/stats.test.js)
 * Builds tiny Claude-transcript + Codex-rollout fixtures in a temp dir, points
 * the data layer at them via env, and exercises the pure helpers + the full
 * aggregation across claude / codex / all. No network, no external deps, and
 * NEVER touches your real ~/.claude or ~/.codex data.
 * ==========================================================================*/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ---- build fixtures BEFORE requiring stats (paths resolve at module load) ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tokrax-test-'));
const CLAUDE_PROJ = path.join(TMP, 'claude', 'projects', 'demo-proj');
const CODEX_DIR = path.join(TMP, 'codex', 'sessions', '2026', '05', '30');
fs.mkdirSync(CLAUDE_PROJ, { recursive: true });
fs.mkdirSync(CODEX_DIR, { recursive: true });

const isoAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

// --- Claude transcripts: two sessions, assistant turns with usage ---
function claudeTurn(sid, cwd, branch, model, min, tool, u) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: isoAgo(min),
    sessionId: sid,
    cwd,
    gitBranch: branch,
    message: {
      model,
      usage: {
        input_tokens: u.i, output_tokens: u.o,
        cache_read_input_tokens: u.cr, cache_creation_input_tokens: u.cc,
      },
      content: tool ? [{ type: 'tool_use', name: tool }] : [{ type: 'text', text: 'hi' }],
    },
  });
}
const sidA = '11111111-1111-4111-8111-111111111111';
const sidB = '22222222-2222-4222-8222-222222222222';
fs.writeFileSync(path.join(CLAUDE_PROJ, sidA + '.jsonl'), [
  claudeTurn(sidA, '/Users/demo/code/acme/api', 'main', 'claude-sonnet-4-5', 60, 'Read', { i: 200, o: 400, cr: 8000, cc: 1200 }),
  claudeTurn(sidA, '/Users/demo/code/acme/api', 'main', 'claude-sonnet-4-5', 50, 'Edit', { i: 180, o: 900, cr: 9000, cc: 0 }),
  claudeTurn(sidA, '/Users/demo/code/acme/api', 'main', 'claude-opus-4-5', 40, 'Bash', { i: 220, o: 1200, cr: 10000, cc: 0 }),
].join('\n') + '\n');
fs.writeFileSync(path.join(CLAUDE_PROJ, sidB + '.jsonl'), [
  claudeTurn(sidB, '/Users/demo/code/personal/blog', 'draft', 'claude-haiku-4-5', 30, 'Write', { i: 120, o: 600, cr: 3000, cc: 800 }),
  claudeTurn(sidB, '/Users/demo/code/personal/blog', 'draft', 'claude-haiku-4-5', 20, '', { i: 90, o: 300, cr: 3500, cc: 0 }),
].join('\n') + '\n');

// --- Codex rollout: one session, three token_count turns ---
const codexSid = '019e6abc-1234-7def-9012-3456789abcde';
function codexLines() {
  const meta = JSON.stringify({ timestamp: isoAgo(45), type: 'session_meta',
    payload: { id: codexSid, cwd: '/Users/demo/code/experiments/ml-pipeline' } });
  const ctx = JSON.stringify({ timestamp: isoAgo(45), type: 'turn_context',
    payload: { model: 'gpt-5.5', cwd: '/Users/demo/code/experiments/ml-pipeline' } });
  const tok = (min, inTok, cached, out) => JSON.stringify({
    timestamp: isoAgo(min), type: 'event_msg',
    payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: inTok, cached_input_tokens: cached, output_tokens: out, total_tokens: inTok + out },
      model_context_window: 272000 } },
  });
  return [meta, ctx, tok(44, 12000, 9000, 600), tok(40, 15000, 12000, 800), tok(35, 18000, 14000, 500)].join('\n') + '\n';
}
fs.writeFileSync(path.join(CODEX_DIR, `rollout-2026-05-30T00-00-00-${codexSid}.jsonl`), codexLines());

process.env.CLAUDE_USAGE_DB = path.join(TMP, 'nonexistent-usage.db'); // force transcript path
process.env.CLAUDE_USAGE_PROJECTS_DIR = path.join(TMP, 'claude', 'projects');
process.env.CLAUDE_USAGE_CODEX_DIR = path.join(TMP, 'codex', 'sessions');

const stats = require('../stats');

// --------------------------------------------------------------- priceFor
test('priceFor: Claude models resolve to list prices', () => {
  assert.equal(stats.priceFor('claude-opus-4-5').in, 15);
  assert.equal(stats.priceFor('claude-sonnet-4-5').in, 3);
  assert.equal(stats.priceFor('claude-haiku-4-5').in, 1);
});
test('priceFor: prefix match handles dated ids', () => {
  assert.equal(stats.priceFor('claude-opus-4-5-20251030').out, 75);
});
test('priceFor: OpenAI models resolve, -mini override wins', () => {
  assert.equal(stats.priceFor('gpt-5.5').in, 1.25);
  assert.equal(stats.priceFor('gpt-5-mini').in, 0.25);
});
test('priceFor: unknown model returns the default', () => {
  assert.equal(stats.priceFor('totally-unknown').in, 3);
});

// ---------------------------------------------------------------- costOf
test('costOf: computes USD from tokens', () => {
  const c = stats.costOf('claude-opus-4-5', { input: 1e6, output: 1e6, cacheRead: 0, cacheCreation: 0 });
  assert.equal(Math.round(c), 90);
});
test('costOf: cache-read cheaper than fresh input', () => {
  const fresh = stats.costOf('claude-sonnet-4-5', { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 });
  const cached = stats.costOf('claude-sonnet-4-5', { input: 0, output: 0, cacheRead: 1e6, cacheCreation: 0 });
  assert.ok(cached < fresh);
});

// ------------------------------------------------------------- prettyModel
test('prettyModel: Claude + OpenAI ids', () => {
  assert.equal(stats.prettyModel('claude-opus-4-5-20251030'), 'Opus 4.5');
  assert.equal(stats.prettyModel('gpt-5.5'), 'GPT-5.5');
  assert.equal(stats.prettyModel('gpt-5-codex'), 'GPT-5 Codex');
  assert.equal(stats.prettyModel('unknown'), 'Unknown');
});

// ----------------------------------------------------------- deriveProject
test('deriveProject: POSIX + Windows paths', () => {
  assert.equal(stats.deriveProject('/Users/foo/code/acme/api'), 'acme/api');
  assert.equal(stats.deriveProject('C:\\Users\\foo\\code\\acme\\api'), 'acme/api');
  assert.equal(stats.deriveProject(''), '(unknown)');
});

// ---------------------------------------------------------- classifyHealth
test('classifyHealth: near-max / fresh / stale / abandoned', () => {
  assert.equal(stats.classifyHealth({ fill: 0.85, ageMin: 5, turns: 200, ctx: 170000 }).health, 'near-max');
  assert.equal(stats.classifyHealth({ fill: 0.02, ageMin: 2, turns: 1, ctx: 3000 }).health, 'fresh');
  assert.equal(stats.classifyHealth({ fill: 0.3, ageMin: 2000, turns: 100, ctx: 60000 }).health, 'stale');
  assert.equal(stats.classifyHealth({ fill: 0.3, ageMin: 20000, turns: 100, ctx: 60000 }).health, 'abandoned');
});
test('classifyHealth: never throws on NaN/Infinity', () => {
  assert.doesNotThrow(() => stats.classifyHealth({ fill: NaN, ageMin: Infinity, turns: 0, ctx: 0 }));
});

// --------------------------------------------------------- source detection
test('detectSources: claude (via transcripts) + codex both present', () => {
  const byId = Object.fromEntries(stats.detectSources().map((s) => [s.id, s]));
  assert.equal(byId.claude.present, true, 'claude detected via transcripts');
  assert.equal(byId.codex.present, true, 'codex detected via rollouts');
});

// ------------------------------------------------------------- Codex adapter
test('parseCodexRollout: reads a rollout into normalized turns', () => {
  const files = stats.findCodexSessionFiles();
  assert.ok(files.length > 0);
  const s = stats.parseCodexRollout(files[0].path);
  assert.ok(s && s.turns.length === 3);
  assert.equal(s.model, 'gpt-5.5');
  // Codex input includes cached → adapter splits it: fresh = input - cached
  assert.equal(s.turns[0].input, 12000 - 9000);
  assert.equal(s.turns[0].cacheRead, 9000);
});

// -------------------------------------------------------------- buildStats
test('buildStats(claude): aggregates the transcript fixtures', () => {
  const d = stats.buildStats({ source: 'claude', range: 'all', project: 'all' });
  assert.equal(d.meta.source, 'claude');
  assert.equal(d.totals.sessions, 2);
  assert.equal(d.totals.turns, 5);
  assert.ok(d.totals.cost > 0);
  assert.ok(d.byModel.some((m) => /Opus|Sonnet|Haiku/.test(m.display)));
  assert.equal(d.byHour.length, 24);
});
test('buildStats(codex): aggregates the rollout fixture', () => {
  const d = stats.buildStats({ source: 'codex', range: 'all', project: 'all' });
  assert.equal(d.meta.source, 'codex');
  assert.equal(d.totals.sessions, 1);
  assert.equal(d.totals.turns, 3);
  assert.ok(d.totals.cost > 0);
  assert.ok(d.byModel.every((m) => /GPT/.test(m.display)));
});
test('buildStats(all): merges claude + codex', () => {
  const a = stats.buildStats({ source: 'claude' });
  const c = stats.buildStats({ source: 'codex' });
  const all = stats.buildStats({ source: 'all' });
  assert.equal(all.meta.source, 'all');
  assert.equal(all.totals.sessions, a.totals.sessions + c.totals.sessions);
  assert.equal(all.totals.turns, a.totals.turns + c.totals.turns);
  const disp = all.byModel.map((m) => m.display).join(' ');
  assert.ok(/GPT/.test(disp) && /Opus|Sonnet|Haiku/.test(disp));
});
test('buildStats: unknown source falls back to claude', () => {
  assert.equal(stats.buildStats({ source: 'bogus' }).meta.source, 'claude');
});
test('buildStats: cache hit-rate is a sane fraction', () => {
  const d = stats.buildStats({ source: 'claude' });
  assert.ok(d.cache.hitRate >= 0 && d.cache.hitRate <= 1);
});

// ----------------------------------------------------------- session detail
test('buildSessionDetail: returns per-turn detail for a Claude session', () => {
  const detail = stats.buildSessionDetail(sidA);
  assert.ok(detail, 'session found');
  assert.equal(detail.turnCount, 3);
  assert.equal(detail.session.project, 'acme/api');
  assert.ok(detail.totals.cost > 0);
});
test('buildSessionDetail: returns detail for a Codex session', () => {
  const detail = stats.buildSessionDetail(codexSid);
  assert.ok(detail, 'codex session found');
  assert.equal(detail.turnCount, 3);
  assert.ok(/GPT/.test(detail.models[0].display));
});
test('buildSessionDetail: unknown id → null', () => {
  assert.equal(stats.buildSessionDetail('deadbeef-0000-4000-8000-000000000000'), null);
});
