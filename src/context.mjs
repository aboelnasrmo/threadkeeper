// Text injected into Claude's context: at session start, and when Claude opens a file it has history on.
import path from 'node:path';
import { openDb, openTodos, relPath, filesOf, RANK, openConflicts } from './db.mjs';
import { ignored } from './learn.mjs';

const day = (iso) => iso.slice(0, 10);

/** What this same session already did: used after compaction or resume so Claude doesn't lose its place. */
function thisSession(d, sessionId) {
  const s = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) return '';
  const mems = d.prepare(`SELECT * FROM memories WHERE session_id = ? ORDER BY id`).all(sessionId);
  const prompts = d.prepare(
    `SELECT detail FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY id DESC LIMIT 12`
  ).all(sessionId).reverse();
  const edited = d.prepare(
    `SELECT DISTINCT substr(detail, 1, instr(detail || ':', ':') - 1) f FROM events
     WHERE session_id = ? AND tool IN ('Edit','Write','MultiEdit','NotebookEdit') ORDER BY id DESC LIMIT 25`
  ).all(sessionId).map((r) => r.f.replace(/ \(\d+ chars\)$/, ''));
  const failed = d.prepare(
    `SELECT tool, detail FROM events WHERE session_id = ? AND detail LIKE 'FAILED:%' ORDER BY id DESC LIMIT 3`
  ).all(sessionId);
  if (!mems.length && !prompts.length && !edited.length) return '';
  const out = ['## This session so far (recorded by threadkeeper; survives compaction)'];
  if (mems.length) {
    out.push('Notes saved earlier in this session:');
    for (const m of mems) out.push(m.type === 'session' ? `- ${m.body}` : `- [${m.type}${m.status === 'done' ? ', done' : ''}] ${m.title}: ${m.body} (#${m.id})`);
  }
  if (prompts.length) {
    out.push('The user\'s requests in this session, oldest first:');
    for (const p of prompts) out.push(`- ${p.detail.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (edited.length) out.push(`Files changed in this session: ${[...new Set(edited)].join(', ')}`);
  if (failed.length) out.push(`Recent failures: ${failed.map((f) => `${f.tool} ${f.detail.slice(8, 160)}`).join(' | ')}`);
  return out.join('\n');
}

const hasBrief = (d, project, cfg) => cfg.brief !== false &&
  !!d.prepare(`SELECT 1 FROM memories WHERE project = ? AND type = 'brief' AND superseded_at IS NULL LIMIT 1`).get(project);
/** The brief's Essentials section plus a table of contents; the full page is one `brief` call away. */
export function briefForContext(brief, cfg) {
  const when = day(brief.updated_at || brief.created_at);
  const body = brief.body;
  const m = /^##\s*Essentials\s*\n([\s\S]*?)(?=^##\s)/m.exec(body + '\n## ');
  if (cfg.briefAtStart === 'full' || !m) return `\n## Project brief (kept up to date by threadkeeper, last updated ${when})\n${body}`;
  const sections = [...body.matchAll(/^##\s*(.+)$/gm)].map((x) => x[1].trim()).filter((t) => !/^essentials$/i.test(t));
  return `\n## Project brief: essentials (last updated ${when})\n${m[1].trim()}\n` +
    (sections.length ? `Full brief has: ${sections.join(' · ')}. Read it with the threadkeeper \`brief\` tool before larger work in this project.` : '');
}

const short = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
/** Notes whose files were heavily rewritten since: still shown, but labelled so Claude checks the code first. */
const stale = (m) => (m.stale_at ? ' [files changed a lot since: check]' : '');

/** Remember which notes are already in Claude's context, so prompt and file recall never repeat them. */
function markShown(d, sessionId, ids) {
  if (!sessionId) return;
  const st = d.prepare(`INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)`);
  for (const id of ids) st.run(sessionId, 'mem:' + id);
}

/** On --resume the old conversation is back in context: only say what changed since. */
function resumeContext(d, project, sessionId, notices) {
  const lastSeen = d.prepare(`SELECT max(ts) t FROM events WHERE session_id = ?`).get(sessionId)?.t;
  const fresh = lastSeen ? d.prepare(
    `SELECT * FROM memories WHERE project = ? AND superseded_at IS NULL AND type NOT IN ('session') AND (session_id IS NULL OR session_id != ?)
       AND coalesce(updated_at, created_at) > ? ORDER BY coalesce(updated_at, created_at) DESC LIMIT 8`
  ).all(project, sessionId, lastSeen) : [];
  const out = [];
  if (notices.length) out.push('## threadkeeper notices\n' + notices.map((n) => `- ${n}`).join('\n'));
  if (fresh.length) {
    out.push(`## threadkeeper: new notes in ${path.basename(project)} since this session was last active (other sessions or machines)`);
    for (const m of fresh) out.push(m.type === 'brief' ? `- the project brief was updated (threadkeeper \`brief\` tool to read it)` : `- #${m.id} [${m.type}] ${m.title}: ${short(m.body, 200)}`);
    markShown(d, sessionId, fresh.map((m) => m.id));
  }
  return out.join('\n');
}

export function buildContext(project, cfg, { sessionId, source, notices = [] } = {}) {
  const d = openDb();
  const learn = cfg.learnFromUse !== false;
  if (source === 'resume' && sessionId) return resumeContext(d, project, sessionId, notices);
  // After compaction the conversation summary keeps the thread; add the brief, rules, todos and this session's own record.
  const compact = source === 'compact';
  if (compact && sessionId) {
    // Notes shown before compaction may be shown again; keep a record of them for learning which ones get used.
    d.prepare(`UPDATE OR IGNORE injected_files SET path = 'seen:' || substr(path, 5) WHERE session_id = ? AND path LIKE 'mem:%'`).run(sessionId);
    d.prepare(`DELETE FROM injected_files WHERE session_id = ? AND path LIKE 'mem:%'`).run(sessionId);
  }
  const current = sessionId && compact ? thisSession(d, sessionId) : '';
  // Todos untouched for a month are usually done or dropped: list them by count only (the `todos` tool shows them).
  const allTodos = openTodos(project, 40);
  const fresh = (t) => t.pinned || Date.now() - Date.parse(t.updated_at || t.created_at) < 30 * 86400000;
  const todos = allTodos.filter(fresh).slice(0, 8);
  const staleTodos = allTodos.filter((t) => !fresh(t)).length;
  const sessions = d.prepare(
    `SELECT session_id, max(created_at) at FROM memories WHERE project = ? AND session_id IS NOT NULL AND session_id != ? AND superseded_at IS NULL
     GROUP BY session_id ORDER BY at DESC LIMIT ?`
  ).all(project, sessionId || '', compact ? 0 : hasBrief(d, project, cfg) ? Math.min(2, cfg.contextSessions) : cfg.contextSessions);
  const manual = d.prepare(
    `SELECT * FROM memories WHERE project = ? AND superseded_at IS NULL AND type != 'brief' AND (pinned = 1 OR (source = 'manual' AND type != 'todo'))
     ORDER BY pinned DESC, id DESC LIMIT 15`
  ).all(project);
  // Notes that belong to no local session (synced from another machine, or imported) would
  // otherwise never load at startup, so the newest of them get their own section.
  const shownSessions = new Set(sessions.map((x) => x.session_id));
  const loose = d.prepare(
    `SELECT * FROM memories m WHERE project = ? AND type NOT IN ('todo','brief') AND superseded_at IS NULL AND pinned = 0 AND COALESCE(source, '') != 'manual'
       AND (session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id))
     ORDER BY created_at DESC, id DESC LIMIT 60`
  ).all(project).filter((m) => (!m.session_id || !shownSessions.has(m.session_id)) && !(learn && ignored(m))).slice(0, compact ? 0 : hasBrief(d, project, cfg) ? Math.min(3, cfg.contextLooseNotes ?? 6) : cfg.contextLooseNotes ?? 6);
  // The user's own preferences (rules saved "everywhere", or from Claude Code memory in the home folder) load in every project.
  const prefs = project === 'general' ? [] : d.prepare(
    `SELECT * FROM memories WHERE project = 'general' AND pinned = 1 AND superseded_at IS NULL AND type != 'todo' ORDER BY id DESC LIMIT 12`
  ).all();
  const brief = cfg.brief === false ? null : d.prepare(
    `SELECT * FROM memories WHERE project = ? AND type = 'brief' AND superseded_at IS NULL ORDER BY coalesce(updated_at, created_at) DESC LIMIT 1`
  ).get(project);
  const conflicts = openConflicts(d, project, 3);
  if (!sessions.length && !todos.length && !staleTodos && !prefs.length && !manual.length && !loose.length && !current && !brief && !notices.length && !conflicts.length) return '';

  const out = [
    `# threadkeeper: your notes from earlier sessions in ${path.basename(project)} (verify against the code before relying on them)`,
  ];
  let used = 0;
  const shown = [];
  const budget = cfg.contextMaxChars;
  const push = (s) => { if (used + s.length > budget) return false; out.push(s); used += s.length; return true; };

  if (notices.length) out.push('\n## threadkeeper notices\n' + notices.map((n) => `- ${n}`).join('\n'));
  if (current) { out.push('\n' + current); used += current.length; } // always included, outside the budget
  if (prefs.length) {
    push('\n## Your preferences (apply in every project)');
    for (const m of prefs) { if (!push(`- ${m.title}: ${short(m.body.replace(/\s+/g, ' '), 160)}`)) break; shown.push(m.id); }
  }
  if (brief) push(briefForContext(brief, cfg));
  if (conflicts.length) {
    push('\n## Notes that disagree (ask the user which is right when it matters for the work, then settle it with `settle_conflict`)');
    for (const c of conflicts) {
      push(`- conflict ${c.id}: older #${c.old_id} "${c.old_title}": ${short(c.old_body.replace(/\s+/g, ' '), 140)}` +
        (c.new_id ? ` | newer #${c.new_id} "${c.new_title}": ${short(c.new_body.replace(/\s+/g, ' '), 140)}` : '') + (c.why ? ` (${short(c.why, 140)})` : ''));
    }
  }

  if (todos.length) {
    push('\n## Open todos');
    for (const t of todos) { if (!push(`- #${t.id} ${t.title}: ${short(t.body, 120)}`)) break; shown.push(t.id); }
  }
  if (staleTodos) push(`${todos.length ? '' : '\n'}(${staleTodos} older open todo(s) not shown: \`todos\` tool lists them; close finished ones with \`resolve_todo\`.)`);
  if (manual.length) {
    push('\n## Pinned and remembered (always follow these)');
    for (const m of manual) { if (!push(`- #${m.id} ${m.title}: ${short(m.body.replace(/\s+/g, ' '), 220)}`)) break; shown.push(m.id); }
  }
  if (sessions.length) {
    push('\n## Recent sessions (newest first)');
    const byId = d.prepare(`SELECT * FROM memories WHERE session_id = ? AND type != 'todo' AND superseded_at IS NULL ORDER BY (type = 'session') DESC, id`);
    sessions.forEach((s, idx) => { s.idx = idx; });
    for (const s of sessions) {
      const lines = [`### ${day(s.at)}`];
      const ids = [];
      for (const m of byId.all(s.session_id)) {
        if (m.type !== 'session' && learn && ignored(m)) continue;
        if (s.idx === 0) ids.push(m.id);
        if (m.type === 'session') lines.push(short(m.body, s.idx === 0 ? 600 : 300));
        else if (s.idx === 0) lines.push(`- [${m.type}]${stale(m)} ${m.title}: ${short(m.body, 220)} #${m.id}`);
        else lines.push(`- ${m.title} #${m.id}`);
      }
      if (!push(lines.join('\n'))) break;
      shown.push(...ids);
    }
  }
  if (loose.length && used < budget) {
    push('\n## Other recent notes (from other machines or imported history, newest first)');
    for (const m of loose) {
      const body = short(m.body, 220);
      if (!push(`- ${day(m.created_at)} [${m.type}]${stale(m)} ${m.title}: ${body} #${m.id}`)) break;
      shown.push(m.id);
    }
  }
  out.push('\nMore: threadkeeper `search`, then `get` #ids.');
  markShown(d, sessionId, shown);
  return out.join('\n');
}

/** For a helper agent: the brief's essentials and the standing rules, nothing else (it has its own task). */
export function subagentContext(project, cfg) {
  const d = openDb();
  const brief = cfg.brief === false ? null : d.prepare(
    `SELECT * FROM memories WHERE project = ? AND type = 'brief' AND superseded_at IS NULL ORDER BY coalesce(updated_at, created_at) DESC LIMIT 1`
  ).get(project);
  const rules = d.prepare(
    `SELECT * FROM memories WHERE project IN (?, 'general') AND superseded_at IS NULL AND pinned = 1 AND type NOT IN ('brief','todo')
     ORDER BY project = 'general', id DESC LIMIT 12`
  ).all(project);
  if (!brief && !rules.length) return '';
  const out = [`# Project notes for ${path.basename(project)} (from threadkeeper; verify against the code)`];
  if (brief) {
    const m = /^##\s*Essentials\s*\n([\s\S]*?)(?=^##\s)/m.exec(brief.body + '\n## ');
    out.push(m ? m[1].trim() : short(brief.body, 1500));
  }
  if (rules.length) {
    out.push('Standing rules:');
    for (const r of rules) out.push(`- ${r.title}: ${short(r.body.replace(/\s+/g, ' '), 160)}`);
  }
  out.push('More history: the threadkeeper `search` tool.');
  return out.join('\n');
}

/** Notes about one file, shown once per session the first time Claude reads or edits it. */
export function fileContext(project, sessionId, filePath) {
  const d = openDb();
  const rel = relPath(project, filePath);
  if (!rel) return '';
  const seen = d.prepare(`INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)`).run(sessionId, rel);
  if (Number(seen.changes) === 0) return '';
  const rows = d.prepare(
    `SELECT m.* FROM memory_files f JOIN memories m ON m.id = f.memory_id
     WHERE f.path = ? AND m.project = ? AND m.type NOT IN ('session','brief') AND m.superseded_at IS NULL AND (m.status IS NULL OR m.status = 'open')
       AND NOT EXISTS (SELECT 1 FROM injected_files i WHERE i.session_id = ? AND i.path = 'mem:' || m.id)
     ORDER BY (m.type IN ('gotcha','decision')) DESC, m.pinned DESC, m.id DESC LIMIT 3`
  ).all(rel, project, sessionId).filter((m) => !ignored(m));
  if (!rows.length) return '';
  markShown(d, sessionId, rows.map((m) => m.id));
  return [
    `threadkeeper: past notes about ${rel}`,
    ...rows.map((m) => `- #${m.id} ${day(m.created_at)} [${m.type}]${stale(m)} ${m.title}: ${short(m.body.replace(/\s+/g, ' '), 160)}`),
  ].join('\n');
}

const STOP = new Set(('this that with from have what when where which will would could should there their them they then than ' +
  'into about just like make made does done also some more most other your yours please need want help look check work file files ' +
  'code thing things know think sure okay fine right left still again maybe really very much many each every here only over').split(' '));

export function promptTerms(prompt) {
  const words = String(prompt).toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 16);
}

/** Past notes that match what the user just asked, shown once per session each. */
export function promptContext(project, sessionId, prompt, max = 3) {
  if (String(prompt).trim().length < 15) return ''; // "ok", "yes", "go on": nothing to recall
  const terms = promptTerms(prompt);
  if (!terms.length) return '';
  const d = openDb();
  const rows = d.prepare(
    `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ? AND m.project = ? AND (m.session_id IS NULL OR m.session_id != ?)
       AND (m.status IS NULL OR m.status = 'open') AND m.superseded_at IS NULL AND m.type != 'brief'
     ORDER BY ${RANK} LIMIT 12`
  ).all(terms.map((t) => `"${t}"*`).join(' OR '), project, sessionId);
  // Precision over recall: a weak match costs tokens on every prompt and teaches Claude to ignore these notes.
  // A note must share a good part of the request's words, and at least one of them must be in its title.
  const need = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.4));
  const stem = (t) => t.slice(0, Math.max(4, t.length - 2));
  const mark = d.prepare(`INSERT OR IGNORE INTO injected_files(session_id, path) VALUES (?, ?)`);
  const picked = [];
  for (const m of rows) {
    const title = (m.title + ' ' + (m.tags || '')).toLowerCase();
    const text = title + ' ' + m.body.toLowerCase();
    if (terms.filter((t) => text.includes(stem(t))).length < need) continue;
    if (!terms.some((t) => title.includes(stem(t)))) continue;
    if (ignored(m)) continue;
    if (Number(mark.run(sessionId, 'mem:' + m.id).changes) === 0) continue; // already shown this session
    picked.push(m);
    if (picked.length >= max) break;
  }
  if (!picked.length) return '';
  return [
    'threadkeeper notes that may help (verify; `get` #id for more):',
    ...picked.map((m) => `- #${m.id} ${day(m.created_at)} [${m.type}]${stale(m)} ${m.title}: ${short(m.body.replace(/\s+/g, ' '), 140)}`),
  ].join('\n');
}

export { filesOf };
