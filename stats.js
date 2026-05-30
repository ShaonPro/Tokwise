'use strict';

/* ============================================================================
 * Tokwise · stats.js — data layer
 * ----------------------------------------------------------------------------
 * ✦  Customized by ShaonPro · https://github.com/ShaonPro
 *     "Pro" signature is sprinkled through the codebase. Type p-r-o on the
 *     dashboard to see it.
 * ==========================================================================*/

/**
 * Reads ~/.claude/usage.db (read-only) plus the real-time JSONL transcripts
 * and produces a single aggregated stats object consumed by both the web
 * server and the CLI. Pro tip — every endpoint here is filter-aware.
 */

const SHAON_PRO = Object.freeze({
  name: 'ShaonPro',
  github: 'https://github.com/ShaonPro',
  sig: '✦',
});

// node:sqlite is built into Node, but the rollout history is awkward:
//   Node 22.5  – 22.12  exists, needs --experimental-sqlite flag (unflagged 22.13)
//   Node 23.0  – 23.3   exists, needs --experimental-sqlite flag (unflagged 23.4)
//   Node 22.13+, 23.4+, 24+   stable, no flag (24+ recommended)
// We try to load it; if that fails we self-relaunch ONCE with the flag (so the
// user never has to know which CLI flag their Node version needs). The
// relaunch condition is deliberately broad: when node:sqlite is genuinely
// stable the require above SUCCEEDS and we never reach here, so covering any
// 22.5+/23.x is safe — and the --experimental-sqlite flag is accepted as a
// harmless no-op on versions where sqlite is already stable (verified on 24+).
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  const nodeVer = process.versions.node;
  const [maj, min] = nodeVer.split('.').map(Number);
  // The real failure on a flag-required Node is ERR_UNKNOWN_BUILTIN_MODULE
  // ("No such built-in module: node:sqlite") — note it does NOT contain the
  // word "experimental", so we match on the module name and error code too.
  const looksLikeMissingSqlite =
    (err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') ||
    /node:sqlite|experimental/i.test(String(err && err.message));
  const inFlagRange =
    (maj === 22 && min >= 5) || maj === 23;
  const alreadyRetried = process.env._CU_SQLITE_RETRY === '1';

  if ((inFlagRange || looksLikeMissingSqlite) && !alreadyRetried) {
    // Self-relaunch with --experimental-sqlite. process.execPath is the
    // absolute path to the node binary (correct even when it contains spaces,
    // e.g. Windows "C:\Program Files\nodejs\node.exe", because spawnSync passes
    // argv as an array — no shell, no quoting needed).
    const { spawnSync } = require('child_process');
    const args = ['--experimental-sqlite', ...process.argv.slice(1)];
    process.stderr.write(
      `\n  Node ${nodeVer} needs --experimental-sqlite for node:sqlite. Relaunching…\n\n`
    );
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, _CU_SQLITE_RETRY: '1' },
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  console.error(
    `\n  Failed to load node:sqlite on Node ${nodeVer}.\n` +
      `  Tokwise needs the built-in node:sqlite module.\n\n` +
      `  Easiest fix — upgrade Node to 22.13+, 23.4+, or 24+:\n` +
      `      https://nodejs.org\n\n` +
      `  Or rerun manually with the experimental flag:\n` +
      `      node --experimental-sqlite ${process.argv[1] || 'server.js'}\n\n` +
      `  Underlying error: ${err && err.message}\n`
  );
  process.exit(1);
}
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_PATH =
  process.env.CLAUDE_USAGE_DB || path.join(os.homedir(), '.claude', 'usage.db');

