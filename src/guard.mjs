// Token guards for the project work itself (not threadkeeper's own context):
//  - noise files: lockfiles, minified bundles, source maps, build output and very large files are rarely worth reading
//    whole. The first full read is stopped with a hint (Grep, or a slice); a second attempt goes through.
//  - repeated searches: the same Grep/Glob again, with nothing edited or run since, returns what is already above.
// Like the re-read guard, every stop gives way on the next attempt, so Claude is never blocked.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, relPath, recordUsage, now } from './db.mjs';
import { isSensitivePath } from './redact.mjs';

const LOCKFILES = /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Podfile\.lock|Package\.resolved|go\.sum|pubspec\.lock|flake\.lock)$/i;
const GENERATED = /(\.min\.(js|css|mjs)|\.(js|css)\.map|\.bundle\.js|\.chunk\.js|\.pb\.go|_pb2\.py|\.g\.dart|\.freezed\.dart)$/i;
const BUILD_DIR = /(^|[\\/])(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|\.turbo|\.gradle|DerivedData|Pods|target[\\/](debug|release))[\\/]/;

export function noiseKind(rel, size, cfg = {}) {
  if (LOCKFILES.test(rel)) return 'a lockfile';
  if (GENERATED.test(rel)) return 'generated or minified';
  if (BUILD_DIR.test(rel)) return 'build output or dependencies';
  if (size > (Number(cfg.bigReadBytes) || 80000)) return 'very large';
  return null;
}

/** Pass once after a stop (the second attempt goes through) and take back the saving that didn't happen. */
function secondTry(d, sessionId, key, project, chars) {
  if (!Number(d.prepare('DELETE FROM injected_files WHERE session_id = ? AND path = ?').run(sessionId, key).changes)) return false;
  if (chars) recordUsage(project, 'saved', -chars);
  return true;
}

export function noiseCheck(project, sessionId, input, cfg) {
  const ti = input.tool_input || {};
  const fp = ti.file_path;
  if (!fp || ti.offset || ti.limit || ti.pages || isSensitivePath(fp)) return null;
  const abs = path.isAbsolute(fp) ? fp : path.join(input.cwd || project, fp);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size < 4000) return null;
  const rel = relPath(project, abs);
  const kind = noiseKind(rel, st.size, cfg);
  if (!kind) return null;
  const d = openDb();
  const key = 'noise:' + rel;
  const chars = Math.min(st.size, 256000);
  if (secondTry(d, sessionId, key, project, chars)) return null;
  d.prepare('INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)').run(sessionId, key);
  recordUsage(project, 'saved', chars);
  return `threadkeeper: ${rel} is ${kind} (~${Math.round(st.size / 4).toLocaleString()} tokens). Usually only part of it matters: ` +
    `Grep it for what you need, or Read a slice with offset/limit. Need all of it? Read again and it goes through.`;
}

export function repeatSearchCheck(project, sessionId, input) {
  const ti = input.tool_input || {};
  if (input.agent_id || !ti.pattern) return null;
  const h = createHash('sha1').update(input.tool_name + JSON.stringify(ti)).digest('hex').slice(0, 16);
  const d = openDb();
  if (secondTry(d, sessionId, 'q2:' + h, project, 0)) return null;
  const prev = d.prepare(`SELECT path FROM injected_files WHERE session_id = ? AND path LIKE ?`).get(sessionId, `q:${h}:%`)?.path;
  const remember = () => {
    d.prepare(`DELETE FROM injected_files WHERE session_id = ? AND path LIKE ?`).run(sessionId, `q:${h}:%`);
    d.prepare('INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)').run(sessionId, `q:${h}:${now()}`);
  };
  if (!prev) { remember(); return null; }
  const at = prev.slice(prev.indexOf(':', 2) + 1);
  const compacted = d.prepare('SELECT value FROM sync_state WHERE key = ?').get('compact:' + sessionId)?.value;
  // Anything that may have changed files since (edits, shell commands) means the results may differ: search again.
  const changed = d.prepare(
    `SELECT 1 FROM events WHERE session_id = ? AND ts >= ? AND tool IN ('Edit','Write','MultiEdit','NotebookEdit','Bash','Task','Agent') LIMIT 1`
  ).get(sessionId, at);
  if (changed || (compacted && compacted > at)) { remember(); return null; }
  d.prepare('INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)').run(sessionId, 'q2:' + h);
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(at)) / 60000));
  return `threadkeeper: you ran this exact ${input.tool_name} ${mins} min ago and nothing was edited or run since, so its results are above. ` +
    `Not in your context? Run it again and it goes through.`;
}
