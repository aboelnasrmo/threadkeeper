// Problems worth telling the user about, so threadkeeper never fails silently.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from './config.mjs';
import { openDb } from './db.mjs';

const DAY = 86400000;

/** Recent lines of errors.log (last 24 h), newest last. */
export function recentErrors(hours = 24) {
  let text = '';
  try {
    const f = path.join(HOME, 'errors.log');
    const st = fs.statSync(f);
    const len = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return []; }
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return text.split('\n').filter((l) => /^\d{4}-\d\d-\d\dT/.test(l) && l.slice(0, 24) >= since);
}

/**
 * @returns {{level: 'warn'|'info', text: string}[]}
 */
export function healthProblems(cfg) {
  const out = [];
  const d = openDb();
  const errs = recentErrors();
  if (errs.length) out.push({ level: 'warn', text: `${errs.length} error(s) in the last 24 h, latest: ${errs[errs.length - 1].slice(25, 180).replace(/[\r\n`]/g, ' ')} (see ${path.join(HOME, 'errors.log')})` });
  const failed = d.prepare(`SELECT count(*) n FROM sessions WHERE summarized = -1 AND summarize_attempts >= 3 AND last_activity > ?`)
    .get(new Date(Date.now() - 7 * DAY).toISOString()).n;
  if (failed) out.push({ level: 'warn', text: `${failed} session(s) in the last week could not be summarized (is \`claude\` on PATH and signed in?)` });
  const stuck = d.prepare(`SELECT count(*) n FROM sessions WHERE summarized = 0 AND ended_at IS NOT NULL AND ended_at < ?`)
    .get(new Date(Date.now() - 6 * 3600000).toISOString()).n;
  if (stuck) out.push({ level: 'info', text: `${stuck} finished session(s) still waiting for a summary` });
  if (cfg.syncDir) {
    const dir = cfg.syncDir.replace(/^~(?=$|[\\/])/, os.homedir());
    if (!fs.existsSync(dir)) out.push({ level: 'warn', text: `sync folder not found: ${dir} (is Google Drive running?)` });
    else {
      const last = d.prepare(`SELECT value FROM sync_state WHERE key = 'last_sync'`).get()?.value;
      if (last && Date.now() - Date.parse(last) > 2 * DAY) out.push({ level: 'warn', text: `last sync was ${last.slice(0, 10)}` });
      const locked = d.prepare(`SELECT value FROM sync_state WHERE key = 'sync_locked'`).get()?.value;
      if (locked) out.push({ level: 'warn', text: `notes from ${locked} are encrypted with a key this machine doesn't have. Run \`node <threadkeeper>/src/cli.mjs encrypt <key>\` with the key from \`encrypt\` on that machine` });
    }
  }
  return out;
}