// Anthropic API list prices in USD per 1M tokens. Claude Code subscription
// users are NOT billed this — it is shown as an "equivalent API cost" so you
// can see the dollar value of the work you ran locally.
const PRICING = {
  'claude-opus-4-7':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-5':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4':     { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus':       { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6': { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-5': { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4':   { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet':     { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
  'claude-haiku-4':    { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
  'claude-3-5-haiku':  { in: 0.8, out: 4,  cacheRead: 0.08, cacheWrite: 1 },
  'claude-haiku':      { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },

  // ---- OpenAI / Codex CLI (estimated API list prices, USD per 1M tokens) ----
  // OpenAI has no separate "cache write" charge, so cacheWrite == in for these.
  // Codex reports cached_input_tokens as a SUBSET of input; the adapter splits
  // them into fresh-input + cacheRead before costing, so these rates apply
  // cleanly. Prefix match (priceFor) picks the longest key, so the -mini/-nano
  // overrides win over the bare family price.
  'gpt-5.5':           { in: 1.25, out: 10,  cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-codex':       { in: 1.25, out: 10,  cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-nano':        { in: 0.05, out: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-5-mini':        { in: 0.25, out: 2,   cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5':             { in: 1.25, out: 10,  cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-4.1-mini':      { in: 0.4,  out: 1.6, cacheRead: 0.1,   cacheWrite: 0.4 },
  'gpt-4.1-nano':      { in: 0.1,  out: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  'gpt-4.1':           { in: 2,    out: 8,   cacheRead: 0.5,   cacheWrite: 2 },
  'gpt-4o-mini':       { in: 0.15, out: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  'gpt-4o':            { in: 2.5,  out: 10,  cacheRead: 1.25,  cacheWrite: 2.5 },
  'o4-mini':           { in: 1.1,  out: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  'o3-mini':           { in: 1.1,  out: 4.4, cacheRead: 0.55,  cacheWrite: 1.1 },
  'o3':                { in: 2,    out: 8,   cacheRead: 0.5,   cacheWrite: 2 },
  'gpt-4':             { in: 2.5,  out: 10,  cacheRead: 1.25,  cacheWrite: 2.5 },
  'codex':             { in: 1.25, out: 10,  cacheRead: 0.125, cacheWrite: 1.25 },
};
const DEFAULT_PRICE = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const RANGES = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };

// Standard Claude model context window (tokens). Used to gauge how full the
// most recent session's context is.
const CONTEXT_WINDOW = 200000;

function priceFor(model) {
  if (!model) return DEFAULT_PRICE;
  if (PRICING[model]) return PRICING[model];
  let best = DEFAULT_PRICE;
  let bestLen = 0;
  for (const key in PRICING) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = PRICING[key];
      bestLen = key.length;
    }
  }
  return best;
}

function costOf(model, t) {
  const p = priceFor(model);
  return (
    ((t.input || 0) / 1e6) * p.in +
    ((t.output || 0) / 1e6) * p.out +
    ((t.cacheRead || 0) / 1e6) * p.cacheRead +
    ((t.cacheCreation || 0) / 1e6) * p.cacheWrite
  );
}

function prettyModel(m) {
  if (!m || m === 'unknown') return 'Unknown';
  // strip a trailing date stamp like -20251030 that some model ids carry
  const id = m.replace(/-\d{6,}$/, '');

  // OpenAI families
  if (/^gpt-/i.test(id)) {
    // gpt-5.5 → "GPT-5.5", gpt-5-codex → "GPT-5 Codex", gpt-4o → "GPT-4o"
    const rest = id.slice(4);
    const pretty = rest
      .split('-')
      .map((p) => (/^[a-z]+$/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p))
      .join(' ');
    return `GPT-${pretty}`;
  }
  if (/^o\d/i.test(id)) return id.replace(/-/g, ' '); // o3, o4-mini → "o4 mini"
  if (/^codex/i.test(id)) return 'Codex';

  // Claude families: claude-opus-4-5 → "Opus 4.5"
  let s = id.replace(/^claude-/, '');
  const parts = s.split('-');
  const fam = parts.shift() || '';
  const ver = parts.join('.');
  const famName = fam.charAt(0).toUpperCase() + fam.slice(1);
  return ver ? `${famName} ${ver}` : famName;
}

function localDate(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function shortDay(key) {
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
function hourLabel(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function emptyAgg() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, toolCalls: 0 };
}
function addAgg(a, t, c) {
  a.turns++;
  a.input += t.input;
  a.output += t.output;
  a.cacheRead += t.cacheRead;
  a.cacheCreation += t.cacheCreation;
  a.cost += c;
}
function totalTokens(a) {
  return a.input + a.output + a.cacheRead + a.cacheCreation;
}

// ---------------------------------------------------------------------------
// Sources. The dashboard reads more than one AI coding tool. Each "source"
// resolves to the same normalized sessions/turns shape, so the entire
// aggregation pipeline (compute) is shared and source-agnostic.
//   claude → ~/.claude/usage.db          (SQLite, read directly)
//   codex  → ~/.codex/sessions/**/*.jsonl (parsed into an in-memory SQLite)
//   all    → both, merged in an in-memory SQLite
// ---------------------------------------------------------------------------
const CLAUDE_DB = DB_PATH;
const CODEX_SESSIONS_DIR =
  process.env.CLAUDE_USAGE_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions');
const GPT5_CONTEXT_WINDOW = 272000; // fallback if a rollout omits model_context_window

// in-memory schema mirrors Claude's usage.db so compute() runs unchanged
const MEM_SCHEMA = `
  CREATE TABLE sessions (
    session_id      TEXT PRIMARY KEY,
    project_name    TEXT,
    first_timestamp TEXT,
    last_timestamp  TEXT,
    git_branch      TEXT,
    model           TEXT
  );
  CREATE TABLE turns (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id            TEXT,
    timestamp             TEXT,
    model                 TEXT,
    input_tokens          INTEGER DEFAULT 0,
    output_tokens         INTEGER DEFAULT 0,
    cache_read_tokens     INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    tool_name             TEXT
  );
`;

function dirHasJsonl(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch (_) {
    return false;
  }
  let found = false;
  (function walk(d, depth) {
    if (found || depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (found) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && p.endsWith('.jsonl')) found = true;
    }
  })(dir, 0);
  return found;
}

// Which tools are present on this machine? Drives the UI source switcher.
// Claude counts if EITHER the usage.db cache or live transcripts exist.
function detectSources() {
  return [
    { id: 'claude', displayName: 'Claude Code',
      present: fs.existsSync(CLAUDE_DB) || dirHasJsonl(PROJECTS_DIR) },
    { id: 'codex',  displayName: 'Codex CLI',
      present: dirHasJsonl(CODEX_SESSIONS_DIR) },
  ];
}

function buildStats(opts = {}) {
  const source = ['claude', 'codex', 'all'].includes(opts.source) ? opts.source : 'claude';

  // Fast path — Claude only. EXACTLY the original behaviour, zero overhead,
  // Every source now assembles an in-memory SQLite (Claude schema) from the
  // tool's real-time JSONL transcripts, then runs the same compute() over it.
  //
  // IMPORTANT — Claude Code's ~/.claude/usage.db is a CACHE that Claude Code
  // only rebuilds occasionally (on start/quit), so it goes stale for days.
  // The transcripts in ~/.claude/projects/**/*.jsonl are the real-time source
  // of truth — written on every turn. We read those (mtime-cached) so the
  // numbers are always current. usage.db is used ONLY as a last-resort fallback
  // when no transcripts exist.
  const mem = new DatabaseSync(':memory:');
  try {
    mem.exec(MEM_SCHEMA);
    let dbSize = 0;
    let contextWindow = 0;
    let loadedAny = false;

    if (source === 'claude' || source === 'all') {
      const c = loadClaudeTranscriptsInto(mem);
      dbSize += c.sizeBytes;
      if (c.count) loadedAny = true;
    }
    if (source === 'codex' || source === 'all') {
      const codex = loadCodexInto(mem);
      dbSize += codex.sizeBytes;
      if (codex.count) loadedAny = true;
      if (source === 'codex' && codex.contextWindow) contextWindow = codex.contextWindow;
    }

    // Claude requested but nothing found anywhere (no transcripts, no usage.db).
    if (!loadedAny && source === 'claude') {
      const e = new Error(`No Claude usage data found (looked in ${PROJECTS_DIR} and ${CLAUDE_DB})`);
      e.code = 'NO_DB';
      throw e;
    }

    const computeOpts = {
      ...opts,
      source,
      _dbPath:
        source === 'codex' ? CODEX_SESSIONS_DIR
        : source === 'all' ? 'claude + codex transcripts'
        : PROJECTS_DIR,
      _dbSize: dbSize,
    };
    if (source === 'codex' && contextWindow) computeOpts._contextWindow = contextWindow;
    return compute(mem, computeOpts);
  } finally {
    try { mem.close(); } catch (_) {}
  }
}

// ---- Claude transcripts → normalized turns (the real-time source of truth) ---
// usage.db is a stale cache; ~/.claude/projects/**/*.jsonl is written live.
// We parse those, cached by file mtime so only changed files re-parse.
const _claudeCache = new Map(); // path -> { mtime, turns: [normalized rows] }

function parseClaudeTranscript(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    // cheap prefilter — only assistant turns carry usage; skip everything else
    if (!line || line.indexOf('"usage"') < 0 || line.indexOf('assistant') < 0) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
    const u = j.message.usage;
    let tool = '';
    if (Array.isArray(j.message.content)) {
      const tu = j.message.content.find((x) => x && x.type === 'tool_use');
      if (tu && tu.name) tool = tu.name;
    }
    rows.push({
      sid: j.sessionId || path.basename(filePath, '.jsonl'),
      ts: j.timestamp,
      model: j.message.model || 'unknown',
      inp: u.input_tokens || 0,
      outp: u.output_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
      cc: u.cache_creation_input_tokens || 0,
      tool,
      project: deriveProject(j.cwd),
      branch: j.gitBranch || '',
    });
  }
  return rows;
}

function getAllClaudeTurns() {
  const files = findJsonlFiles(); // [{ path, mtime, kind }]
  const all = [];
  for (const f of files) {
    const cached = _claudeCache.get(f.path);
    if (cached && cached.mtime === f.mtime) {
      all.push(...cached.turns);
      continue;
    }
    const turns = parseClaudeTranscript(f.path);
    _claudeCache.set(f.path, { mtime: f.mtime, turns });
    all.push(...turns);
  }
  // evict entries for files that vanished (keeps the cache from growing forever)
  if (_claudeCache.size > files.length * 1.5) {
    const live = new Set(files.map((f) => f.path));
    for (const k of _claudeCache.keys()) if (!live.has(k)) _claudeCache.delete(k);
  }
  return all;
}

function loadClaudeTranscriptsInto(memDb) {
  const turns = getAllClaudeTurns();
  if (!turns.length) {
    // No live transcripts on disk → fall back to the (possibly stale) usage.db
    // cache so the user/demo still sees data. This keeps the claude and "all"
    // paths consistent.
    const sz = copyClaudeInto(memDb);
    if (sz > 0) {
      const n = memDb.prepare('SELECT COUNT(*) n FROM turns').get().n;
      return { count: n, sizeBytes: sz, stale: true };
    }
    return { count: 0, sizeBytes: 0 };
  }
  // derive one session record per sessionId
  const sess = new Map();
  for (const t of turns) {
    let s = sess.get(t.sid);
    if (!s) {
      s = { sid: t.sid, project: t.project, branch: t.branch, first: t.ts, last: t.ts, models: new Map() };
      sess.set(t.sid, s);
    }
    if (t.ts < s.first) s.first = t.ts;
    if (t.ts > s.last) s.last = t.ts;
    if (t.project && t.project !== '(unknown)') s.project = t.project;
    if (t.branch) s.branch = t.branch;
    s.models.set(t.model, (s.models.get(t.model) || 0) + 1);
  }
  const insS = memDb.prepare(
    'INSERT OR REPLACE INTO sessions (session_id, project_name, first_timestamp, last_timestamp, git_branch, model) VALUES (?,?,?,?,?,?)'
  );
  const insT = memDb.prepare(
    'INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name) VALUES (?,?,?,?,?,?,?,?)'
  );
  memDb.exec('BEGIN');
  for (const s of sess.values()) {
    let dm = 'unknown', dn = -1;
    for (const [m, n] of s.models) if (n > dn) { dn = n; dm = m; }
    insS.run(s.sid, s.project, s.first, s.last, s.branch, dm);
  }
  for (const t of turns) {
    insT.run(t.sid, t.ts, t.model, t.inp, t.outp, t.cr, t.cc, t.tool || null);
  }
  memDb.exec('COMMIT');
  return { count: turns.length, sizeBytes: 0 };
}

// (kept for reference / fallback tooling — copies usage.db into an in-memory db)
function copyClaudeInto(memDb) {
  if (!fs.existsSync(CLAUDE_DB)) return 0;
  const src = new DatabaseSync(CLAUDE_DB, { readOnly: true });
  try {
    const sessions = src
      .prepare('SELECT session_id, project_name, first_timestamp, last_timestamp, git_branch, model FROM sessions')
      .all();
    const turns = src
      .prepare('SELECT session_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name FROM turns')
      .all();
    const insS = memDb.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, project_name, first_timestamp, last_timestamp, git_branch, model) VALUES (?,?,?,?,?,?)'
    );
    const insT = memDb.prepare(
      'INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name) VALUES (?,?,?,?,?,?,?,?)'
    );
    memDb.exec('BEGIN');
    for (const s of sessions)
      insS.run(s.session_id, s.project_name, s.first_timestamp, s.last_timestamp, s.git_branch, s.model);
    for (const t of turns)
      insT.run(t.session_id, t.timestamp, t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.tool_name);
    memDb.exec('COMMIT');
    return fs.statSync(CLAUDE_DB).size;
  } finally {
    try { src.close(); } catch (_) {}
  }
}

// Parse all Codex rollouts and insert normalized rows into the in-memory db.
function loadCodexInto(memDb) {
  const files = findCodexSessionFiles();
  if (!files.length) return { count: 0, sizeBytes: 0, contextWindow: 0 };
  const insS = memDb.prepare(
    'INSERT OR REPLACE INTO sessions (session_id, project_name, first_timestamp, last_timestamp, git_branch, model) VALUES (?,?,?,?,?,?)'
  );
  const insT = memDb.prepare(
    'INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name) VALUES (?,?,?,?,?,?,?,?)'
  );
  let count = 0;
  let sizeBytes = 0;
  let contextWindow = 0;
  memDb.exec('BEGIN');
  for (const f of files) {
    sizeBytes += f.size;
    const s = parseCodexRollout(f.path);
    if (!s) continue;
    contextWindow = Math.max(contextWindow, s.contextWindow || 0);
    insS.run(s.sessionId, s.project, s.first, s.last, s.branch || '', s.model);
    for (const t of s.turns) {
      insT.run(
        s.sessionId, t.ts, t.model || s.model,
        t.input, t.output, t.cacheRead, t.cacheCreation, t.tool || null
      );
      count++;
    }
  }
  memDb.exec('COMMIT');
  return { count, sizeBytes, contextWindow: contextWindow || GPT5_CONTEXT_WINDOW };
}

function compute(db, opts) {
  const allProjects = db
    .prepare(
      "SELECT DISTINCT project_name p FROM sessions WHERE project_name IS NOT NULL AND project_name <> '' ORDER BY 1"
    )
    .all()
    .map((r) => r.p);

  const span =
    db
      .prepare('SELECT MIN(first_timestamp) a, MAX(last_timestamp) b FROM sessions')
      .get() || { a: null, b: null };

  const range = RANGES[opts.range] ? opts.range : 'all';
  let since = opts.since || null;
  let until = opts.until || null;
  if (!since && RANGES[range] && span.b) {
    since = new Date(
      new Date(span.b).getTime() - RANGES[range] * 86400000
    ).toISOString();
  }
  let project = 'all';
  if (opts.project && opts.project !== 'all' && allProjects.includes(opts.project)) {
    project = opts.project;
  }

  const where = [];
  const params = [];
  if (project !== 'all') {
    where.push('s.project_name = ?');
    params.push(project);
  }
  if (since) {
    where.push('t.timestamp >= ?');
    params.push(since);
  }
  if (until) {
    where.push('t.timestamp <= ?');
    params.push(until);
  }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db
    .prepare(
      `SELECT t.session_id sid, t.timestamp ts, t.model model,
              t.input_tokens inp, t.output_tokens outp,
              t.cache_read_tokens cr, t.cache_creation_tokens cc,
              t.tool_name tool, s.project_name project, s.git_branch branch
         FROM turns t
         JOIN sessions s ON t.session_id = s.session_id
         ${W}
        ORDER BY t.timestamp ASC`
    )
    .all(...params);

  const totals = emptyAgg();
  totals.toolCalls = 0;
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const byTool = new Map();
  const bySession = new Map();
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const activeDays = new Set();

  for (const r of rows) {
    const tok = {
      input: r.inp || 0,
      output: r.outp || 0,
      cacheRead: r.cr || 0,
      cacheCreation: r.cc || 0,
    };
    const model = r.model || 'unknown';
    const c = costOf(model, tok);
    addAgg(totals, tok, c);
    if (r.tool) {
      totals.toolCalls++;
      byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
    }

    const d = new Date(r.ts);
    const day = localDate(d);
    activeDays.add(day);
    byHour[d.getHours()]++;
    byWeekday[d.getDay()]++;

    if (!byModel.has(model)) byModel.set(model, emptyAgg());
    addAgg(byModel.get(model), tok, c);

    const pname = r.project || '(unknown)';
    if (!byProject.has(pname))
      byProject.set(pname, { agg: emptyAgg(), sessions: new Set() });
    const pp = byProject.get(pname);
    addAgg(pp.agg, tok, c);
    pp.sessions.add(r.sid);

    if (!byDay.has(day)) byDay.set(day, emptyAgg());
    addAgg(byDay.get(day), tok, c);
    if (r.tool) byDay.get(day).toolCalls++;

    if (!bySession.has(r.sid)) {
      bySession.set(r.sid, {
        id: r.sid,
        project: pname,
        branch: r.branch || '',
        first: r.ts,
        last: r.ts,
        agg: emptyAgg(),
        models: new Map(),
        tools: 0,
        lastTurn: null,
      });
    }
    const ss = bySession.get(r.sid);
    if (r.ts < ss.first) ss.first = r.ts;
    if (r.ts > ss.last) ss.last = r.ts;
    addAgg(ss.agg, tok, c);
    ss.models.set(model, (ss.models.get(model) || 0) + 1);
    if (r.tool) ss.tools++;
    // rows are ORDER BY timestamp ASC, so this lands on the latest turn
    if (!ss.lastTurn || r.ts >= ss.lastTurn.ts) {
      ss.lastTurn = {
        ts: r.ts,
        tool: r.tool || '',
        model,
        input: tok.input,
        output: tok.output,
        cacheRead: tok.cacheRead,
        cacheCreation: tok.cacheCreation,
      };
    }
  }
  totals.sessions = bySession.size;
  totals.totalTokens = totalTokens(totals);

  const byModelArr = [...byModel]
    .map(([model, a]) => ({
      model,
      display: prettyModel(model),
      ...a,
      totalTokens: totalTokens(a),
      share: rows.length ? a.turns / rows.length : 0,
    }))
    .sort((x, y) => y.cost - x.cost);

  const byProjectArr = [...byProject]
    .map(([projectName, v]) => ({
      project: projectName,
      sessions: v.sessions.size,
      ...v.agg,
      totalTokens: totalTokens(v.agg),
    }))
    .sort((x, y) => y.cost - x.cost);

  const byDayArr = fillDays(byDay);

  const byToolArr = [...byTool]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  // group mcp__SERVER__tool calls by their MCP server
  const mcpMap = new Map();
  for (const t of byToolArr) {
    if (!t.tool.startsWith('mcp__')) continue;
    const parts = t.tool.split('__');
    const server = parts[1] || 'unknown';
    const tname = parts.slice(2).join('__') || t.tool;
    if (!mcpMap.has(server)) mcpMap.set(server, { server, calls: 0, tools: [] });
    const s = mcpMap.get(server);
    s.calls += t.count;
    s.tools.push({ tool: tname, count: t.count, fullName: t.tool });
  }
  const byMcpServer = [...mcpMap.values()].sort((a, b) => b.calls - a.calls);
  const nativeToolCalls = byToolArr
    .filter((t) => !t.tool.startsWith('mcp__'))
    .reduce((a, t) => a + t.count, 0);
  const mcpToolCalls = byMcpServer.reduce((a, s) => a + s.calls, 0);

  const sessionsArr = [...bySession.values()]
    .map((s) => {
      let domModel = 'unknown';
      let domN = -1;
      for (const [m, n] of s.models) {
        if (n > domN) {
          domN = n;
          domModel = m;
        }
      }
      const lt = s.lastTurn || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tool: '' };
      const lastContext = lt.input + lt.cacheRead + lt.cacheCreation;
      return {
        id: s.id,
        idShort: s.id.slice(0, 8),
        project: s.project,
        branch: s.branch,
        model: domModel,
        modelDisplay: prettyModel(domModel),
        modelCount: s.models.size,
        first: s.first,
        last: s.last,
        durationMin: Math.max(0, ((new Date(s.last) - new Date(s.first)) / 60000) || 0),
        turns: s.agg.turns,
        input: s.agg.input,
        output: s.agg.output,
        cacheRead: s.agg.cacheRead,
        cacheCreation: s.agg.cacheCreation,
        totalTokens: totalTokens(s.agg),
        cost: s.agg.cost,
        toolCalls: s.tools,
        lastContext,
        lastTool: lt.tool || '',
      };
    })
    .sort((a, b) => new Date(b.last) - new Date(a.last));

  // attach per-day session-start counts to byDayArr
  const sessionStartByDay = {};
  for (const s of sessionsArr) {
    const k = localDate(new Date(s.first));
    sessionStartByDay[k] = (sessionStartByDay[k] || 0) + 1;
  }
  for (const dd of byDayArr) dd.sessions = sessionStartByDay[dd.day] || 0;

  const recent = rows
    .slice(-60)
    .reverse()
    .map((r) => {
      const tok = {
        input: r.inp || 0,
        output: r.outp || 0,
        cacheRead: r.cr || 0,
        cacheCreation: r.cc || 0,
      };
      return {
        sid: r.sid.slice(0, 8),
        ts: r.ts,
        model: r.model || 'unknown',
        modelDisplay: prettyModel(r.model || 'unknown'),
        tool: r.tool || '',
        project: r.project || '(unknown)',
        ...tok,
        totalTokens: tok.input + tok.output + tok.cacheRead + tok.cacheCreation,
        cost: costOf(r.model, tok),
      };
    });

  let cacheSavings = 0;
  for (const [model, a] of byModel) {
    const p = priceFor(model);
    cacheSavings += (a.cacheRead / 1e6) * (p.in - p.cacheRead);
  }
  const cacheBase = totals.cacheRead + totals.cacheCreation + totals.input;
  const cacheHitRate = cacheBase ? totals.cacheRead / cacheBase : 0;

  // The context window is an account-level property, so infer it from the
  // largest prompt ever seen (unfiltered): a >200K prompt means the 1M tier.
  const gp = db
    .prepare(
      'SELECT MAX(cache_read_tokens + cache_creation_tokens + input_tokens) m FROM turns'
    )
    .get();
  const contextWindow = opts._contextWindow
    ? opts._contextWindow
    : (gp && gp.m > CONTEXT_WINDOW ? 1000000 : CONTEXT_WINDOW);

  // ---- per-session health classification ----
  const NOW_TS = Date.now();
  for (const s of sessionsArr) {
    const fill = contextWindow ? s.lastContext / contextWindow : 0;
    const ageMin = (NOW_TS - new Date(s.last)) / 60000;
    const h = classifyHealth({ fill, ageMin, turns: s.turns, ctx: s.lastContext });
    s.contextFill = fill;
    s.ageMin = ageMin;
    s.health = h.health;
    s.healthTone = h.tone;
    s.healthMessage = h.message;
  }

  // ---- per-project advisor (which session to keep using, when to start fresh) ----
  const HEALTH_ORDER = {
    fresh: 0, healthy: 1, 'getting-full': 2, 'near-max': 3, stale: 4, abandoned: 5,
  };
  const advMap = new Map();
  for (const s of sessionsArr) {
    const k = s.project || '(unknown)';
    if (!advMap.has(k))
      advMap.set(k, {
        project: k,
        sessions: [],
        counts: { fresh:0, healthy:0, 'getting-full':0, 'near-max':0, stale:0, abandoned:0 },
      });
    const p = advMap.get(k);
    p.sessions.push(s);
    p.counts[s.health] = (p.counts[s.health] || 0) + 1;
  }
  const projectAdvice = [...advMap.values()].map((p) => {
    let best = null;
    let bestScore = Infinity;
    for (const s of p.sessions) {
      if (!['fresh', 'healthy', 'getting-full'].includes(s.health)) continue;
      const score = s.contextFill * 100 + s.ageMin / 60 + s.turns * 0.5;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    p.sessions.sort((a, b) => {
      const oa = HEALTH_ORDER[a.health] ?? 9;
      const ob = HEALTH_ORDER[b.health] ?? 9;
      if (oa !== ob) return oa - ob;
      return (a.ageMin || 0) - (b.ageMin || 0);
    });
    const c = p.counts;
    const total = p.sessions.length;
    const staleCount = (c.stale || 0) + (c.abandoned || 0);
    let summary, needsNew = false;
    if (staleCount === total) {
      summary = 'Project dormant — start fresh if resuming';
      needsNew = true;
    } else if (!best) {
      summary = 'All sessions full — start a fresh session';
      needsNew = true;
    } else {
      const parts = [];
      if (c.fresh) parts.push(`${c.fresh} fresh`);
      if (c.healthy) parts.push(`${c.healthy} healthy`);
      if (c['getting-full']) parts.push(`${c['getting-full']} getting full`);
      if (c['near-max']) parts.push(`${c['near-max']} near max`);
      if (c.stale) parts.push(`${c.stale} stale`);
      summary = `${parts.join(', ') || 'fresh start'} — continue ${best.idShort}`;
    }
    return {
      project: p.project,
      total,
      counts: c,
      totals: {
        turns: p.sessions.reduce((a, s) => a + (s.turns || 0), 0),
        cost: p.sessions.reduce((a, s) => a + (s.cost || 0), 0),
        tokens: p.sessions.reduce((a, s) => a + (s.totalTokens || 0), 0),
      },
      best: best
        ? { id: best.id, idShort: best.idShort, contextFill: best.contextFill,
            ageMin: best.ageMin, turns: best.turns, cost: best.cost }
        : null,
      needsNew,
      summary,
      sessionIds: p.sessions.slice(0, 6).map((s) => ({
        id: s.id, idShort: s.idShort, health: s.health, healthTone: s.healthTone,
        healthMessage: s.healthMessage, contextFill: s.contextFill, ageMin: s.ageMin,
        turns: s.turns, cost: s.cost,
      })),
    };
  }).sort((a, b) => b.total - a.total);

  // ---- forecast: this calendar month projection ----
  // Always uses UNFILTERED data so the forecast is meaningful regardless
  // of the current project/range filter.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const sevenAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  function modelSumCost(sinceTs) {
    const rows = db
      .prepare(
        `SELECT model, SUM(input_tokens) inp, SUM(output_tokens) outp,
                SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc
           FROM turns WHERE timestamp >= ? GROUP BY model`
      )
      .all(sinceTs);
    let c = 0;
    for (const r of rows) {
      c += costOf(r.model, {
        input: r.inp || 0,
        output: r.outp || 0,
        cacheRead: r.cr || 0,
        cacheCreation: r.cc || 0,
      });
    }
    return c;
  }
  const monthToDateCost = modelSumCost(monthStart);
  const recent7Cost = modelSumCost(sevenAgo);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysIntoMonth = now.getDate();
  const daysRemaining = Math.max(0, daysInMonth - daysIntoMonth);
  const recentDailyRate = recent7Cost / 7;
  const forecast = {
    monthToDateCost,
    recentDailyRate,
    daysIntoMonth,
    daysInMonth,
    daysRemaining,
    projectedMonthEnd: monthToDateCost + recentDailyRate * daysRemaining,
    monthLabel: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
  };

  // most-recent session + its context-window usage
  let live = null;
  if (rows.length) {
    const liveSid = rows[rows.length - 1].sid;
    const liveRows = rows.filter((r) => r.sid === liveSid);
    const ls = bySession.get(liveSid);
    const ctxSeries = liveRows.map((r) => (r.cr || 0) + (r.cc || 0) + (r.inp || 0));
    const lastRow = liveRows[liveRows.length - 1];
    let dm = 'unknown', dn = -1;
    for (const [m, n] of ls.models) if (n > dn) { dn = n; dm = m; }
    live = {
      sessionId: liveSid,
      project: ls.project,
      branch: ls.branch,
      model: dm,
      modelDisplay: prettyModel(dm),
      first: ls.first,
      last: ls.last,
      turns: ls.agg.turns,
      toolCalls: ls.tools,
      cost: ls.agg.cost,
      durationMin: Math.max(0, ((new Date(ls.last) - new Date(ls.first)) / 60000) || 0),
      contextWindow,
      currentContext: ctxSeries[ctxSeries.length - 1] || 0,
      peakContext: ctxSeries.length ? Math.max(...ctxSeries) : 0,
      avgContext: ctxSeries.length
        ? ctxSeries.reduce((a, b) => a + b, 0) / ctxSeries.length : 0,
      contextSeries: downsample(ctxSeries, 64),
      lastTurn: {
        cacheRead: lastRow.cr || 0,
        cacheCreation: lastRow.cc || 0,
        input: lastRow.inp || 0,
        output: lastRow.outp || 0,
      },
    };
  }
  const optimization = buildOptimization({ live, cacheHitRate, cacheSavings, sessionsArr });

  const insights = buildInsights({
    byDayArr,
    byToolArr,
    sessionsArr,
    byHour,
    byModelArr,
    totals,
    activeDays,
    cacheHitRate,
    cacheSavings,
  });

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      source: opts.source || 'claude',
      dbPath: opts._dbPath || DB_PATH,
      dbSizeBytes:
        opts._dbSize != null
          ? opts._dbSize
          : fs.existsSync(DB_PATH)
          ? fs.statSync(DB_PATH).size
          : 0,
      projects: allProjects,
      firstEver: span.a,
      lastEver: span.b,
      appliedProject: project,
      appliedRange: range,
      appliedSince: since,
      appliedUntil: until,
    },
    range: {
      first: rows.length ? rows[0].ts : null,
      last: rows.length ? rows[rows.length - 1].ts : null,
      activeDays: activeDays.size,
      spanDays: byDayArr.length,
    },
    totals,
    cache: {
      read: totals.cacheRead,
      creation: totals.cacheCreation,
      input: totals.input,
      hitRate: cacheHitRate,
      savings: cacheSavings,
    },
    byModel: byModelArr,
    byProject: byProjectArr,
    byDay: byDayArr,
    byTool: byToolArr,
    byHour,
    byWeekday,
    sessions: sessionsArr,
    recent,
    insights,
    live,
    optimization,
    forecast,
    byMcpServer,
    mcpToolCalls,
    nativeToolCalls,
    projectAdvice,
  };
}

function downsample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (n - 1))]);
  }
  return out;
}

