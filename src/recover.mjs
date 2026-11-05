// Two things Claude Code keeps on disk that threadkeeper can learn from:
//  1. Its own memory files: ~/.claude/projects/<encoded project>/memory/*.md  → imported as notes (and synced).
//  2. Its transcripts:      ~/.claude/projects/<encoded project>/<session>.jsonl → sessions threadkeeper missed
//     (for example when the app couldn't find `node`, so no hook ran) are rebuilt and summarized.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, logError } from './config.mjs';
import { openDb, now, insertMemory, updateMemory, projectFor, EDIT_TOOLS } from './db.mjs';
import { redact, clip, isSensitivePath } from './redact.mjs';

const MAX_TRANSCRIPT = 16 * 1024 * 1024;
const MAX_EVENTS = 600;

export const claudeProjectsDir = () => process.env.THREADKEEPER_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');

/** Claude Code names a project's folder after its path with every non-alphanumeric character turned into '-'. */
export const encodeProject = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

const getState = (d, k) => d.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value ?? null;
const setState = (d, k, v) => d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

// ---------- 1. Claude Code memory files ----------

const TYPE_MAP = { feedback: 'gotcha', user: 'note', project: 'discovery', reference: 'note' };

export function parseMemoryFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: body.trim() };
}

/** Import (or update) this project's Claude Code memory files. Cheap when nothing changed. Returns count changed. */
export function importClaudeMemory(project, { dir } = {}) {
  const memDir = dir || path.join(claudeProjectsDir(), encodeProject(project), 'memory');
  let names;
  try { names = fs.readdirSync(memDir).filter((n) => n.endsWith('.md') && n.toUpperCase() !== 'MEMORY.MD'); } catch { return 0; }
  const d = openDb();
  let changed = 0;
  for (const name of names) {
    const file = path.join(memDir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size > 64 * 1024) continue;
    const seen = d.prepare('SELECT * FROM imported_files WHERE path = ?').get(file);
    if (seen && seen.mtime === st.mtimeMs) continue;
    const { meta, body } = parseMemoryFile(fs.readFileSync(file, 'utf8'));
    if (!body && !meta.description) continue;
    const type = TYPE_MAP[meta.type] || 'note';
    const title = clip(redact(meta.description || meta.name || name.replace(/\.md$/, '').replace(/[-_]+/g, ' ')), 160);
    const text = clip(redact(body || meta.description), 3000);
    d.exec('BEGIN IMMEDIATE');
    try {
      const existing = seen?.memory_uid && d.prepare('SELECT id FROM memories WHERE uid = ?').get(seen.memory_uid);
      let uid = seen?.memory_uid;
      if (existing) updateMemory(d, existing.id, { title, body: text, type });
      else {
        // Feedback is guidance Claude should always follow: pin it so every machine loads it.
        const { id } = insertMemory(d, { project, type, title, body: text, source: 'claude-memory', pinned: meta.type === 'feedback' });
        uid = d.prepare('SELECT uid FROM memories WHERE id = ?').get(id).uid;
      }
      d.prepare('INSERT INTO imported_files(path, mtime, memory_uid) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, memory_uid = excluded.memory_uid')
        .run(file, st.mtimeMs, uid);
      d.exec('COMMIT');
      changed++;
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  return changed;
}

/** The working folder a Claude Code project folder belongs to, read from its transcripts. */
export function cwdOfClaudeProject(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch {}
  for (const n of names.slice(0, 5)) {
    try {
      const fd = fs.openSync(path.join(dir, n), 'r');
      const buf = Buffer.alloc(65536);
      const len = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, len).toString('utf8'));
      if (m) return JSON.parse(`"${m[1]}"`);
    } catch {}
  }
  return null;
}

/** Every project's Claude Code memory files, on this machine. */
export function importAllClaudeMemory() {
  const root = claudeProjectsDir();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const name of dirs) {
    const memDir = path.join(root, name, 'memory');
    if (!fs.existsSync(memDir)) continue;
    const cwd = cwdOfClaudeProject(path.join(root, name));
    let project = cwd ? (fs.existsSync(cwd) ? projectFor(cwd) : cwd) : 'sync:' + name.split('-').filter(Boolean).pop();
    if (cwd && (path.resolve(cwd) === path.resolve(os.homedir()) || path.dirname(path.resolve(cwd)) === path.resolve(cwd))) project = 'general';
    out.push({ project, imported: importClaudeMemory(project, { dir: memDir }) });
  }
  return out;
}

// ---------- 2. Sessions threadkeeper missed ----------

