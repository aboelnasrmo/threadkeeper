#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, loadConfig, logError } from './config.mjs';
import { openDb, projectFor, insertMemory, filesOf, resolveTodos, MEMORY_TYPES, relPath, markSuperseded, RANK, settleConflict, searchPrompts } from './db.mjs';
import { redact, clip } from './redact.mjs';

const KINDS = MEMORY_TYPES.filter((t) => t !== 'session' && t !== 'brief');

const TOOLS = [
  {
    name: 'search',
    description:
      'Search your memory of past Claude Code sessions in this project: decisions, bug fixes, gotchas, how things work, todos, session summaries. ' +
      'Use it before re-investigating something that may have been solved before. Returns a compact list with ids; then call `get` for full notes ' +
      'or `timeline` for what happened around one. Pass all_projects=true to search every project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "login validation regex". Empty = most recent.' },
        project: { type: 'string', description: 'Project folder name or path (e.g. "my-app"). Optional inside Claude Code; use it from Claude Desktop.' },
        type: { type: 'string', enum: MEMORY_TYPES },
        file: { type: 'string', description: 'Only notes about this file path' },
        all_projects: { type: 'boolean', default: false },
        include_done: { type: 'boolean', default: false, description: 'Include finished todos' },
        include_outdated: { type: 'boolean', default: false, description: 'Include notes marked outdated (replaced by newer ones)' },
        limit: { type: 'number', default: 15 },
      },
    },
  },
  {
    name: 'get',
    description: 'Full text of memories by id. Batch several ids in one call.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
  },
  {
    name: 'timeline',
    description: 'Notes recorded just before and after a given memory in the same project, oldest first, to see the surrounding story.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, before: { type: 'number', default: 5 }, after: { type: 'number', default: 5 } },
      required: ['id'],
    },
  },
  {
    name: 'remember',
    description:
      'Save a note for future sessions in this project right now. Use when the user says "remember …", or for a hard-won fact, ' +
      'decision or gotcha that must not be lost. Use type "todo" for unfinished work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        project: { type: 'string', description: 'Project folder name or path (e.g. "my-app"). Optional inside Claude Code; use it from Claude Desktop.' },
        pin: { type: 'boolean', default: false, description: 'Always load this note at session start (for rules and key facts).' },
        everywhere: { type: 'boolean', default: false, description: 'A personal preference for how to work (not about this project): save it for ALL projects; implies pin.' },
        type: { type: 'string', enum: KINDS, default: 'note' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'brief',
    description:
      'The project brief: one up-to-date page on what the project is, its architecture, current state, decisions in force, traps, ' +
      'open threads and how to work in it. Read it first when starting work in a project from Claude Desktop. refresh=true rebuilds it now (slow).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project folder name or path (e.g. "my-app"). Optional inside Claude Code.' },
        refresh: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'mark_outdated',
    description:
      'Mark notes as outdated when you find they are wrong or replaced (a setting changed, a bug had a different cause). They stay in history ' +
      'but stop being recalled. Save the corrected fact with `remember` first, and pass its id as replaced_by.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } }, replaced_by: { type: 'number' } },
      required: ['ids'],
    },
  },
  {
    name: 'settle_conflict',
    description:
      'Settle two notes that disagree (listed at session start under "Notes that disagree"). Ask the user which is right first, ' +
      'unless the code already shows it. keep: "new" retires the older note, "old" retires the newer one, "both" if they do not really clash.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'conflict id' }, keep: { type: 'string', enum: ['old', 'new', 'both'] } }, required: ['id', 'keep'] },
  },
  {
    name: 'my_prompts',
    description:
      'Search what the user themselves asked or said in past sessions ("what did I say about X last week"), newest first, with dates. ' +
      'Covers roughly the last 60 days of activity; for older work use `search` on the notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words that must all appear in the prompt' },
        days: { type: 'number', description: 'How far back (default 60)' },
        all_projects: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  {
    name: 'resolve_todo',
    description: 'Mark remembered todos as done (by id) once the work is finished.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
  },
  {
    name: 'todos',
    description: 'Open todos (unfinished work) for a project, or for every project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project folder name or path (e.g. "my-app"). Optional inside Claude Code; use it from Claude Desktop.' }, } },
  },
  {
    name: 'projects',
    description: 'List the projects threadkeeper has memory for, with note counts and last activity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_chat',
    description:
      'Claude Desktop: save what this chat produced so future sessions (Claude Code and Desktop, on every machine) know it. ' +
      'Call once near the end of a chat with real work: decisions, findings, fixes, plans. Not for small talk.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project folder name (e.g. "my-app"), or omit for general notes.' },
        summary: { type: 'string', description: '2-4 sentences: what was asked, what was decided or done, what is still open.' },
        notes: {
          type: 'array',
          description: 'Up to 6 facts worth keeping on their own.',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: KINDS }, title: { type: 'string' }, body: { type: 'string' } },
            required: ['title', 'body'],
          },
        },
      },
      required: ['summary'],
    },
  },
];