function classifyHealth({ fill, ageMin, turns, ctx }) {
  // ranked most-severe first; first match wins
  if (!Number.isFinite(ageMin)) ageMin = 0;
  if (!Number.isFinite(fill)) fill = 0;
  if (ageMin >= 10080) return { health:'abandoned', tone:'dim',
    message:'Dormant 7+ days — likely safe to ignore' };
  if (ageMin >= 1440) return { health:'stale', tone:'dim',
    message:'Idle 1+ day — context may be outdated' };
  // near-max wins over the tiny-context override — a single huge prompt is
  // still near-max, not "fresh".
  if (fill >= 0.75) return { health:'near-max', tone:'risk',
    message:'Run /compact now or start a fresh session' };
  if (fill >= 0.50) return { health:'getting-full', tone:'warn',
    message:'Consider /compact before deep work' };
  // tiny-context override (low fill AND barely-used) → fresh
  if (turns <= 1 || ctx < 5000) return { health:'fresh', tone:'ok',
    message:'Fresh — plenty of room to work' };
  if (fill < 0.15 && ageMin < 60 && turns <= 3) return { health:'fresh', tone:'ok',
    message:'Fresh — plenty of room to work' };
  if (fill < 0.50 && ageMin < 240) return { health:'healthy', tone:'good',
    message:'Good to continue — lots of headroom' };
  return { health:'healthy', tone:'good',
    message:'Has headroom — continue or start fresh' };
}

