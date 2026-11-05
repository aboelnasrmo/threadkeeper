#!/usr/bin/env node
// Local web viewer: http://localhost:37777 (127.0.0.1 only). Starts by itself with Claude Code (autoViewer).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, loadConfig, VERSION } from './config.mjs';
import { openDb, filesOf, resolveTodos, updateMemory, MEMORY_TYPES, markSuperseded, usageSummary, usageByProject, RANK, openConflicts, settleConflict, searchPrompts } from './db.mjs';
import { healthProblems } from './health.mjs';
import { ftsQuery, expandQuery, loadHelpers } from './mcp.mjs';
import { spawnSummarizer } from './hook.mjs';

const PORT = Number(process.env.THREADKEEPER_PORT) || 37777;
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.html');
const MAX_BODY = 64 * 1024;

const withFiles = (d, rows) => rows.map((m) => ({ ...m, files: filesOf(d, m.id) }));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function notesQuery(d, { project, type, q, includeDone, includeOld, pinned, stale, offset = 0, limit = 50, also = [] }) {
  // Each condition carries its own args so the type filter can be dropped for the chip counts.
  const fq = q ? ftsQuery(also.length ? q + ' ' + also.join(' ') : q, also.length ? 36 : undefined) : '';
  const conds = [];
  if (fq) conds.push(['memories_fts MATCH ?', [fq]]);
  if (project) conds.push(['m.project = ?', [project]]);
  if (pinned) conds.push(['m.pinned = 1', []]);
  if (stale) conds.push(['m.stale_at IS NOT NULL', []]);
  if (!includeDone) conds.push(["(m.status IS NULL OR m.status != 'done')", []]);
  if (!includeOld) conds.push(['m.superseded_at IS NULL', []]);
  const typeCond = type ? ['m.type = ?', [type]] : null;
  const build = (cs) => [cs.length ? 'WHERE ' + cs.map((c) => c[0]).join(' AND ') : '', cs.flatMap((c) => c[1])];
  const from = fq ? 'memories_fts JOIN memories m ON m.id = memories_fts.rowid' : 'memories m';
  const [w, args] = build(typeCond ? [...conds, typeCond] : conds);
  const order = fq ? `ORDER BY ${RANK}` : "ORDER BY (m.type = 'brief') DESC, m.pinned DESC, m.created_at DESC, m.id DESC";
  const total = d.prepare(`SELECT count(*) n FROM ${from} ${w}`).get(...args).n;
  const items = d.prepare(`SELECT m.* FROM ${from} ${w} ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const [tw, targs] = build(conds);
  const typeCounts = Object.fromEntries(
    d.prepare(`SELECT m.type, count(*) n FROM ${from} ${tw} GROUP BY m.type`).all(...targs).map((r) => [r.type, r.n])
  );
  return { total, typeCounts, items: withFiles(d, items) };
}

const TYPE_TITLES = { decision: 'Decisions', gotcha: 'Gotchas', bugfix: 'Bug fixes', feature: 'Features', refactor: 'Refactors', discovery: 'Discoveries', todo: 'Todos', note: 'Notes', session: 'Sessions' };
/** One readable Markdown file with a project's live notes: brief first, then one section per kind. */
export function exportMarkdown(project, rows) {
  const out = [`# ${path.basename(project)}: memory`, '', `Exported ${new Date().toISOString().slice(0, 10)} · ${rows.length} notes`, ''];
  const brief = rows.find((m) => m.type === 'brief');
  if (brief) out.push('## Project brief', '', brief.body.replace(/^#+ /gm, '### '), '');
  const by = {};
  for (const m of rows) if (m.type !== 'brief') (by[m.type] ||= []).push(m);
  for (const t of Object.keys(TYPE_TITLES)) {
    if (!by[t]) continue;
    out.push(`## ${TYPE_TITLES[t]}`, '');
    for (const m of by[t]) {
      out.push(`### ${m.title}`, `_${m.created_at.slice(0, 10)} · #${m.id}${m.pinned ? ' · pinned' : ''}${m.status ? ' · ' + m.status : ''}_`, '', m.body);
      if (m.files?.length) out.push('', 'Files: ' + m.files.map((f) => '`' + f + '`').join(', '));
      out.push('');
    }
  }
  return out.join('\n');
}

async function api(url, method, req) {
  const d = openDb();
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k);
  let m;

  // Writes need a custom header, which browsers won't send cross-site without a CORS preflight we never allow.
  if (method === 'POST' && req.headers['x-threadkeeper'] !== '1') return [403, { error: 'forbidden' }];

  if (method === 'GET' && p === '/api/version') return [200, { version: VERSION }];
  // A newer threadkeeper asks an older running viewer to step aside so it can start the current code.
  if (method === 'POST' && p === '/api/restart') {
    setTimeout(() => process.exit(0), 50);
    return [200, { ok: true }];
  }

  if (method === 'POST' && p === '/api/pause') {
    const priv = await import('./privacy.mjs');
    const body = await readJson(req);
    if (body.resume) priv.resume(d); else priv.pause(Number(body.hours) || 0, d);
    return [200, { paused: priv.pausedUntil(d) }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w.-]+)\/private$/))) {
    (await import('./privacy.mjs')).makePrivate(m[1], d);
    return [200, { ok: true }];
  }

  if (method === 'GET' && p === '/api/week') return [200, (await import('./week.mjs')).weekReport(Number(q('days')) || 7)];

  // Dashboard numbers for the home panel (only fetched while it is showing).
  if (method === 'GET' && p === '/api/home') {
    const project = q('project') || null;
    const days = 30;
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const pw = project ? 'AND project = ?' : '';
    const pa = project ? [project] : [];
    const perDay = (sql) => Object.fromEntries(d.prepare(sql).all(since, ...pa).map((r) => [r.day, r.n]));
    const notes = perDay(`SELECT substr(created_at, 1, 10) day, count(*) n FROM memories WHERE created_at >= ? AND type != 'brief' ${pw} GROUP BY day`);
    const sessions = perDay(`SELECT substr(started_at, 1, 10) day, count(*) n FROM sessions WHERE started_at >= ? AND prompts + tool_calls > 0 ${pw} GROUP BY day`);
    const activity = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      activity.push({ day, notes: notes[day] || 0, sessions: sessions[day] || 0 });
    }
    const where = project ? 'WHERE project = ?' : '';
    return [200, {
      activity,
      types: d.prepare(`SELECT type, count(*) n FROM memories ${where} ${where ? 'AND' : 'WHERE'} superseded_at IS NULL GROUP BY type ORDER BY n DESC`).all(...pa),
      brief: project ? d.prepare("SELECT id, body, created_at FROM memories WHERE project = ? AND type = 'brief' ORDER BY id DESC LIMIT 1").get(project) || null : null,
      recent: withFiles(d, d.prepare(`SELECT * FROM memories ${where} ${where ? 'AND' : 'WHERE'} type NOT IN ('brief', 'session') AND superseded_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 6`).all(...pa)),
      todos: d.prepare(`SELECT id, title, created_at FROM memories ${where} ${where ? 'AND' : 'WHERE'} type = 'todo' AND status = 'open' AND superseded_at IS NULL ORDER BY id DESC LIMIT 6`).all(...pa),
      usage: usageSummary(7, project),
      recall: (await import('./learn.mjs')).recallStats(project, d),
      conflicts: openConflicts(d, project, 10),
      tokens: project ? (await import('./tokens.mjs')).tokenReport(project, 14, d) : null,
      usageByProject: project ? [] : usageByProject(7),
      stale: d.prepare(`SELECT count(*) n FROM memories ${where} ${where ? 'AND' : 'WHERE'} stale_at IS NOT NULL AND superseded_at IS NULL`).get(...pa).n,
    }];
  }

  if (method === 'GET' && p === '/api/overview') {
    const n = (sql) => d.prepare(sql).get().n;
    return [200, {
      home: HOME,
      config: loadConfig(),
      types: MEMORY_TYPES,
      counts: {
        sessions: n('SELECT count(*) n FROM sessions WHERE prompts + tool_calls > 0'),
        memories: n('SELECT count(*) n FROM memories'),
        events: n('SELECT count(*) n FROM events'),
        pending: n('SELECT count(*) n FROM sessions WHERE summarized = 0 AND ended_at IS NOT NULL'),
        todos: n("SELECT count(*) n FROM memories WHERE type = 'todo' AND status = 'open'"),
        pinned: n('SELECT count(*) n FROM memories WHERE pinned = 1'),
      },
      projects: d.prepare(
        `SELECT project, sum(s) sessions, sum(mm) memories, max(last) last FROM (
           SELECT project, count(*) s, 0 mm, max(last_activity) last FROM sessions WHERE prompts + tool_calls > 0 GROUP BY project
           UNION ALL
           SELECT project, 0, count(*), max(created_at) FROM memories GROUP BY project
         ) GROUP BY project ORDER BY last DESC`
      ).all(),
      outdated: n('SELECT count(*) n FROM memories WHERE superseded_at IS NOT NULL'),
      paused: (await import('./privacy.mjs')).pausedUntil(d),
      health: healthProblems(loadConfig()),
      usage: usageSummary(7),
      errors: (() => {
        try { return fs.readFileSync(path.join(HOME, 'errors.log'), 'utf8').trim().split('\n').slice(-15).reverse(); }
        catch { return []; }
      })(),
    }];
  }
  if (method === 'GET' && p === '/api/sessions') {
    const project = q('project');
    // With a query: the sessions where you said those words (your own prompts), newest first.
    let match = null;
    if (q('q')) {
      match = new Map();
      for (const h of searchPrompts(d, { query: q('q'), project, days: 3650, limit: 50 })) if (!match.has(h.session_id)) match.set(h.session_id, h.detail);
      if (!match.size) return [200, []];
    }
    const rows = d.prepare(
      `SELECT s.*, (SELECT count(*) FROM memories m WHERE m.session_id = s.id) memories,
         (SELECT body FROM memories m WHERE m.session_id = s.id AND m.type = 'session' ORDER BY id DESC LIMIT 1) summary,
         (SELECT detail FROM events e WHERE e.session_id = s.id AND e.kind = 'prompt' ORDER BY id LIMIT 1) first_prompt,
         EXISTS (SELECT 1 FROM sync_state WHERE key = 'private:' || s.id) private
       FROM sessions s WHERE ((s.prompts + s.tool_calls) > 0 OR EXISTS (SELECT 1 FROM sync_state WHERE key = 'private:' || s.id)) ${project ? 'AND s.project = ?' : ''}
         ${match ? `AND s.id IN (${[...match.keys()].map(() => '?').join(',')})` : ''} ORDER BY s.last_activity DESC LIMIT 100`
    ).all(...(project ? [project] : []), ...(match ? match.keys() : []));
    return [200, match ? rows.map((r) => ({ ...r, match: match.get(r.id) })) : rows];
  }
  if (method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w.-]+)$/))) {
    const s = d.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1]);
    if (!s) return [404, { error: 'not found' }];
    return [200, {
      session: { ...s, private: !!d.prepare('SELECT 1 FROM sync_state WHERE key = ?').get('private:' + s.id) },
      memories: withFiles(d, d.prepare("SELECT * FROM memories WHERE session_id = ? ORDER BY (type = 'session') DESC, id").all(s.id)),
      events: d.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(s.id),
    }];
  }
  if (method === 'GET' && p === '/api/notes') {
    const type = q('type');
    // "Search by meaning": the summary model suggests related words once per query (cached), as the search tool does.
    let also = [];
    if (q('smart') === '1' && q('q')) { await loadHelpers(); also = expandQuery(q('q')); }
    const r = notesQuery(d, {
      also,
      project: q('project') || null,
      type: MEMORY_TYPES.includes(type) ? type : null,
      q: q('q') || '',
      includeDone: q('done') === '1',
      includeOld: q('old') === '1',
      pinned: q('pinned') === '1',
      stale: q('stale') === '1',
      offset: Math.max(0, Number(q('offset')) || 0),
      limit: Math.min(200, Math.max(1, Number(q('limit')) || 50)),
    });
    return [200, { ...r, also }];
  }
  if (method === 'POST' && p === '/api/notes/bulk') {
    const body = await readJson(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    let n = 0;
    for (const id of ids) {
      if (body.action === 'forget') n += Number(d.prepare('DELETE FROM memories WHERE id = ?').run(id).changes);
      else if (body.action === 'outdated') { markSuperseded(d, null, [id], 'marked in the viewer'); n++; }
      else if (body.action === 'pin' || body.action === 'unpin') n += updateMemory(d, id, { pinned: body.action === 'pin' }) ? 1 : 0;
      else if (body.action === 'done') n += updateMemory(d, id, { status: 'done' }) ? 1 : 0;
      else return [400, { error: 'unknown action' }];
    }
    return [200, { ok: true, changed: n }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/conflicts\/(\d+)$/))) {
    const body = await readJson(req);
    if (!['old', 'new', 'both'].includes(body.keep)) return [400, { error: 'keep must be old, new or both' }];
    return [200, { ok: settleConflict(d, Number(m[1]), body.keep) }];
  }
  if (method === 'POST' && p === '/api/share') {
    const body = await readJson(req);
    const known = d.prepare('SELECT 1 FROM sessions WHERE project = ? LIMIT 1').get(String(body.project || ''));
    if (!known || !fs.existsSync(String(body.project))) return [400, { error: 'not a project folder on this machine' }];
    return [200, (await import('./share.mjs')).share(String(body.project), { link: !!body.link })];
  }
  if (method === 'GET' && p === '/api/export') {
    const project = q('project');
    const rows = d.prepare(`SELECT * FROM memories WHERE project = ? AND superseded_at IS NULL ORDER BY type = 'brief' DESC, type, created_at DESC`).all(project || '');
    const md = exportMarkdown(project || '', withFiles(d, rows));
    return [200, md, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${path.basename(project || 'notes').replace(/[^\w.-]+/g, '-')}-memory.md"` }];
  }
  if (method === 'GET' && (m = p.match(/^\/api\/notes\/(\d+)$/))) {
    const note = d.prepare('SELECT * FROM memories WHERE id = ?').get(Number(m[1]));
    if (!note) return [404, { error: 'not found' }];
    const around = (op, dir) => d.prepare(
      `SELECT id, created_at, type, title, status FROM memories WHERE project = ? AND id ${op} ? ORDER BY id ${dir} LIMIT 4`
    ).all(note.project, note.id);
    return [200, { note: { ...note, files: filesOf(d, note.id) }, before: around('<', 'DESC').reverse(), after: around('>', 'ASC') }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/notes\/(\d+)$/))) {
    const body = await readJson(req);
    if (typeof body.outdated === 'boolean') {
      const t = new Date().toISOString();
      if (body.outdated) markSuperseded(d, null, [Number(m[1])], 'marked in the viewer');
      else d.prepare('UPDATE memories SET superseded_at = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?').run(t, Number(m[1]));
    }
    const note = updateMemory(d, Number(m[1]), body);
    return note ? [200, { note: { ...note, files: filesOf(d, note.id) } }] : [404, { error: 'not found' }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w.-]+)\/summarize$/))) {
    // Re-summarize from scratch: drop this session's automatic notes and start over.
    d.prepare("DELETE FROM memories WHERE session_id = ? AND source = 'auto' AND pinned = 0").run(m[1]);
    d.prepare('UPDATE sessions SET summarized = 0, summarize_attempts = 0, summarized_upto = 0, summarizing_since = NULL, ended_at = coalesce(ended_at, ?) WHERE id = ?')
      .run(new Date().toISOString(), m[1]);
    spawnSummarizer(m[1]);
    return [200, { ok: true }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/memories\/(\d+)\/done$/))) {
    const row = d.prepare('SELECT project FROM memories WHERE id = ?').get(Number(m[1]));
    if (row) resolveTodos(d, row.project, [Number(m[1])]);
    return [200, { ok: true }];
  }
  if (method === 'POST' && (m = p.match(/^\/api\/memories\/(\d+)\/delete$/))) {
    d.prepare('DELETE FROM memories WHERE id = ?').run(Number(m[1]));
    return [200, { ok: true }];
  }
  return [404, { error: 'not found' }];
}

export function startViewer(port = PORT, { quiet = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Only answer requests addressed to localhost (blocks DNS-rebinding tricks).
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          'x-frame-options': 'DENY',
        });
        return res.end(fs.readFileSync(PAGE));
      }
      const [code, body, headers] = await api(url, req.method, req);
      if (headers) { res.writeHead(code, { 'cache-control': 'no-store', ...headers }); return res.end(body); }
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(e.message === 'bad json' || e.message === 'body too large' ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.on('error', (e) => {
    // Already running (another session started it first): nothing to do.
    if (e.code === 'EADDRINUSE') { if (!quiet) console.log(`threadkeeper viewer is already running at http://localhost:${port}`); process.exit(0); }
    throw e;
  });
  server.listen(port, '127.0.0.1', () => { if (!quiet) console.log(`threadkeeper viewer: http://localhost:${port}  (Ctrl+C to stop)`); });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) startViewer(PORT, { quiet: process.argv.includes('--quiet') });