function describe(name, input = {}, project) {
  let fp = input.file_path || input.notebook_path || input.path;
  if (fp && isSensitivePath(fp)) return `${fp} (sensitive file, content not stored)`;
  if (fp && project && fp.startsWith(project)) fp = path.relative(project, fp).split(path.sep).join('/');
  if (name === 'Bash') return clip(redact(input.command ?? ''), 300);
  if (fp) return name === 'Edit' || name === 'MultiEdit' ? `${fp}: ${clip(redact(input.new_string ?? input.edits?.[0]?.new_string ?? ''), 200)}` : fp;
  return clip(redact(JSON.stringify(input)), 200);
}

/** Read a transcript into threadkeeper events: the user's prompts and Claude's tool calls. */
export function transcriptEvents(file, project) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, MAX_TRANSCRIPT);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const events = [];
  let cwd = null;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || o.isMeta) continue;
    cwd = cwd || o.cwd || null;
    const ts = o.timestamp || now();
    const content = o.message?.content;
    if (o.type === 'user') {
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '';
      if (!text.trim() || /^\s*<(command-|local-command|system-reminder)/.test(text) || text.startsWith('Caveat:')) continue;
      events.push({ ts, kind: 'prompt', tool: null, detail: clip(redact(text), 1500) });
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use' || /^mcp__threadkeeper__/.test(c.name || '')) continue;
        events.push({ ts, kind: 'tool', tool: c.name, detail: describe(c.name, c.input || {}, project) });
      }
    }
  }
  return { events: events.slice(-MAX_EVENTS), cwd };
}

/**
 * Find transcripts of sessions in this project that threadkeeper never saw, rebuild them as sessions, and leave
 * them for the summarizer's catch-up. Only sessions after threadkeeper was first used here, unless `all`.
 */
export function findMissed(project, cfg, { all = false, olderThanMs = 10 * 60 * 1000 } = {}) {
  const d = openDb();
  let since = getState(d, 'installed_at');
  if (!since) {
    since = d.prepare('SELECT min(started_at) t FROM sessions').get().t || now();
    setState(d, 'installed_at', since);
  }
  const dir = path.join(claudeProjectsDir(), encodeProject(project));
  let files;
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const known = d.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const cutoff = all ? 0 : Date.parse(since);
  const keepDays = Number(cfg.keepActivityDays) || 0;
  const oldest = keepDays > 0 && !all ? Date.now() - keepDays * 86400000 : 0;
  const candidates = [];
  for (const n of files) {
    const id = n.slice(0, -6);
    if (known.get(id)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (st.size < 2048 || st.mtimeMs < Math.max(cutoff, oldest) || Date.now() - st.mtimeMs < olderThanMs) continue;
    candidates.push({ id, file: path.join(dir, n), mtime: st.mtimeMs });
  }
  return candidates.sort((a, b) => b.mtime - a.mtime);
}

export function recoverMissed(project, cfg, { all = false, limit = 3, olderThanMs } = {}) {
  const d = openDb();
  const recovered = [];
  for (const c of findMissed(project, cfg, { all, olderThanMs }).slice(0, limit)) {
    let parsed;
    try { parsed = transcriptEvents(c.file, project); } catch { continue; }
    const { events } = parsed;
    if (!events.some((e) => e.kind === 'prompt')) continue;
    const start = events[0].ts;
    const end = new Date(c.mtime).toISOString();
    d.exec('BEGIN IMMEDIATE');
    try {
      d.prepare(
        `INSERT OR IGNORE INTO sessions(id, project, started_at, last_activity, ended_at, transcript_path, recovered) VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).run(c.id, project, start, end, end, c.file);
      const add = d.prepare('INSERT INTO events(session_id, ts, kind, tool, detail) VALUES (?, ?, ?, ?, ?)');
      let prompts = 0, tools = 0, edits = 0;
      for (const e of events) {
        add.run(c.id, e.ts, e.kind, e.tool, e.detail);
        if (e.kind === 'prompt') prompts++;
        else { tools++; if (EDIT_TOOLS.has(e.tool)) edits++; }
      }
      d.prepare('UPDATE sessions SET prompts = ?, tool_calls = ?, edits = ? WHERE id = ?').run(prompts, tools, edits, c.id);
      d.exec('COMMIT');
      recovered.push({ id: c.id, when: end, prompts, tools });
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  return recovered;
}


// Detached worker started by the SessionStart hook: rebuild missed sessions, then summarize them.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv[2]) {
  const cfg = loadConfig();
  try {
    const rec = recoverMissed(process.argv[2], cfg);
    const { summarizeSession } = await import('./summarize.mjs');
    for (const r of rec) { try { summarizeSession(r.id, cfg); } catch (e) { logError(`recover summarize ${r.id}`, e); } }
    if (rec.length) (await import('./brief.mjs')).maybeRefreshBrief(process.argv[2], cfg).catch((e) => logError('brief', e));
  } catch (e) { logError('recover', e); }
}