function buildOptimization(ctx) {
  const { live, cacheHitRate, cacheSavings, sessionsArr } = ctx;
  const tips = [];
  if (live) {
    const fill = live.currentContext / live.contextWindow;
    const pct = Math.round(fill * 100);
    if (fill >= 0.7) {
      tips.push({
        kind: 'warn',
        title: `Context window is ${pct}% full`,
        body: `Run /compact to summarize the conversation into a compact form, or /clear before an unrelated task. Both trim stale history while keeping the active task — quality stays, token weight drops.`,
      });
    } else if (fill >= 0.4) {
      tips.push({
        kind: 'tip',
        title: `Context is ${pct}% full — still healthy`,
        body: `Plenty of headroom. /compact becomes worthwhile past ~70%, when every turn re-sends a large prompt.`,
      });
    } else {
      tips.push({
        kind: 'good',
        title: `Context only ${pct}% full`,
        body: `Lots of room in the window — no need to compact or clear yet.`,
      });
    }
  }
  if (cacheHitRate >= 0.8) {
    tips.push({
      kind: 'good',
      title: `Prompt cache hit rate is ${(cacheHitRate * 100).toFixed(0)}%`,
      body: `Caching is doing its job and has saved an estimated $${Math.round(
        cacheSavings
      ).toLocaleString()}. It applies automatically — re-reads cost ~10% of fresh tokens.`,
    });
  } else {
    tips.push({
      kind: 'warn',
      title: `Cache hit rate is ${(cacheHitRate * 100).toFixed(0)}%`,
      body: `Editing a file invalidates everything cached after it. Batching related edits, and avoiding frequent /clear, keeps more of the prompt prefix cached and cheap.`,
    });
  }
  const longest = sessionsArr.reduce((a, b) => (b.turns > (a ? a.turns : -1) ? b : a), null);
  if (longest && longest.turns >= 1200) {
    tips.push({
      kind: 'tip',
      title: `Longest session ran ${longest.turns.toLocaleString()} turns`,
      body: `Long sessions carry a big context on every single turn. Splitting unrelated work into separate sessions keeps each context small — same answers, far fewer tokens.`,
    });
  }
  tips.push({
    kind: 'tip',
    title: 'Point Claude at exact files and lines',
    body: `Asking to fix "src/auth.js:42" instead of "find the auth bug" skips the search-and-read turns entirely — identical result, a fraction of the tokens.`,
  });
  tips.push({
    kind: 'tip',
    title: 'Keep CLAUDE.md lean',
    body: `CLAUDE.md is injected into every request. Trim it to durable facts so it is not paying token rent on every turn.`,
  });
  tips.push({
    kind: 'tip',
    title: 'Use /clear between unrelated tasks',
    body: `A fresh context for a new task avoids dragging the previous task's tokens along — no quality cost when the work is unrelated anyway.`,
  });
  return tips;
}

