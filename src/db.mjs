import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HOME } from './config.mjs';

let db;

export const MEMORY_TYPES = ['session', 'decision', 'bugfix', 'feature', 'refactor', 'discovery', 'gotcha', 'todo', 'note', 'brief'];
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    ended_at TEXT,
    prompts INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    edits INTEGER NOT NULL DEFAULT 0,
    summarized INTEGER NOT NULL DEFAULT 0,       -- 0 pending, 1 done, -1 skipped/gave up
    summarize_attempts INTEGER NOT NULL DEFAULT 0,
    summarized_upto INTEGER NOT NULL DEFAULT 0   -- last event id covered by a summary
  );
  CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, last_activity);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,        -- prompt | tool
    tool TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_project ON memories(project, created_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, body, content='memories', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, body ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO memories_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
`;

// Each entry upgrades the schema by one version. Never edit an entry once shipped; append a new one.
const MIGRATIONS = [
  // v1 -> v2: files per memory, todo status, provenance, transcript path, summarizer lock, file-context dedupe
  `
  ALTER TABLE sessions ADD COLUMN transcript_path TEXT;
  ALTER TABLE sessions ADD COLUMN summarizing_since TEXT;
  ALTER TABLE memories ADD COLUMN status TEXT;          -- todos: open | done
  ALTER TABLE memories ADD COLUMN resolved_at TEXT;
  ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'auto';  -- auto | manual | claude-mem
  CREATE TABLE IF NOT EXISTS memory_files (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (memory_id, path)
  );
  CREATE INDEX IF NOT EXISTS memory_files_path ON memory_files(path);
  CREATE TABLE IF NOT EXISTS injected_files (
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  );
  UPDATE memories SET status = 'open' WHERE type = 'todo';
  CREATE INDEX IF NOT EXISTS memories_todo ON memories(project, type, status);
  `,
  // v2 -> v3: pinned notes (always loaded at session start), edit tracking, title key for de-duplication
  `
  ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memories ADD COLUMN updated_at TEXT;
  ALTER TABLE memories ADD COLUMN title_key TEXT;
  CREATE INDEX IF NOT EXISTS memories_title_key ON memories(project, title_key);
  `,
  // v3 -> v4: sync between machines (stable ids, deletion tombstones, sync bookkeeping)
  `
  ALTER TABLE memories ADD COLUMN uid TEXT;
  ALTER TABLE memories ADD COLUMN synced_at TEXT;
  CREATE TABLE IF NOT EXISTS tombstones (uid TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, remote INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TRIGGER IF NOT EXISTS memories_tombstone AFTER DELETE ON memories WHEN old.uid IS NOT NULL BEGIN
    INSERT OR REPLACE INTO tombstones(uid, deleted_at, remote) VALUES (old.uid, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0);
  END;
  `,
  // v4 -> v5: outdated (superseded) notes, checkpoints, imported Claude memory files, recovered sessions
  `
  ALTER TABLE memories ADD COLUMN superseded_at TEXT;
  ALTER TABLE memories ADD COLUMN superseded_by TEXT;
  ALTER TABLE sessions ADD COLUMN checkpoint_at TEXT;
  ALTER TABLE sessions ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS imported_files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, memory_uid TEXT);
  CREATE INDEX IF NOT EXISTS memories_live ON memories(project, superseded_at, created_at);
  `,
  // v5 -> v6: git branch per session, usage meter
  `
  ALTER TABLE sessions ADD COLUMN branch TEXT;
  CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0, chars_in INTEGER NOT NULL DEFAULT 0, chars_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, project, kind));
  `,
  // v6 -> v7: concept tags (related words the summary model adds, so searches match by meaning), indexed for search
  `
  ALTER TABLE memories ADD COLUMN tags TEXT;
  DROP TRIGGER IF EXISTS memories_ai;
  DROP TRIGGER IF EXISTS memories_ad;
  DROP TRIGGER IF EXISTS memories_au;
  DROP TABLE IF EXISTS memories_fts;
  CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, tags, content='memories', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
  `,
  // v7 -> v8: notes whose files changed a lot since they were written (per machine, from git; not synced)
  `
  ALTER TABLE memories ADD COLUMN stale_at TEXT;
  `,
];

/** Search ranking: BM25 (title > tags > body), with newer notes up to 1.5x stronger over the past year. */
export const RANK = "bm25(memories_fts, 3.0, 1.0, 1.5) * (1.0 + 0.5 * max(0.0, 1.0 - (julianday('now') - julianday(m.created_at)) / 365.0))";

export const newUid = () => randomUUID();

// Data fixes that need JavaScript, run right after the SQL migration with the same index.
const MIGRATION_JS = {
  2: (db) => {
    const st = db.prepare('UPDATE memories SET uid = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id FROM memories WHERE uid IS NULL').all()) st.run(newUid(), r.id);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS memories_uid ON memories(uid)');
  },
  1: (db) => {
    const st = db.prepare('UPDATE memories SET title_key = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, title FROM memories').all()) st.run(titleKey(r.title), r.id);
  },
};

/** Normalized title used to spot duplicate notes: lowercase letters and digits only. */
export function titleKey(title) {
  return String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function openDb() {
  if (db) return db;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  // Notes can hold project details: keep the folder and database readable by this user only.
  if (process.platform !== 'win32') { try { fs.chmodSync(HOME, 0o700); } catch {} }
  db = new DatabaseSync(path.join(HOME, 'memory.db'));
  if (process.platform !== 'win32') {
    for (const f of ['memory.db', 'memory.db-wal', 'memory.db-shm']) { try { fs.chmodSync(path.join(HOME, f), 0o600); } catch {} }
  }
  // busy_timeout must come first so every later statement waits for other hook processes instead of failing.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories_fts'").get()) db.exec(BASE_SCHEMA);
  let v = db.prepare('PRAGMA user_version').get().user_version || 1;
  while (v - 1 < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the lock: another hook process may have migrated first.
      const cur = db.prepare('PRAGMA user_version').get().user_version || 1;
      if (cur === v) {
        db.exec(MIGRATIONS[v - 1]);
        MIGRATION_JS[v - 1]?.(db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    v = db.prepare('PRAGMA user_version').get().user_version;
  }
  return db;
}

export const now = () => new Date().toISOString();

/** Project = nearest folder (walking up) containing .git, otherwise the cwd itself. */
export function projectFor(cwd) {
  if (!cwd) return 'unknown';
  let dir = path.resolve(cwd);
  // One folder, one project: "c:\\x" and "C:\\x" (VS Code vs Explorer), or a different letter case on macOS/Windows.
  try { dir = fs.realpathSync.native(dir); } catch {}
  if (process.platform === 'win32') dir = dir.replace(/^[a-z]:/, (m) => m.toUpperCase());
  cwd = dir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/** Store file paths relative to the project when they live inside it. */
export function relPath(project, p) {
  if (!p || typeof p !== 'string') return null;
  if (path.isAbsolute(p) && project) {
    const ci = process.platform === 'win32' || process.platform === 'darwin';
    const norm = (x) => { const r = path.resolve(x); return ci ? r.toLowerCase() : r; };
    const a = norm(p), b = norm(project);
    if (a === b || a.startsWith(b + path.sep)) return path.relative(path.resolve(project), path.resolve(p)).split(path.sep).join('/').replace(/^$/, '.');
  }
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function ensureSession(id, project, transcriptPath) {
  const d = openDb();
  const t = now();
  d.prepare(
    `INSERT INTO sessions(id, project, started_at, last_activity, transcript_path) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_activity = excluded.last_activity, ended_at = NULL,
       transcript_path = coalesce(excluded.transcript_path, sessions.transcript_path),
       summarized = 0,
       summarize_attempts = 0`
  ).run(id, project, t, t, transcriptPath ?? null);
}

export function addEvent(sessionId, kind, tool, detail, { isEdit = false } = {}) {
  const d = openDb();
  const t = now();
  d.prepare(`INSERT INTO events(session_id, ts, kind, tool, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, t, kind, tool ?? null, detail ?? '');
  if (kind === 'prompt') {
    d.prepare(`UPDATE sessions SET prompts = prompts + 1, last_activity = ? WHERE id = ?`).run(t, sessionId);
  } else {
    d.prepare(`UPDATE sessions SET tool_calls = tool_calls + 1, edits = edits + ?, last_activity = ? WHERE id = ?`)
      .run(isEdit ? 1 : 0, t, sessionId);
  }
}

