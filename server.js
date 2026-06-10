#!/usr/bin/env node
'use strict';

/* ============================================================================
 * Tokrax · server.js — local HTTP server
 * ----------------------------------------------------------------------------
 * ✦  Customized by ShaonPro · https://github.com/ShaonPro
 *     Pro-grade plug-and-play: `npx github:ShaonPro/Tokrax`
 * ==========================================================================*/

/**
 * Serves the dashboard UI and a JSON stats API. Binds to 127.0.0.1 only —
 * your usage data never leaves the machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { buildStats, buildSessionDetail, readLiveFromJSONL, detectSources, DB_PATH } = require('./stats');

// Default port 47776 — ends in 776 = "PRO" on a phone keypad (a small ShaonPro
// signature). High range keeps it clear of common dev ports; override with PORT.
const PORT = parseInt(process.env.PORT || '47776', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HTML_FILE = path.join(__dirname, 'dashboard.html');
let activePort = PORT;
let killedStale = false; // re-entrancy guard so we only attempt the kill-and-retake once

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type }, extra || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch (_) {
    return send(res, 400, 'text/plain', 'Bad request');
  }

  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      // never cache the dashboard HTML — otherwise every fix we ship lands
      // behind a stale tab the user has to remember to hard-reload.
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(HTML_FILE), {
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
    }

    if (u.pathname === '/api/sources') {
      // which AI tools are present on this machine (drives the UI switcher)
      return send(res, 200, 'application/json', JSON.stringify({ sources: detectSources() }), {
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/api/stats') {
      const data = buildStats({
        source: u.searchParams.get('source') || 'claude',
        project: u.searchParams.get('project') || 'all',
        range: u.searchParams.get('range') || 'all',
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
      });
      return send(res, 200, 'application/json', JSON.stringify(data), {
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/session/'.length));
      // session_id is a UUID-shaped value; reject anything with path chars
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'bad session id' }));
      }
      const detail = buildSessionDetail(id);
      if (!detail) {
        return send(res, 404, 'application/json', JSON.stringify({ error: 'session not found' }));
      }
      return send(res, 200, 'application/json', JSON.stringify(detail), {
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/html2canvas.min.js') {
      const file = path.join(__dirname, 'html2canvas.min.js');
      if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'Not found');
      return send(res, 200, 'application/javascript; charset=utf-8', fs.readFileSync(file), {
        'Cache-Control': 'public, max-age=86400, immutable',
      });
    }

    if (u.pathname === '/api/live') {
      // genuine real-time data — reads the latest JSONL tail bypassing usage.db
      const data = readLiveFromJSONL(u.searchParams.get('source') || 'claude');
      return send(
        res,
        200,
        'application/json',
        JSON.stringify(data || { empty: true }),
        { 'Cache-Control': 'no-store' }
      );
    }

    if (u.pathname === '/api/health') {
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({ ok: true, db: DB_PATH })
      );
    }

    if (u.pathname === '/favicon.ico') {
      return send(res, 204, 'text/plain', '');
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    const isNoDb = err && err.code === 'NO_DB';
    send(
      res,
      isNoDb ? 503 : 500,
      'application/json',
      JSON.stringify({
        error: isNoDb ? err.message : String((err && err.stack) || err),
        code: (err && err.code) || 'ERROR',
      })
    );
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  // execFile (no shell) — avoids any shell interpolation from env-derived host/port.
  try {
    if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch (_) {
    /* ignore — headless / SSH / no GUI is fine */
  }
}

// Find the PIDs of any process bound to a TCP port on this machine.
// Cross-platform: lsof on macOS/Linux, netstat+tasklist on Windows.
function pidsOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // " TCP  127.0.0.1:47776  0.0.0.0:0  LISTENING  12345"
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && parseInt(m[1], 10) === port) pids.add(parseInt(m[2], 10));
      }
      return [...pids];
    }
    // macOS / Linux
    const out = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).map((s) => parseInt(s, 10)).filter(Number.isFinite);
  } catch (_) {
    return [];
  }
}

// Is this PID a previous Tokrax dashboard server? Only kill if so — never
// stomp on something unrelated that happens to hold the port.
function looksLikeTokraxServer(pid) {
  try {
    if (process.platform === 'win32') {
      // wmic is slated for removal but still works in modern Windows; fall back
      // to tasklist for the process name (we can't easily get cmdline without wmic).
      try {
        const out = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'], { encoding: 'utf8' });
        return /\bnode(\.exe)?\b/i.test(out) && /server\.js/i.test(out);
      } catch (_) {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        return /\bnode\.exe\b/i.test(out);
      }
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return /\bnode\b/.test(out) && /server\.js/.test(out);
  } catch (_) {
    return false;
  }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (_) {
    return false;
  }
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;

  // Default port (47776) — always reclaim it. The user wants a single, stable
  // address. If a previous Tokrax server is hogging it, kill that one and
  // take over. If something UNrelated holds it, refuse loudly with guidance.
  if (activePort === PORT && !killedStale) {
    killedStale = true;
    const owners = pidsOnPort(PORT).filter((p) => p !== process.pid);
    if (owners.length === 0) {
      // Port appears free now — try again after a short delay (kernel TIME_WAIT etc.)
      setTimeout(() => server.listen(PORT, HOST), 300);
      return;
    }
    const tokraxOwners = owners.filter(looksLikeTokraxServer);
    const otherOwners = owners.filter((p) => !tokraxOwners.includes(p));

    if (otherOwners.length) {
      console.error(
        `\n  Port ${PORT} is held by a non-Tokrax process (pid ${otherOwners.join(', ')}).\n` +
          `  Not killing it — that would be impolite. Free the port yourself, or:\n` +
          `      PORT=47777 node server.js\n`
      );
      process.exit(1);
    }

    process.stderr.write(
      `  Port ${PORT} held by a stale Tokrax (pid ${tokraxOwners.join(', ')}). Killing and reclaiming…\n`
    );
    tokraxOwners.forEach(killPid);
    setTimeout(() => server.listen(PORT, HOST), 400);
    return;
  }

  // Non-default port the user explicitly chose — don't auto-kill anything.
  console.error(
    `\n  Port ${activePort} is in use.\n` +
      `  Pick another:  PORT=47777 node server.js\n`
  );
  process.exit(1);
});

server.on('listening', () => {
  const url = `http://${HOST}:${activePort}`;
  console.log(
    [
      '',
      '  \x1b[38;5;209m✦\x1b[0m  \x1b[1mTokrax\x1b[0m  \x1b[38;5;245mlocal AI usage dashboard\x1b[0m',
      '',
      `     Dashboard   \x1b[38;5;209m${url}\x1b[0m`,
      `     Data        \x1b[38;5;245m${DB_PATH}\x1b[0m`,
      '     Stop        \x1b[38;5;245mCtrl+C\x1b[0m',
      '',
    ].join('\n')
  );
  openBrowser(url);
});

server.listen(activePort, HOST);