function fillDays(map) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const cur = new Date(keys[0] + 'T12:00:00');
  const end = new Date(keys[keys.length - 1] + 'T12:00:00');
  while (cur <= end) {
    const k = localDate(cur);
    const a = map.get(k) || emptyAgg();
    out.push({ day: k, ...a, totalTokens: totalTokens(a) });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function buildInsights(ctx) {
  const out = [];
  if (ctx.byDayArr.length) {
    const top = ctx.byDayArr.reduce((a, b) => (b.turns > a.turns ? b : a));
    out.push({
      label: 'Most active day',
      value: shortDay(top.day),
      sub: `${top.turns.toLocaleString()} turns`,
    });
  }
  if (ctx.byToolArr.length) {
    out.push({
      label: 'Favorite tool',
      value: ctx.byToolArr[0].tool,
      sub: `${ctx.byToolArr[0].count.toLocaleString()} calls`,
    });
  }
  if (ctx.sessionsArr.length) {
    const big = ctx.sessionsArr.reduce((a, b) => (b.turns > a.turns ? b : a));
    out.push({
      label: 'Longest session',
      value: `${big.turns.toLocaleString()} turns`,
      sub: big.project,
    });
  }
  let ph = 0;
  for (let i = 1; i < 24; i++) if (ctx.byHour[i] > ctx.byHour[ph]) ph = i;
  if (ctx.byHour[ph] > 0) {
    out.push({
      label: 'Peak hour',
      value: hourLabel(ph),
      sub: `${ctx.byHour[ph].toLocaleString()} turns`,
    });
  }
  if (ctx.byModelArr.length) {
    let topM = ctx.byModelArr[0];
    for (const m of ctx.byModelArr) if (m.turns > topM.turns) topM = m;
    out.push({
      label: 'Most used model',
      value: topM.display,
      sub: `${Math.round(topM.share * 100)}% of turns`,
    });
  }
  out.push({
    label: 'Cache hit rate',
    value: `${(ctx.cacheHitRate * 100).toFixed(1)}%`,
    sub: `~$${Math.round(ctx.cacheSavings).toLocaleString()} saved`,
  });
  const days = ctx.activeDays.size || 1;
  out.push({
    label: 'Daily average',
    value: `${Math.round(ctx.totals.turns / days).toLocaleString()} turns`,
    sub: `over ${ctx.activeDays.size} active day${ctx.activeDays.size === 1 ? '' : 's'}`,
  });
  return out;
}

// ---- session deep-dive ----
// Gather all turns for one session id from the real-time transcripts —
// Claude (~/.claude/projects) first, then Codex rollouts. Returns normalized
// turns + project/branch, or null if the session isn't found.
function collectSessionTurns(id) {
  const claude = getAllClaudeTurns().filter((t) => t.sid === id);
  if (claude.length) {
    const project =
      (claude.find((t) => t.project && t.project !== '(unknown)') || claude[0]).project;
    const branch = (claude.find((t) => t.branch) || {}).branch || '';
    const turns = claude
      .map((t) => ({ ts: t.ts, model: t.model, input: t.inp, output: t.outp,
        cacheRead: t.cr, cacheCreation: t.cc, tool: t.tool || '' }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    return { turns, project, branch };
  }
  // Codex — the session id is embedded in the rollout filename
  const codexFiles = findCodexSessionFiles();
  const candidates = codexFiles.filter((f) => f.path.includes(id));
  for (const f of (candidates.length ? candidates : codexFiles)) {
    const s = parseCodexRollout(f.path);
    if (s && s.sessionId === id) {
      const turns = s.turns
        .map((t) => ({ ts: t.ts, model: t.model || s.model, input: t.input, output: t.output,
          cacheRead: t.cacheRead, cacheCreation: t.cacheCreation, tool: '' }))
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));
      return { turns, project: s.project, branch: s.branch };
    }
  }
  return null;
}

function buildSessionDetail(id) {
  const found = collectSessionTurns(id);
  if (!found || !found.turns.length) return null;
  const { turns: raw, project, branch } = found;

  const turnsOut = raw.map((t, i) => {
    const tok = {
      input: t.input || 0,
      output: t.output || 0,
      cacheRead: t.cacheRead || 0,
      cacheCreation: t.cacheCreation || 0,
    };
    return {
      idx: i,
      ts: t.ts,
      model: t.model || 'unknown',
      modelDisplay: prettyModel(t.model || 'unknown'),
      tool: t.tool || '',
      ...tok,
      contextSize: tok.input + tok.cacheRead + tok.cacheCreation,
      cost: costOf(t.model, tok),
    };
  });

  const byToolMap = new Map();
  let toolCalls = 0;
  for (const t of raw)
    if (t.tool) {
      byToolMap.set(t.tool, (byToolMap.get(t.tool) || 0) + 1);
      toolCalls++;
    }
  const byTool = [...byToolMap]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  const modelMap = new Map();
  for (const t of raw) {
    const m = t.model || 'unknown';
    modelMap.set(m, (modelMap.get(m) || 0) + 1);
  }
  const models = [...modelMap]
    .map(([m, n]) => ({ model: m, display: prettyModel(m), turns: n }))
    .sort((a, b) => b.turns - a.turns);

  const totals = {
    turns: raw.length,
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, toolCalls,
  };
  let peakContext = 0;
  for (const t of turnsOut) {
    totals.input += t.input;
    totals.output += t.output;
    totals.cacheRead += t.cacheRead;
    totals.cacheCreation += t.cacheCreation;
    totals.cost += t.cost;
    if (t.contextSize > peakContext) peakContext = t.contextSize;
  }
  const avgContext = turnsOut.length
    ? turnsOut.reduce((a, t) => a + t.contextSize, 0) / turnsOut.length
    : 0;

  const slim = turnsOut.map((t) => ({ idx: t.idx, ts: t.ts, ctx: t.contextSize, cost: t.cost, tool: t.tool }));
  const timeline = downsample(slim, 200);
  const last = turnsOut[turnsOut.length - 1] || null;
  const first = raw[0].ts;
  const lastTs = raw[raw.length - 1].ts;

  return {
    session: {
      id,
      project,
      branch,
      first,
      last: lastTs,
      durationMin: Math.max(0, ((new Date(lastTs) - new Date(first)) / 60000) || 0),
    },
    totals: { ...totals, peakContext, avgContext },
    models,
    byTool,
    timeline,
    turnCount: raw.length,
    lastTurn: last,
  };
}

// ============================ TRUE LIVE (JSONL tail) ============================
// Claude Code writes per-turn events to JSONL files in ~/.claude/projects/*
// as soon as each turn completes. The usage.db cache is rebuilt on a much
// slower schedule (often only when Claude Code starts/quits). For genuine
// real-time activity ("LIVE"), we read the most-recently-modified JSONL
// directly and parse its tail.

const PROJECTS_DIR =
  process.env.CLAUDE_USAGE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

function deriveProject(cwd) {
  if (!cwd) return '(unknown)';
  // JSONL transcripts may have either POSIX (`/Users/foo/code/proj`) or
  // Windows (`C:\Users\foo\code\proj`) paths depending on the OS that
  // recorded them. Split on either separator so the project label
  // (last two segments, joined with `/`) works for both.
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '(unknown)';
  return parts.slice(-2).join('/');
}

// ============================ CODEX CLI adapter ============================
// Codex writes per-session rollouts to ~/.codex/sessions/YYYY/MM/DD/
// rollout-<ISO>-<uuid>.jsonl. Each line is { timestamp, type, payload }.
// The lines we care about:
//   session_meta  → id, cwd
//   turn_context  → model (per turn; usually constant within a session)
//   event_msg / token_count → info.last_token_usage (the per-turn delta) with
//     input_tokens (INCLUDES cached), cached_input_tokens, output_tokens, and
//     info.model_context_window.
// We map each token_count event to one normalized "turn" — the same shape and
// billing semantics as a Claude turn (each is one billable API call):
//   input  = input_tokens - cached_input_tokens   (fresh prompt)
//   cacheRead = cached_input_tokens               (cheap re-read)
//   cacheCreation = 0                             (Codex has no separate write)
//   output = output_tokens                        (already includes reasoning)
function findCodexSessionFiles() {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
          const st = fs.statSync(p);
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        }
      } catch (_) {}
    }
  })(CODEX_SESSIONS_DIR, 0);
  return out;
}