const DESKTOP = process.env.THREADKEEPER_CLIENT === 'desktop';

/** Turn a folder name or path into the stored project key (most recently active match wins). */
export function resolveProject(name) {
  if (!name) return null;
  const d = openDb();
  const rows = d.prepare(
    `SELECT project, max(at) at FROM (SELECT project, created_at at FROM memories UNION ALL SELECT project, last_activity FROM sessions)
     GROUP BY project ORDER BY at DESC`
  ).all();
  const n = String(name).trim().replace(/[\\/]+$/, '');
  const base = (p) => p.replace(/^(claude-mem|sync):/, '').split(/[\\/]/).pop().toLowerCase();
  return rows.find((r) => r.project === n)?.project || rows.find((r) => base(r.project) === base(n))?.project || null;
}

export function projects() {
  const rows = openDb().prepare(
    `SELECT project, count(*) n, max(created_at) last, sum(type = 'todo' AND status = 'open') todos FROM memories GROUP BY project ORDER BY last DESC`
  ).all();
  return rows.length ? rows.map((r) => `${path.basename(r.project.replace(/^(claude-mem|sync):/, ''))}: ${r.n} notes, ${r.todos} open todos, last ${r.last.slice(0, 10)} (${r.project})`).join('\n') : 'No memory yet.';
}

export function todos(project) {
  const rows = openDb().prepare(
    `SELECT * FROM memories WHERE type = 'todo' AND status = 'open' ${project ? 'AND project = ?' : ''} ORDER BY id DESC LIMIT 50`
  ).all(...(project ? [project] : []));
  return rows.length ? rows.map((r) => `${line(r, !project)}\n   ${clip(r.body, 300)}`).join('\n') : 'No open todos.';
}

/** Turn free text into a safe FTS5 query: each word quoted, OR-ed, prefix-matched. */
export function ftsQuery(q, max = 12) {
  const words = [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])];
  return words.slice(0, max).map((w) => `"${w}"*`).join(' OR ');
}

let summarizeMod = null;

const line = (r, showProject) =>
  `#${r.id} ${r.created_at.slice(0, 10)} [${r.type}${r.status === 'done' ? ', done' : ''}${r.superseded_at ? ', OUTDATED' : ''}${r.stale_at && !r.superseded_at ? ', files changed since' : ''}] ${r.title}${showProject ? ` (${path.basename(r.project)})` : ''}`;

/** Related search words from the summary model, for when a search finds little. Cached per query. */
export function expandQuery(query, cfg = loadConfig()) {
  const d = openDb();
  const key = 'qx:' + String(query).toLowerCase().trim().slice(0, 200);
  const cached = d.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value;
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const failedAt = d.prepare("SELECT value FROM sync_state WHERE key = 'qx-failed'").get()?.value;
  if (failedAt && Date.now() - Date.parse(failedAt) < 3600_000) return [];
  let words = [];
  try {
    const { callClaude } = summarizeMod;
    const text = callClaude(
      `A developer searches their notes with: "${String(query).slice(0, 300)}".\n` +
      'List up to 12 other single words or short technical terms the notes might use instead (synonyms, related tools, ' +
      'abbreviations, the underlying technology). Reply with ONLY a JSON array of strings.', cfg, { timeout: 30_000 });
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    words = (Array.isArray(arr) ? arr : []).filter((w) => typeof w === 'string' && w.length < 40).slice(0, 12);
  } catch (e) {
    d.prepare("INSERT INTO sync_state(key, value) VALUES ('qx-failed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
    if (e.code !== 'ENOENT') logError('expand query', e);
    return [];
  }
  d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(words));
  return words;
}
export async function loadHelpers() { summarizeMod = summarizeMod || (await import('./summarize.mjs')); }

