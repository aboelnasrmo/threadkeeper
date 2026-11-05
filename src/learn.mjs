#!/usr/bin/env node
// Learn which recalled notes Claude actually uses. When a session ends, every note that was put in its context is
// checked: did Claude open it (`get`/`timeline`), mention its #id, or work on the files it is about? Notes that keep
// being shown and never used stop loading by themselves (they stay searchable), so the context gets leaner over time
// without losing anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logError } from './config.mjs';
import { openDb, now } from './db.mjs';

const MAX_TRANSCRIPT = 40 * 1024 * 1024;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A note shown this often without ever being used is left out of automatic recall (pinned notes never are). */
export const IGNORE_AFTER = 4;
/** …until this long after it was last shown, when it gets another chance. */
const RETRY_MS = 30 * 86400000;

export function ignored(m) {
  return !m.pinned && (m.shown_count || 0) >= IGNORE_AFTER && !m.used_count &&
    !!m.last_shown_at && Date.now() - Date.parse(m.last_shown_at) < RETRY_MS;
}

/** #ids in Claude's own words (assistant messages) from the session transcript. */
function idsInTranscript(file) {
  const ids = new Set();
  try {
    if (!file || fs.statSync(file).size > MAX_TRANSCRIPT) return ids;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('#')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== 'assistant') continue;
      const parts = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const p of parts) {
        const text = p.type === 'text' ? p.text : p.type === 'thinking' ? p.thinking : p.type === 'tool_use' ? JSON.stringify(p.input) : '';
        for (const m of String(text || '').matchAll(/#(\d{1,8})\b/g)) ids.add(Number(m[1]));
      }
    }
  } catch {}
  return ids;
}

/** Record use for the notes shown in one session, then clear its "already shown" list. */
export function learnSession(sessionId, d = openDb()) {
  const rows = d.prepare(`SELECT path FROM injected_files WHERE session_id = ? AND (path LIKE 'mem:%' OR path LIKE 'seen:%' OR path LIKE 'used:%')`).all(sessionId);
  const shown = new Set(), used = new Set();
  for (const { path: p } of rows) {
    const id = Number(p.slice(p.indexOf(':') + 1));
    if (p.startsWith('used:')) used.add(id); else shown.add(id);
  }
  const isPrivate = !!d.prepare('SELECT 1 FROM sync_state WHERE key = ?').get('private:' + sessionId);
  if (shown.size && !isPrivate) {
    const s = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    // Files the session worked with (stored relative to the project, as note files are).
    const touched = new Set();
    for (const e of d.prepare(`SELECT tool, detail FROM events WHERE session_id = ? AND kind = 'tool'`).all(sessionId)) {
      if (!FILE_TOOLS.has(e.tool)) continue;
      const m = /^(.+?)(?::\s| \(\d+ chars\)| \[part\]| \[subagent\]| \(sensitive|$)/.exec(e.detail || '');
      if (m) touched.add(m[1].trim());
    }
    const mentioned = idsInTranscript(s?.transcript_path);
    const filesOf = d.prepare('SELECT path FROM memory_files WHERE memory_id = ?');
    const upd = d.prepare(`UPDATE memories SET shown_count = shown_count + 1, used_count = used_count + ?, last_shown_at = ? WHERE id = ?`);
    const t = now();
    for (const id of shown) {
      const hit = used.has(id) || mentioned.has(id) || filesOf.all(id).some((f) => touched.has(f.path));
      upd.run(hit ? 1 : 0, t, id);
    }
  }
  d.prepare('DELETE FROM injected_files WHERE session_id = ?').run(sessionId);
  return { shown: shown.size, used: [...shown].filter((id) => used.has(id)).length };
}

/** Share of shown notes Claude used, over all notes shown at least once. */
export function recallStats(project = null, d = openDb()) {
  const r = d.prepare(
    `SELECT count(*) notes, coalesce(sum(shown_count), 0) shown, coalesce(sum(used_count), 0) used,
       sum(CASE WHEN shown_count >= ${IGNORE_AFTER} AND used_count = 0 AND pinned = 0 THEN 1 ELSE 0 END) quiet
     FROM memories WHERE shown_count > 0 ${project ? 'AND project = ?' : ''}`
  ).get(...(project ? [project] : []));
  return { notes: r.notes || 0, shown: r.shown, used: r.used, quiet: r.quiet || 0, rate: r.shown ? r.used / r.shown : null };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) { try { learnSession(process.argv[2]); } catch (e) { logError('learn', e); } }