function parseCodexRollout(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const lines = text.split('\n');
  let sessionId = null, cwd = '', branch = '', curModel = '';
  let first = null, last = null, contextWindow = 0;
  const turns = [];
  for (const line of lines) {
    if (!line) continue;
    // Prefilter: rollout response_item lines can be multi-MB (base64 images).
    // Only JSON.parse the three small line kinds we actually need.
    if (
      line.indexOf('token_count') < 0 &&
      line.indexOf('session_meta') < 0 &&
      line.indexOf('turn_context') < 0
    ) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const p = j.payload || {};
    const type = p.type || j.type;
    const ts = j.timestamp;
    if (type === 'session_meta') {
      sessionId = p.id || sessionId;
      cwd = p.cwd || cwd;
      if (p.git && p.git.branch) branch = p.git.branch;
    } else if (type === 'turn_context') {
      if (p.model) curModel = p.model;
      if (p.cwd && !cwd) cwd = p.cwd;
    } else if (type === 'token_count') {
      const info = p.info || {};
      if (info.model_context_window) {
        contextWindow = Math.max(contextWindow, info.model_context_window);
      }
      const u = info.last_token_usage;
      if (u && (u.input_tokens || u.output_tokens)) {
        const cached = u.cached_input_tokens || 0;
        const fresh = Math.max(0, (u.input_tokens || 0) - cached);
        turns.push({
          ts,
          model: curModel || 'gpt-5',
          input: fresh,
          cacheRead: cached,
          cacheCreation: 0,
          output: u.output_tokens || 0,
          tool: '', // Codex tool calls live in multi-MB response_item lines; skipped for speed
        });
        if (!first || ts < first) first = ts;
        if (!last || ts > last) last = ts;
      }
    }
  }
  if (!sessionId) {
    const m = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = m ? m[1] : path.basename(filePath);
  }
  if (!turns.length) return null;
  return {
    sessionId,
    cwd,
    branch,
    model: curModel || 'gpt-5',
    project: deriveProject(cwd),
    first,
    last,
    contextWindow,
    turns,
  };
}