export function search({ query = '', type, file, all_projects = false, include_done = false, include_outdated = false, limit = 15 }, project, { smart = true } = {}) {
  const d = openDb();
  limit = Math.max(1, Math.min(50, Number(limit) || 15));
  const where = [];
  const args = [];
  if (!all_projects) { where.push('m.project = ?'); args.push(project); }
  if (type) { where.push('m.type = ?'); args.push(type); }
  if (!include_done) where.push("(m.status IS NULL OR m.status != 'done')");
  if (!include_outdated) where.push('m.superseded_at IS NULL');
  if (file) {
    where.push('m.id IN (SELECT memory_id FROM memory_files WHERE path = ? OR path LIKE ?)');
    const rel = relPath(project, file);
    args.push(rel, '%' + path.basename(rel));
  }
  const fq = ftsQuery(query);
  const run = (fq) => fq
    ? d.prepare(
        `SELECT m.*, snippet(memories_fts, 1, '', '', '…', 14) snip
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
         ORDER BY ${RANK} LIMIT ?`
      ).all(fq, ...args, limit)
    : d.prepare(
        `SELECT m.*, substr(m.body, 1, 110) snip FROM memories m
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ?`
      ).all(...args, limit);
  let rows = run(fq);
  let extra = '';
  // Few hits: the notes may use other words ("database" vs "PostgreSQL"). Ask the model for related terms once.
  const cfg = loadConfig();
  if (fq && smart && cfg.smartSearch && rows.length === 0 && summarizeMod) {
    const more = expandQuery(query, cfg);
    if (more.length) {
      const seen = new Set(rows.map((r) => r.id));
      const added = run(ftsQuery(query + ' ' + more.join(' '), 36)).filter((r) => !seen.has(r.id));
      rows = [...rows, ...added].slice(0, limit);
      if (added.length) extra = `(few exact matches, so also searched: ${more.join(', ')})\n`;
    }
  }
  if (!rows.length) return 'No memories found.';
  return extra + rows.map((r) => `${line(r, all_projects)}\n   ${r.snip}`).join('\n');
}

const full = (d, r) => {
  const files = filesOf(d, r.id);
  const old = r.superseded_at ? `\nOUTDATED since ${r.superseded_at.slice(0, 10)}${r.superseded_by ? ` (replaced by ${replacedBy(d, r.superseded_by)})` : ''}: do not rely on it.` : '';
  return `${line(r, true)}\nproject: ${r.project}${files.length ? `\nfiles: ${files.join(', ')}` : ''}${old}\n${r.body}`;
};

function replacedBy(d, by) {
  const m = d.prepare('SELECT id, title FROM memories WHERE uid = ?').get(by);
  return m ? `#${m.id} ${m.title}` : by;
}

export function markOutdated({ ids = [], replaced_by }, project) {
  const d = openDb();
  const by = replaced_by ? d.prepare('SELECT uid FROM memories WHERE id = ?').get(Number(replaced_by))?.uid : null;
  const n = markSuperseded(d, project || null, (Array.isArray(ids) ? ids : [ids]).map(Number), by || 'marked by Claude');
  return n ? `Marked ${n} note(s) outdated.` : 'No matching current notes.';
}

export async function briefTool({ refresh = false }, project) {
  if (!project) return `Which project? Pass project. Known projects:\n${projects()}`;
  const { currentBrief, refreshBrief } = await import('./brief.mjs');
  if (refresh) { const b = await refreshBrief(project); if (b) return b; }
  const b = currentBrief(openDb(), project);
  return b ? `Project brief (updated ${String(b.updated_at || b.created_at).slice(0, 10)}):\n${b.body}` : 'No brief yet for this project. Call brief with refresh=true to write one.';
}

export function get({ ids = [] }) {
  const d = openDb();
  ids = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite).slice(0, 30);
  if (!ids.length) return 'No ids given.';
  const rows = d.prepare(`SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  if (!rows.length) return 'No memories with those ids.';
  return rows.map((r) => full(d, r)).join('\n\n');
}

export function timeline({ id, before = 5, after = 5 }) {
  const d = openDb();
  const m = d.prepare('SELECT * FROM memories WHERE id = ?').get(Number(id));
  if (!m) return 'No memory with that id.';
  const b = Math.min(20, Math.max(0, Number(before) || 5));
  const a = Math.min(20, Math.max(0, Number(after) || 5));
  const prev = d.prepare('SELECT * FROM memories WHERE project = ? AND id < ? ORDER BY id DESC LIMIT ?').all(m.project, m.id, b).reverse();
  const next = d.prepare('SELECT * FROM memories WHERE project = ? AND id > ? ORDER BY id LIMIT ?').all(m.project, m.id, a);
  return [...prev, m, ...next]
    .map((r) => `${r.id === m.id ? '▶ ' : '  '}${line(r)}\n     ${clip(r.body, r.id === m.id ? 1200 : 220)}`)
    .join('\n');
}

export function remember({ title, body, type = 'note', files = [], pin = false, everywhere = false }, project) {
  if (!title || !body) return 'title and body are required.';
  if (everywhere) { project = 'general'; pin = true; }
  const d = openDb();
  const { id, duplicate } = insertMemory(d, {
    project,
    type: KINDS.includes(type) ? type : 'note',
    title: clip(redact(title), 160),
    body: clip(redact(body), 2000),
    files: Array.isArray(files) ? files : [],
    source: 'manual',
    pinned: pin,
  });
  return duplicate ? `Already remembered as #${id} (updated).` : `Saved as #${id}.`;
}

