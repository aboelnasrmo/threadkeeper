// One-time import of history from the original claude-mem (~/.claude-mem/claude-mem.db). Read-only on the source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, titleKey, newUid } from './db.mjs';
import { redact, clip } from './redact.mjs';

const TYPE_MAP = {
  bugfix: 'bugfix', feature: 'feature', refactor: 'refactor', discovery: 'discovery', decision: 'decision',
  change: 'note', security_alert: 'gotcha', security_note: 'note', gotcha: 'gotcha', todo: 'note', note: 'note',
};

const arr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const iso = (epoch, fallback) => {
  if (epoch) { const ms = epoch < 1e12 ? epoch * 1000 : epoch; return new Date(ms).toISOString(); }
  const t = Date.parse(fallback); return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
};
const cols = (db, table) => { try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { return new Set(); } };

export function importClaudeMem(srcPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db'), { again = false } = {}) {
  if (!fs.existsSync(srcPath)) throw new Error(`No claude-mem database at ${srcPath}`);
  const d = openDb();
  const already = d.prepare(`SELECT count(*) n FROM memories WHERE source = 'claude-mem'`).get().n;
  if (already && !again) return { skipped: true, already };

  const src = new DatabaseSync(srcPath, { readOnly: true });
  const oc = cols(src, 'observations');
  const sc = cols(src, 'session_summaries');
  const ins = d.prepare(
    `INSERT INTO memories(session_id, project, created_at, type, title, body, status, source, title_key, uid) VALUES (NULL, ?, ?, ?, ?, ?, NULL, 'claude-mem', ?, ?)`
  );
  const addFile = d.prepare(`INSERT OR IGNORE INTO memory_files(memory_id, path) VALUES (?, ?)`);
  let observations = 0, summaries = 0;

  d.exec('BEGIN IMMEDIATE');
  try {
    if (oc.size) {
      for (const o of src.prepare('SELECT * FROM observations ORDER BY id').iterate()) {
        if (o.type === 'sensitive') continue; // claude-mem's own "keep this out" type stays behind
        const type = TYPE_MAP[o.type] || 'note'; // unknown/custom types are kept as notes, never dropped
        const facts = oc.has('facts') ? arr(o.facts) : [];
        const body = [o.narrative || o.text || o.subtitle || '', facts.length ? 'Facts: ' + facts.join('; ') : ''].filter(Boolean).join('\n');
        const title = o.title || o.subtitle || clip(body, 80);
        if (!title || !body) continue;
        const t = clip(redact(title), 160);
        const r = ins.run('claude-mem:' + o.project, iso(o.created_at_epoch, o.created_at), type, t, clip(redact(body), 2000), titleKey(t), newUid());
        const id = Number(r.lastInsertRowid);
        for (const f of [...arr(o.files_modified), ...arr(o.files_read)].slice(0, 12)) addFile.run(id, f);
        observations++;
      }
    }
    if (sc.size) {
      for (const s of src.prepare('SELECT * FROM session_summaries ORDER BY id').iterate()) {
        const parts = [
          s.request && `Asked: ${s.request}`,
          s.completed && `Done: ${s.completed}`,
          s.learned && `Learned: ${s.learned}`,
          s.next_steps && `Next: ${s.next_steps}`,
        ].filter(Boolean);
        if (!parts.length) continue;
        ins.run('claude-mem:' + s.project, iso(s.created_at_epoch, s.created_at), 'session', 'Session summary (claude-mem)', clip(redact(parts.join('\n')), 2000), 'session summary claude mem', newUid());
        summaries++;
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    src.close();
  }
  const projects = d.prepare(`SELECT project, count(*) n FROM memories WHERE source = 'claude-mem' AND project LIKE 'claude-mem:%' GROUP BY project ORDER BY n DESC`).all();
  return { observations, summaries, projects };
}