function tailRead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // first line is probably partial when we seek mid-file — discard it
    if (start > 0) {
      const i = text.indexOf('\n');
      if (i >= 0) text = text.slice(i + 1);
    }
    return text;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function parseLastTurns(filePath, count) {
  let text;
  try {
    text = tailRead(filePath, 500_000);
  } catch (_) {
    return [];
  }
  const lines = text.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
    let tool = '';
    if (Array.isArray(j.message.content)) {
      const tu = j.message.content.find((x) => x && x.type === 'tool_use');
      if (tu && tu.name) tool = tu.name;
    }
    const u = j.message.usage;
    const model = j.message.model || 'unknown';
    const tok = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreation: u.cache_creation_input_tokens || 0,
    };
    out.unshift({
      ts: j.timestamp,
      sessionId: j.sessionId,
      project: deriveProject(j.cwd),
      cwd: j.cwd || '',
      branch: j.gitBranch || '',
      model,
      modelDisplay: prettyModel(model),
      tool,
      ...tok,
      totalTokens: tok.input + tok.output + tok.cacheRead + tok.cacheCreation,
      cost: costOf(model, tok),
      stopReason: j.message.stop_reason || '',
    });
  }
  return out;
}

function findJsonlFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  (function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && p.endsWith('.jsonl')) {
          const st = fs.statSync(p);
          // Subagent transcripts live under .../projects/<proj>/subagents/...
          // Use platform-aware separators so Windows paths classify correctly.
          const sep = path.sep;
          const subagentMarker = `${sep}subagents${sep}`;
          out.push({
            path: p,
            mtime: st.mtimeMs,
            kind: p.includes(subagentMarker) ? 'subagent' : 'main',
          });
        }
      } catch (_) {}
    }
  })(PROJECTS_DIR, 0);
  return out;
}

