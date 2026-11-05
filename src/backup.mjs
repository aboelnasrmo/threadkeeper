#!/usr/bin/env node
// Nightly copy of the memory database, so a damaged disk or a bad update can't take notes with it
// (sync only covers notes, and only once they reach the cloud folder). Last 7 days are kept.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, logError } from './config.mjs';
import { openDb, now } from './db.mjs';

export const BACKUP_DIR = path.join(HOME, 'backups');
const KEEP = 7;

export function backupDue(d = openDb()) {
  const last = d.prepare(`SELECT value FROM sync_state WHERE key = 'last_backup'`).get()?.value;
  return !last || Date.now() - Date.parse(last) > 20 * 3600 * 1000;
}

/** Write today's backup (a consistent snapshot, safe while hooks are writing) and drop old ones. Returns its path. */
export function backup() {
  const d = openDb();
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(BACKUP_DIR, `memory-${now().slice(0, 10)}.db`);
  const tmp = file + '.tmp';
  fs.rmSync(tmp, { force: true });
  d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} }
  d.prepare(`INSERT INTO sync_state(key, value) VALUES ('last_backup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now());
  const all = listBackups();
  for (const b of all.slice(KEEP)) fs.rmSync(b.path, { force: true });
  return file;
}

export function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => /^memory-\d{4}-\d\d-\d\d\.db$/.test(n)); } catch {}
  return names.sort().reverse().map((n) => {
    const p = path.join(BACKUP_DIR, n);
    return { path: p, day: n.slice(7, 17), bytes: fs.statSync(p).size };
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) { try { backup(); } catch (e) { logError('backup', e); } }
