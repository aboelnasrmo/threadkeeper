// What got done, per project, over the last few days: for the user (viewer and `week` command), never loaded into
// Claude's context, so it costs no tokens. Built from the notes already written; no model call.
import path from 'node:path';
import { openDb, usageSummary } from './db.mjs';
import { recallStats } from './learn.mjs';

const clipLine = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export function weekReport(days = 7) {
  const d = openDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const projects = d.prepare(
    `SELECT project, count(*) n FROM memories WHERE created_at > ? AND type != 'brief' AND project NOT LIKE 'claude-mem:%'
     GROUP BY project ORDER BY max(created_at) DESC`
  ).all(since).map(({ project, n }) => {
    const rows = d.prepare(
      `SELECT * FROM memories WHERE project = ? AND created_at > ? AND type != 'brief' AND superseded_at IS NULL ORDER BY created_at DESC`
    ).all(project, since);
    const sessions = d.prepare(`SELECT count(*) n, sum(edits) edits FROM sessions WHERE project = ? AND started_at > ?`).get(project, since);
    const done = d.prepare(
      `SELECT id, title FROM memories WHERE project = ? AND type = 'todo' AND status = 'done' AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 10`
    ).all(project, since);
    const pick = (types, k) => rows.filter((r) => types.includes(r.type)).slice(0, k).map((r) => ({ id: r.id, day: r.created_at.slice(0, 10), title: r.title }));
    return {
      project,
      name: path.basename(project),
      notes: n,
      sessions: sessions.n || 0,
      edits: sessions.edits || 0,
      worked_on: rows.filter((r) => r.type === 'session').slice(0, 8).map((r) => ({ id: r.id, day: r.created_at.slice(0, 10), text: clipLine(r.body, 220) })),
      shipped: pick(['feature', 'bugfix', 'refactor'], 10),
      decisions: pick(['decision'], 8),
      gotchas: pick(['gotcha'], 5),
      todos_done: done,
      todos_open: d.prepare(`SELECT id, title FROM memories WHERE project = ? AND type = 'todo' AND status = 'open' AND superseded_at IS NULL ORDER BY id DESC LIMIT 8`).all(project),
    };
  });
  const u = usageSummary(days), r = recallStats(null, d);
  const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const savings = u.injected.times || u.saved.rereads || u.model.calls
    ? `Memory cost and savings: ~${k(u.injected.tokens)} tokens of context added over ${u.injected.times} loads, ~${k(u.saved.tokens)} tokens saved by ${u.saved.rereads} skipped re-read(s), ` +
      `${u.model.calls} background summary call(s)${r.shown ? `; Claude used ${Math.round(100 * r.rate)}% of the notes it was shown` : ''}.`
    : '';
  const out = [`threadkeeper: the last ${days} days`];
  if (savings) out.push(savings);
  if (!projects.length) out.push('Nothing recorded.');
  for (const p of projects) {
    out.push(`\n## ${p.name}  (${p.sessions} session(s), ${p.notes} new note(s))`);
    if (p.worked_on.length) { out.push('Worked on:'); for (const s of p.worked_on) out.push(`  ${s.day}  ${s.text}`); }
    if (p.shipped.length) { out.push('Done:'); for (const s of p.shipped) out.push(`  #${s.id} ${s.title}`); }
    if (p.decisions.length) { out.push('Decided:'); for (const s of p.decisions) out.push(`  #${s.id} ${s.title}`); }
    if (p.gotchas.length) { out.push('Learned the hard way:'); for (const s of p.gotchas) out.push(`  #${s.id} ${s.title}`); }
    if (p.todos_done.length) out.push(`Todos closed: ${p.todos_done.map((t) => t.title).join('; ')}`);
    if (p.todos_open.length) out.push(`Still open: ${p.todos_open.map((t) => t.title).join('; ')}`);
  }
  return { days, projects, savings, text: out.join('\n') };
}