// Genuine real-time view, source-aware. claude → ~/.claude/projects JSONL,
// codex → ~/.codex/sessions rollouts, all → both merged (newest first).
function readLiveFromJSONL(source) {
  const src = ['claude', 'codex', 'all'].includes(source) ? source : 'claude';
  const nowT = Date.now();
  let sessions = [];
  let activeFiles = [];

  if (src === 'claude' || src === 'all') {
    const r = readClaudeLive(nowT);
    if (r) { sessions.push(...r.sessions); activeFiles.push(...r.activeFiles); }
  }
  if (src === 'codex' || src === 'all') {
    const r = readCodexLive(nowT);
    if (r) { sessions.push(...r.sessions); activeFiles.push(...r.activeFiles); }
  }
  if (!sessions.length) return null;

  sessions.sort((a, b) => new Date(b.last) - new Date(a.last));
  sessions = sessions.slice(0, 6);
  return {
    asOf: new Date().toISOString(),
    count: sessions.length,
    sessions,
    activeFiles: activeFiles
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10),
  };
}

function readClaudeLive(nowT) {
  const files = findJsonlFiles();
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;       // main sessions: any file touched in 30m
  const SUBAGENT_WINDOW_MS = 5 * 60 * 1000;      // subagents: only if updated in last 5m (still running)
  const MAX_SESSIONS = 6;

  let active = files.filter((f) => {
    const age = nowT - f.mtime;
    if (f.kind === 'subagent') return age < SUBAGENT_WINDOW_MS;
    return age < ACTIVE_WINDOW_MS;
  });
  if (active.length === 0) active = [files[0]]; // fall back to most-recent so the UI has something
  active = active.slice(0, MAX_SESSIONS);

  const sessions = [];
  const win5ms = 5 * 60 * 1000;
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  for (const f of active) {
    const turns = parseLastTurns(f.path, 30);
    if (!turns.length) continue;
    const newest = turns[turns.length - 1];
    const w5 = turns.filter((t) => nowT - new Date(t.ts).getTime() <= win5ms);
    sessions.push({
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      project: newest.project,
      branch: newest.branch,
      model: newest.model,
      modelDisplay: newest.modelDisplay,
      last: newest.ts,
      kind: f.kind,            // 'main' or 'subagent'
      source: 'claude',
      filePath: f.path,
      fileMtime: new Date(f.mtime).toISOString(),
      ageMs: nowT - new Date(newest.ts).getTime(),
      turnCount: turns.length,
      turns: turns.slice().reverse(),   // newest first
      last5: {
        turns: w5.length,
        tools: new Set(w5.map((t) => t.tool).filter(Boolean)).size,
        tokens: sum(w5, (t) => t.totalTokens),
        cost: sum(w5, (t) => t.cost),
      },
    });
  }
  if (!sessions.length) return null;
  return {
    sessions,
    activeFiles: files
      .filter((f) => nowT - f.mtime < 120000)
      .slice(0, 10)
      .map((f) => ({
        path: f.path,
        mtime: new Date(f.mtime).toISOString(),
        kind: f.kind,
        source: 'claude',
        ageMs: nowT - f.mtime,
      })),
  };
}

function readCodexLive(nowT) {
  const files = findCodexSessionFiles();
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
  // Codex rollouts can be multi-MB; only parse genuinely-active files so live
  // polling stays cheap when Codex isn't running (no stale fallback).
  const active = files.filter((f) => nowT - f.mtime < ACTIVE_WINDOW_MS).slice(0, 6);
  if (!active.length) return null;

  const win5ms = 5 * 60 * 1000;
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
  const sessions = [];

  for (const f of active) {
    const s = parseCodexRollout(f.path);
    if (!s || !s.turns.length) continue;
    const turns = s.turns.slice(-30).map((t) => {
      const model = t.model || s.model;
      const tok = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation };
      return {
        ts: t.ts,
        sessionId: s.sessionId,
        project: s.project,
        cwd: s.cwd,
        branch: s.branch,
        model,
        modelDisplay: prettyModel(model),
        tool: '',
        ...tok,
        totalTokens: tok.input + tok.output + tok.cacheRead + tok.cacheCreation,
        cost: costOf(model, tok),
      };
    });
    const newest = turns[turns.length - 1];
    const w5 = turns.filter((t) => nowT - new Date(t.ts).getTime() <= win5ms);
    sessions.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      project: s.project,
      branch: s.branch,
      model: newest.model,
      modelDisplay: newest.modelDisplay,
      last: newest.ts,
      kind: 'main',
      source: 'codex',
      filePath: f.path,
      fileMtime: new Date(f.mtime).toISOString(),
      ageMs: nowT - new Date(newest.ts).getTime(),
      turnCount: turns.length,
      turns: turns.slice().reverse(),
      last5: {
        turns: w5.length,
        tools: 0,
        tokens: sum(w5, (t) => t.totalTokens),
        cost: sum(w5, (t) => t.cost),
      },
    });
  }
  if (!sessions.length) return null;
  return {
    sessions,
    activeFiles: active.slice(0, 10).map((f) => ({
      path: f.path,
      mtime: new Date(f.mtime).toISOString(),
      kind: 'main',
      source: 'codex',
      ageMs: nowT - f.mtime,
    })),
  };
}

module.exports = {
  buildStats,
  buildSessionDetail,
  readLiveFromJSONL,
  detectSources,
  priceFor,
  costOf,
  prettyModel,
  PRICING,
  DB_PATH,
  CODEX_SESSIONS_DIR,
  RANGES,
  // exported for the test suite (and any downstream tooling)
  deriveProject,
  classifyHealth,
  parseCodexRollout,
  findCodexSessionFiles,
};