/** Tool calls and edits not yet covered by a summary. */
export function pendingWork(session) {
  const d = openDb();
  const r = d.prepare(
    `SELECT count(*) tools, coalesce(sum(tool IN ('Edit','Write','MultiEdit','NotebookEdit')), 0) edits
     FROM events WHERE session_id = ? AND id > ? AND kind = 'tool'`
  ).get(session.id, session.summarized_upto);
  return { tools: r.tools, edits: r.edits };
}

export function qualifies(session, cfg) {
  const w = pendingWork(session);
  return w.edits > 0 || w.tools >= cfg.minToolCalls;
}

/**
 * Insert a note, unless the project already has a live note with the same normalized title and type
 * (common when many sessions touch the same area). Returns { id, duplicate }.
 */
export function insertMemory(d, { sessionId = null, project, type, title, body, files = [], source = 'auto', pinned = 0, tags = null }) {
  const key = titleKey(title);
  if (type !== 'session') {
    const dup = d.prepare(
      `SELECT id, body FROM memories WHERE project = ? AND title_key = ? AND type = ? AND (status IS NULL OR status = 'open') AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`
    ).get(project, key, type);
    if (dup) {
      // Keep the richer wording, and remember that this came up again.
      if (body.length > dup.body.length) d.prepare(`UPDATE memories SET body = ?, updated_at = ? WHERE id = ?`).run(body, now(), dup.id);
      if (tags) d.prepare(`UPDATE memories SET tags = trim(coalesce(tags, '') || ' ' || ?) WHERE id = ?`).run(tags, dup.id);
      linkFiles(d, project, dup.id, files);
      return { id: dup.id, duplicate: true };
    }
  }
  const r = d.prepare(
    `INSERT INTO memories(session_id, project, created_at, type, title, body, status, source, pinned, title_key, uid, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, project, now(), type, title, body, type === 'todo' ? 'open' : null, source, pinned ? 1 : 0, key, newUid(), tags || null);
  const id = Number(r.lastInsertRowid);
  linkFiles(d, project, id, files);
  return { id, duplicate: false };
}

function linkFiles(d, project, id, files = []) {
  const addFile = d.prepare(`INSERT OR IGNORE INTO memory_files(memory_id, path) VALUES (?, ?)`);
  for (const f of files.slice(0, 12)) {
    const p = relPath(project, f);
    if (p) addFile.run(id, p);
  }
}

export function updateMemory(d, id, { title, body, type, pinned, status }) {
  const m = d.prepare('SELECT * FROM memories WHERE id = ?').get(Number(id));
  if (!m) return null;
  const next = {
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : m.title,
    body: typeof body === 'string' && body.trim() ? body.trim().slice(0, 8000) : m.body,
    type: MEMORY_TYPES.includes(type) ? type : m.type,
    pinned: pinned === undefined ? m.pinned : pinned ? 1 : 0,
    status: status === 'open' || status === 'done' ? status : m.status,
  };
  if (next.type === 'todo' && !next.status) next.status = 'open';
  if (next.type !== 'todo') next.status = null;
  d.prepare(
    `UPDATE memories SET title = ?, body = ?, type = ?, pinned = ?, status = ?, title_key = ?, updated_at = ?,
       stale_at = CASE WHEN body = ? THEN stale_at ELSE NULL END,
       resolved_at = CASE WHEN ? = 'done' THEN coalesce(resolved_at, ?) ELSE NULL END WHERE id = ?`
  ).run(next.title, next.body, next.type, next.pinned, next.status, titleKey(next.title), now(), next.body, next.status, now(), m.id);
  return d.prepare('SELECT * FROM memories WHERE id = ?').get(m.id);
}

/** Mark notes as outdated: kept for history, but no longer recalled. `by` = uid or short reason. */
export function markSuperseded(d, project, ids, by = null) {
  const st = d.prepare(
    `UPDATE memories SET superseded_at = ?, superseded_by = ?, updated_at = ?, pinned = 0
     WHERE id = ? AND (? IS NULL OR project = ?) AND superseded_at IS NULL AND type NOT IN ('brief')`
  );
  let n = 0;
  for (const id of ids) { const t = now(); n += Number(st.run(t, by, t, Number(id), project, project).changes); }
  return n;
}

/** Usage meter: kind = 'inject' (context threadkeeper added to Claude) or 'model' (summary-model calls). */
export function recordUsage(project, kind, charsIn, charsOut = 0) {
  try {
    openDb().prepare(
      `INSERT INTO usage(day, project, kind, n, chars_in, chars_out) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, project, kind) DO UPDATE SET n = n + 1, chars_in = chars_in + excluded.chars_in, chars_out = chars_out + excluded.chars_out`
    ).run(now().slice(0, 10), project || 'general', kind, Math.max(0, charsIn | 0), Math.max(0, charsOut | 0));
  } catch {}
}

/** Current git branch, read from .git/HEAD (no git process). */
export function gitBranch(project) {
  try {
    const head = fs.readFileSync(path.join(project, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 10);
  } catch { return null; }
}

/** Totals for the last `days` days (one project, or all): tokens threadkeeper added to Claude's context, summary-model calls, re-reads saved. */
export function usageSummary(days = 7, project = null) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = openDb().prepare(
    `SELECT kind, sum(n) n, sum(chars_in) cin, sum(chars_out) cout FROM usage WHERE day >= ? ${project ? 'AND project = ?' : ''} GROUP BY kind`
  ).all(since, ...(project ? [project] : []));
  const get = (k) => rows.find((r) => r.kind === k) || { n: 0, cin: 0, cout: 0 };
  const inj = get('inject'), mod = get('model'), saved = get('saved');
  return {
    days,
    injected: { times: inj.n, tokens: Math.round(inj.cin / 4) },
    model: { calls: mod.n, tokensIn: Math.round(mod.cin / 4), tokensOut: Math.round(mod.cout / 4) },
    saved: { rereads: saved.n, tokens: Math.round(saved.cin / 4) },
  };
}

/** The same numbers per project, biggest first. */
export function usageByProject(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const t = (k, col = 'chars_in') => `round(sum(CASE WHEN kind = '${k}' THEN ${col} ELSE 0 END) / 4.0)`;
  return openDb().prepare(
    `SELECT project, ${t('inject')} added, ${t('saved')} saved, sum(CASE WHEN kind = 'saved' THEN n ELSE 0 END) rereads,
       sum(CASE WHEN kind = 'model' THEN n ELSE 0 END) calls, ${t('model')} + ${t('model', 'chars_out')} model
     FROM usage WHERE day >= ? GROUP BY project ORDER BY added + saved + model DESC`
  ).all(since);
}

export function filesOf(d, memoryId) {
  return d.prepare(`SELECT path FROM memory_files WHERE memory_id = ? ORDER BY path`).all(memoryId).map((r) => r.path);
}

export function openTodos(project, limit = 20) {
  return openDb().prepare(
    `SELECT * FROM memories WHERE project = ? AND type = 'todo' AND status = 'open' AND superseded_at IS NULL ORDER BY id DESC LIMIT ?`
  ).all(project, limit);
}

export function resolveTodos(d, project, ids) {
  const st = d.prepare(`UPDATE memories SET status = 'done', resolved_at = ?, updated_at = ? WHERE id = ? AND project = ? AND type = 'todo'`);
  let n = 0;
  for (const id of ids) { const t = now(); n += Number(st.run(t, t, Number(id), project).changes); }
  return n;
}