export function saveChat({ summary, notes = [] }, project) {
  if (!summary || !String(summary).trim()) return 'summary is required.';
  const d = openDb();
  const ids = [];
  d.exec('BEGIN IMMEDIATE');
  try {
    ids.push(insertMemory(d, { project, type: 'session', title: clip(redact('Claude Desktop chat: ' + String(summary).split(/(?<=[.!?])\s/)[0]), 160), body: clip(redact(summary), 2000), source: 'desktop' }).id);
    for (const n of (Array.isArray(notes) ? notes : []).slice(0, 6)) {
      if (!n?.title || !n?.body) continue;
      ids.push(insertMemory(d, { project, type: KINDS.includes(n.type) ? n.type : 'note', title: clip(redact(n.title), 160), body: clip(redact(n.body), 2000), source: 'desktop' }).id);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  const cfg = loadConfig();
  if (cfg.syncDir) import('./sync.mjs').then((m) => m.runSync(cfg, { force: true })).catch(() => {});
  return `Saved ${ids.length} note(s) to ${project === 'general' ? 'general notes' : path.basename(project)}: ${ids.map((i) => '#' + i).join(', ')}.`;
}

export function resolveTodo({ ids = [] }, project) {
  const n = resolveTodos(openDb(), project, (Array.isArray(ids) ? ids : [ids]).map(Number));
  return n ? `Marked ${n} todo(s) done.` : 'No matching open todos in this project.';
}

function resolveTodoAny({ ids = [] }) {
  const d = openDb();
  let n = 0;
  for (const id of (Array.isArray(ids) ? ids : [ids]).map(Number)) {
    const row = d.prepare('SELECT project FROM memories WHERE id = ?').get(id);
    if (row) n += resolveTodos(d, row.project, [id]);
  }
  return n ? `Marked ${n} todo(s) done.` : 'No matching open todos.';
}

export async function callTool(name, args, sessionProject) {
  // Inside Claude Code the project comes from the folder; from Claude Desktop it comes from the `project` argument.
  let project = sessionProject;
  if (args.project) {
    project = resolveProject(args.project);
    if (!project && name !== 'remember' && name !== 'save_chat') return `No project matching "${args.project}". Known projects:\n${projects()}`;
    if (!project) project = 'sync:' + String(args.project).split(/[\\/]/).pop();
  } else if (DESKTOP) {
    project = null;
  }
  switch (name) {
    case 'projects': return projects();
    case 'todos': return todos(project);
    case 'search': return search({ ...args, all_projects: args.all_projects || !project }, project);
    case 'get': return get(args);
    case 'timeline': return timeline(args);
    case 'remember': return remember(args, project || 'general');
    case 'save_chat': return saveChat(args, project || 'general');
    case 'resolve_todo': return project ? resolveTodo(args, project) : resolveTodoAny(args);
    case 'mark_outdated': return markOutdated(args, project);
    case 'settle_conflict': return settleConflict(openDb(), args.id, args.keep) ? `Settled: kept ${args.keep === 'both' ? 'both notes' : 'the ' + args.keep + ' note'}.` : 'No open conflict with that id.';
    case 'my_prompts': {
      const rows = searchPrompts(openDb(), { query: args.query, days: args.days, project: args.all_projects || !project ? null : project });
      if (!rows.length) return 'None of your prompts in that period contain all those words.';
      return rows.map((r) => `${r.ts.slice(0, 16).replace('T', ' ')}${args.all_projects || !project ? ` (${path.basename(r.project)})` : ''}: ${clip(r.detail.replace(/\s+/g, ' '), 300)}`).join('\n');
    }
    case 'brief': return briefTool(args, project);
    default: return null;
  }
}

export function serve() {
  const project = DESKTOP ? null : projectFor(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (l) => {
    let msg;
    try { msg = JSON.parse(l); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'threadkeeper', version: VERSION },
          instructions: DESKTOP
            ? 'The user\'s personal memory of past work, shared with their Claude Code sessions on every machine. When the chat is about one of their ' +
              'projects (the projects tool lists them), read its brief first and search before re-investigating old problems. ' +
              'Near the end of a chat that produced decisions, findings, fixes or plans, call save_chat once so the work is not lost; ' +
              'use remember right away for anything the user asks to remember.'
            : 'Personal memory of past sessions. Search it before re-investigating old problems; use remember for facts worth keeping.',
        });
      } else if (method === 'tools/list') {
        reply({ tools: TOOLS });
      } else if (method === 'tools/call') {
        await loadHelpers();
        const text = await callTool(params?.name, params?.arguments || {}, project);
        if (text === null) return fail(-32602, `unknown tool ${params?.name}`);
        reply({ content: [{ type: 'text', text }] });
      } else if (method === 'ping') {
        reply({});
      } else if (id !== undefined && !String(method).startsWith('notifications/')) {
        fail(-32601, `method not found: ${method}`);
      }
    } catch (e) {
      if (id !== undefined) reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
    }
  });
}


const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) serve();
