// Re-read guard: re-reading an unchanged file that is still in Claude's context costs its full size again.
// Denied once with a short explanation; if Claude really needs it (it was compacted away, a subagent needs it),
// the very next attempt goes through.
import fs from 'node:fs';
import path from 'node:path';
import { openDb, relPath, recordUsage } from './db.mjs';
import { isSensitivePath } from './redact.mjs';

export function rereadCheck(project, sessionId, input, cfg) {
  const ti = input.tool_input || {};
  const fp = ti.file_path;
  if (!fp || input.agent_id || ti.offset || ti.limit || ti.pages || isSensitivePath(fp)) return null;
  const abs = path.isAbsolute(fp) ? fp : path.join(input.cwd || project, fp);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size < (Number(cfg.rereadMinBytes) || 3000)) return null;
  const rel = relPath(project, abs);
  const d = openDb();
  const last = d.prepare(`SELECT ts FROM events WHERE session_id = ? AND tool = 'Read' AND detail = ? ORDER BY id DESC LIMIT 1`).get(sessionId, rel)?.ts;
  if (!last) return null;
  const compacted = d.prepare('SELECT value FROM sync_state WHERE key = ?').get('compact:' + sessionId)?.value;
  if (compacted && compacted > last) return null;                 // compaction dropped it from context
  if (st.mtimeMs > Date.parse(last) - 1000) return null;            // changed since (or same second): read it
  const changedSince = d.prepare(
    `SELECT 1 FROM events WHERE session_id = ? AND ts > ? AND tool IN ('Edit','Write','MultiEdit','NotebookEdit') AND (detail = ? OR detail LIKE ?) LIMIT 1`
  ).get(sessionId, last, rel, rel + ':%');
  if (changedSince) return null;
  const key = 'reread:' + rel;
  if (Number(d.prepare(`DELETE FROM injected_files WHERE session_id = ? AND path = ?`).run(sessionId, key).changes)) return null; // second try
  d.prepare(`INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)`).run(sessionId, key);
  recordUsage(project, 'saved', st.size);
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(last)) / 60000));
  return `threadkeeper: ${rel} is unchanged since you read it in full ${mins} min ago, so its content is still above in this conversation; ` +
    `use that instead of reading it again (saves ~${Math.round(st.size / 4)} tokens). If it is not in your context ` +
    `(you are a subagent, or the conversation was summarized), just read it again and it will go through.`;
}
