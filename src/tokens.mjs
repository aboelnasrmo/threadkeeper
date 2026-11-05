// "Where tokens go" in a project: the biggest costs of the work itself, from the activity threadkeeper already records,
// with concrete tips. Never loaded into Claude's context.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { noiseKind } from './guard.mjs';

const tok = (bytes) => Math.round(bytes / 4);
const sizeOf = (p) => { try { const st = fs.statSync(p); return st.isFile() ? st.size : 0; } catch { return 0; } };

export function tokenReport(project, days = 14, d = openDb()) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sessions = d.prepare(`SELECT id FROM sessions WHERE project = ? AND started_at > ? AND prompts + tool_calls > 0`).all(project, since).map((r) => r.id);
  const reads = new Map(); // rel -> { reads, sessionsWithRepeats }
  let partReads = 0, fullReads = 0;
  if (sessions.length) {
    const rows = d.prepare(
      `SELECT session_id, detail FROM events WHERE tool = 'Read' AND session_id IN (${sessions.map(() => '?').join(',')})`
    ).all(...sessions);
    const perSession = new Map();
    for (const r of rows) {
      const m = /^(.+?)(?: \[part\]| \[subagent\]| \(sensitive|$)/.exec(r.detail || '');
      if (!m) continue;
      if ((r.detail || '').includes('[part]')) { partReads++; continue; }
      fullReads++;
      const rel = m[1].trim();
      const k = r.session_id + '\0' + rel;
      perSession.set(k, (perSession.get(k) || 0) + 1);
      const e = reads.get(rel) || { reads: 0, repeated: 0 };
      e.reads++;
      reads.set(rel, e);
    }
    for (const [k, n] of perSession) if (n > 1) reads.get(k.split('\0')[1]).repeated += n - 1;
  }
  const files = [...reads].map(([rel, e]) => {
    const size = sizeOf(path.isAbsolute(rel) ? rel : path.join(project, rel));
    return { file: rel, reads: e.reads, repeated: e.repeated, tokens: tok(size), total: tok(size) * e.reads, kind: noiseKind(rel, size) };
  }).filter((f) => f.tokens > 0).sort((a, b) => b.total - a.total);

  // Instructions Claude Code loads into every session in this project.
  const always = [
    path.join(project, 'CLAUDE.md'), path.join(project, '.claude', 'CLAUDE.md'), path.join(project, 'CLAUDE.local.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  ].map((p) => ({ file: p.startsWith(project) ? path.relative(project, p) : p.replace(os.homedir(), '~'), tokens: tok(sizeOf(p)) })).filter((f) => f.tokens);

  const compactions = sessions.length ? d.prepare(
    `SELECT count(*) n FROM sync_state WHERE key IN (${sessions.map(() => '?').join(',')})`
  ).get(...sessions.map((s) => 'compact:' + s)).n : 0;
  const saved = d.prepare(`SELECT kind, sum(n) n, sum(chars_in) c FROM usage WHERE project = ? AND day >= ? GROUP BY kind`).all(project, since.slice(0, 10));
  const u = Object.fromEntries(saved.map((r) => [r.kind, { n: r.n, tokens: tok(r.c) }]));

  const tips = [];
  const alwaysTotal = always.reduce((a, f) => a + f.tokens, 0);
  if (alwaysTotal > 2500) tips.push(`CLAUDE.md files load ~${alwaysTotal.toLocaleString()} tokens into every session. Keep only rules Claude needs every time; move background into docs it reads when needed (or into threadkeeper notes, which load only when relevant).`);
  const noisy = files.filter((f) => f.kind);
  if (noisy.length) tips.push(`Claude read ${noisy.length} lockfile/generated/very large file(s) in full (e.g. ${noisy[0].file}, ~${noisy[0].tokens.toLocaleString()} tokens). threadkeeper now stops the first full read with a hint; to block them for good, add them to "permissions": {"deny": ["Read(./${noisy[0].file})"]} in .claude/settings.json.`);
  const repeats = files.filter((f) => f.repeated >= 2 && f.tokens > 1000).slice(0, 3);
  if (repeats.length) tips.push(`Files read again and again in the same session: ${repeats.map((f) => `${f.file} (${f.repeated} extra reads)`).join(', ')}. Usually after compaction or edits. A big file that keeps coming back is worth splitting, or worth a pinned note with the facts Claude keeps looking up.`);
  if (sessions.length && compactions / sessions.length > 0.5) tips.push(`${compactions} compaction(s) in ${sessions.length} session(s). Long sessions re-send their whole history every turn: start a new session (/clear) between unrelated tasks; threadkeeper carries what matters into the next one.`);
  if (fullReads > 30 && partReads / Math.max(1, fullReads) < 0.1 && files.some((f) => f.tokens > 8000)) tips.push(`Almost every read is a whole file. For big files, a Grep first and then a slice (offset/limit) usually costs a fraction.`);

  return {
    project, days, sessions: sessions.length, compactions, fullReads, partReads,
    readTokens: files.reduce((a, f) => a + f.total, 0),
    top: files.slice(0, 8), always, alwaysTotal,
    added: u.inject?.tokens || 0, saved: u.saved?.tokens || 0, stops: u.saved?.n || 0,
    tips,
  };
}

export function tokenReportText(r) {
  const k = (n) => n.toLocaleString();
  const out = [`Where tokens go in ${path.basename(r.project)} (last ${r.days} days, ${r.sessions} session(s))`];
  if (r.alwaysTotal) out.push(`Loaded every session: ${r.always.map((f) => `${f.file} ~${k(f.tokens)}`).join(', ')}`);
  out.push(`File reads: ${r.fullReads} full, ${r.partReads} partial, ~${k(r.readTokens)} tokens (at today's sizes)`);
  for (const f of r.top) out.push(`  ~${k(f.total).padStart(7)}  ${f.file}  (${f.reads}× ~${k(f.tokens)}${f.repeated ? `, ${f.repeated} repeat(s) in one session` : ''}${f.kind ? `, ${f.kind}` : ''})`);
  out.push(`Compactions: ${r.compactions}`);
  out.push(`threadkeeper: added ~${k(r.added)} tokens of memory, saved ~${k(r.saved)} with ${r.stops} stopped re-read(s)/noise read(s)`);
  if (r.tips.length) { out.push('', 'Tips:'); for (const t of r.tips) out.push(`- ${t}`); }
  return out.join('\n');
}
