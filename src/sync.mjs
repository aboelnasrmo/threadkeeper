#!/usr/bin/env node
// Sync notes between machines through a shared folder (Google Drive, iCloud, Dropbox, a USB stick...).
// Each machine keeps its OWN database and only ever appends to its OWN file in the folder:
//   <syncDir>/<machine-id>.jsonl   one JSON change per line: {op:'put', ...note} or {op:'del', uid, at}
// Every machine reads the other files and applies changes, newest edit wins. No file is ever written by two
// machines, so cloud sync conflicts and database corruption cannot happen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOME, loadConfig, logError } from './config.mjs';
import { openDb, now, titleKey, relPath, MEMORY_TYPES } from './db.mjs';

const LOCK_MS = 2 * 60 * 1000;
const expandHome = (p) => (p && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

export function machineId() {
  const f = path.join(HOME, 'machine-id');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = `${os.hostname().replace(/[^\w-]+/g, '-').slice(0, 40)}-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(f, id + '\n');
  return id;
}

// ---------- Encryption: once a key is set, this machine's file holds only AES-256-GCM sealed lines ----------
// The key lives in ~/.threadkeeper/sync-key on each machine (never in the sync folder). Lines are "E1:" + base64(iv|tag|data).
const KEY_FILE = () => path.join(HOME, 'sync-key');
export function syncKey() {
  try {
    const k = Buffer.from(fs.readFileSync(KEY_FILE(), 'utf8').trim(), 'base64url');
    return k.length === 32 ? k : null;
  } catch { return null; }
}
export function setSyncKey(text) {
  const k = text ? Buffer.from(String(text).trim(), 'base64url') : randomBytes(32);
  if (k.length !== 32) throw new Error('That is not a threadkeeper sync key (expected 43 characters).');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(KEY_FILE(), k.toString('base64url') + '\n', { mode: 0o600 });
  return k.toString('base64url');
}
export function seal(line, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(line, 'utf8'), c.final()]);
  return 'E1:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
/** A line's JSON text, or null if it is sealed and can't be opened with this key. */
export function unseal(line, key) {
  if (!line.startsWith('E1:')) return line;
  if (!key) return null;
  try {
    const b = Buffer.from(line.slice(3), 'base64');
    const dc = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    dc.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([dc.update(b.subarray(28)), dc.final()]).toString('utf8');
  } catch { return null; }
}
const ownFile = (me, key) => `${me}${key ? '.e1' : ''}.jsonl`;

/**
 * Turn on encryption for this machine's sync file: everything it ever wrote is re-written sealed into
 * <machine>.e1.jsonl and the readable file is removed. Other machines re-read it once (applying is idempotent).
 */
export function encryptOwnFile(dir, me, key) {
  const plain = path.join(dir, `${me}.jsonl`);
  if (!fs.existsSync(plain)) return 0;
  const lines = fs.readFileSync(plain, 'utf8').split('\n').filter((l) => l.trim());
  const target = path.join(dir, `${me}.e1.jsonl`);
  const tmp = target + '.tmp';
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  fs.writeFileSync(tmp, lines.map((l) => (l.startsWith('E1:') ? l : seal(l, key))).join('\n') + (lines.length ? '\n' : '') + existing);
  fs.renameSync(tmp, target);
  fs.rmSync(plain, { force: true });
  return lines.length;
}

/** Projects travel by folder name: /Users/me/projects/my-app and C:\Users\me\...\my-app are the same project. */
export const projectKey = (p) => (p === 'general' ? 'general' : (String(p).replace(/^(claude-mem|sync):/, '').split(/[\\/]/).filter(Boolean).pop() || 'general').toLowerCase());

function localProjectFor(d, key) {
  if (key === 'general') return 'general';
  const rows = d.prepare(
    `SELECT project FROM (SELECT project, last_activity at FROM sessions UNION ALL SELECT project, created_at FROM memories)
     WHERE project NOT LIKE 'sync:%' AND project NOT LIKE 'claude-mem:%' GROUP BY project ORDER BY max(at) DESC`
  ).all();
  return rows.find((r) => projectKey(r.project) === String(key).toLowerCase())?.project || 'sync:' + String(key).toLowerCase();
}

const getState = (d, k) => d.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value ?? null;
const setState = (d, k, v) => d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

function claim(d) {
  d.exec('BEGIN IMMEDIATE');
  try {
    const held = getState(d, 'lock');
    if (held && Date.now() - Date.parse(held) < LOCK_MS) { d.exec('COMMIT'); return false; }
    setState(d, 'lock', now());
    d.exec('COMMIT');
    return true;
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

function exportChanges(d, dir, me) {
  const since = getState(d, 'exported_upto') || '';
  const upto = now();
  const notes = d.prepare(
    `SELECT * FROM memories WHERE uid IS NOT NULL AND coalesce(updated_at, created_at) > ? AND coalesce(updated_at, created_at) <= ?
       AND (synced_at IS NULL OR coalesce(updated_at, created_at) > synced_at) ORDER BY id`
  ).all(since, upto);
  const dels = d.prepare(`SELECT * FROM tombstones WHERE remote = 0 AND deleted_at > ? AND deleted_at <= ?`).all(since, upto);
  const files = d.prepare('SELECT path FROM memory_files WHERE memory_id = ?');
  const lines = [
    ...notes.map((m) => JSON.stringify({
      op: 'put', uid: m.uid, project: projectKey(m.project), type: m.type, title: m.title, body: m.body,
      status: m.status, pinned: m.pinned, source: m.source, created_at: m.created_at, resolved_at: m.resolved_at,
      version: m.updated_at || m.created_at, files: files.all(m.id).map((r) => r.path),
      superseded_at: m.superseded_at, superseded_by: m.superseded_by, tags: m.tags,
    })),
    ...dels.map((t) => JSON.stringify({ op: 'del', uid: t.uid, at: t.deleted_at })),
  ];
  const key = syncKey();
  if (lines.length) fs.appendFileSync(path.join(dir, ownFile(me, key)), (key ? lines.map((l) => seal(l, key)) : lines).join('\n') + '\n');
  setState(d, 'exported_upto', upto);
  return { notes: notes.length, deletes: dels.length };
}

function applyLine(d, rec) {
  if (!rec || typeof rec.uid !== 'string') return 0;
  const local = d.prepare('SELECT * FROM memories WHERE uid = ?').get(rec.uid);
  if (rec.op === 'del') {
    if (!local || (local.updated_at || local.created_at) > rec.at) return 0; // edited here after the delete: keep it
    d.prepare('DELETE FROM memories WHERE id = ?').run(local.id);
    d.prepare('UPDATE tombstones SET remote = 1 WHERE uid = ?').run(rec.uid);
    return 1;
  }
  if (rec.op !== 'put' || typeof rec.title !== 'string' || typeof rec.body !== 'string' || typeof rec.version !== 'string') return 0;
  const stone = d.prepare('SELECT deleted_at FROM tombstones WHERE uid = ?').get(rec.uid);
  if (!local && stone && stone.deleted_at >= rec.version) return 0; // deleted here after that edit
  if (local && (local.updated_at || local.created_at) >= rec.version) return 0; // ours is as new or newer
  const project = local?.project || localProjectFor(d, String(rec.project || 'general'));
  const vals = [MEMORY_TYPES.includes(rec.type) ? rec.type : 'note', rec.title.slice(0, 160), rec.body.slice(0, 8000), rec.status ?? null, rec.pinned ? 1 : 0,
    rec.resolved_at ?? null, titleKey(rec.title), rec.version, rec.version,
    typeof rec.superseded_at === 'string' ? rec.superseded_at : null, typeof rec.superseded_by === 'string' ? rec.superseded_by.slice(0, 80) : null,
    typeof rec.tags === 'string' ? rec.tags.slice(0, 300) : null];
  let id;
  if (local) {
    d.prepare(`UPDATE memories SET type = ?, title = ?, body = ?, status = ?, pinned = ?, resolved_at = ?, title_key = ?, updated_at = ?, synced_at = ?,
      superseded_at = ?, superseded_by = ?, tags = ? WHERE id = ?`)
      .run(...vals, local.id);
    id = local.id;
  } else {
    const r = d.prepare(
      `INSERT INTO memories(type, title, body, status, pinned, resolved_at, title_key, updated_at, synced_at, superseded_at, superseded_by, tags,
         uid, project, created_at, source, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(...vals, rec.uid, project, String(rec.created_at || rec.version), String(rec.source || 'auto'));
    id = Number(r.lastInsertRowid);
  }
  const add = d.prepare('INSERT OR IGNORE INTO memory_files(memory_id, path) VALUES (?, ?)');
  for (const f of Array.isArray(rec.files) ? rec.files.slice(0, 12) : []) if (typeof f === 'string') add.run(id, relPath(project, f));
  return 1;
}

function importChanges(d, dir, me) {
  let applied = 0;
  const key = syncKey();
  const locked = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name === `${me}.jsonl` || name === `${me}.e1.jsonl`) continue;
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    let offset = Number(getState(d, 'offset:' + name) || 0);
    if (size < offset) offset = 0; // file was replaced: re-read, applying is idempotent
    if (size === offset) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const end = buf.lastIndexOf(0x0a); // only complete lines: the cloud may still be writing the tail
    if (end < 0) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      // Stop at a sealed line this machine can't open (no key yet, or a different key): nothing is skipped,
      // it is read once the right key is set.
      let pos = offset;
      for (const line of buf.subarray(0, end + 1).toString('utf8').split(/(?<=\n)/)) {
        const text = unseal(line.trim(), key);
        if (line.trim() && text === null) { locked.push(name.replace(/(\.e1)?\.jsonl$/, '')); break; }
        if (text) { try { applied += applyLine(d, JSON.parse(text)); } catch {} }
        pos += Buffer.byteLength(line);
      }
      setState(d, 'offset:' + name, pos);
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  setState(d, 'sync_locked', locked.join(','));
  return applied;
}

/** One sync round. Returns a summary, or null when not configured / another sync is running. */
export function runSync(cfg = loadConfig(), { force = false } = {}) {
  const dir = expandHome(cfg.syncDir);
  if (!dir) return null;
  if (!fs.existsSync(dir)) throw new Error(`sync folder not found: ${dir}`);
  const d = openDb();
  if (!force) {
    const last = getState(d, 'last_sync');
    if (last && Date.now() - Date.parse(last) < 60_000) return null; // at most once a minute from hooks
  }
  if (!claim(d)) return null;
  try {
    const me = machineId();
    const key = syncKey();
    if (key && fs.existsSync(path.join(dir, `${me}.jsonl`))) encryptOwnFile(dir, me, key);
    const received = importChanges(d, dir, me);
    const sent = exportChanges(d, dir, me);
    setState(d, 'last_sync', now());
    return { machine: me, dir, received, sent };
  } finally {
    d.prepare('DELETE FROM sync_state WHERE key = ?').run('lock');
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try { runSync(); } catch (e) { logError('sync', e); }
}
