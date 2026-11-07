// Text injected into Claude's context: at session start, and when Claude opens a file it has history on.
import fs from 'node:fs';
import path from 'node:path';
import { openDb, openTodos, relPath, filesOf, RANK, openConflicts } from './db.mjs';
import { ignored } from './learn.mjs';
import { promptText } from './prompt.mjs';

const day = (iso) => iso.slice(0, 10);

const oneLine = (s, n) => short(String(s || '').replace(/\s+/g, ' ').trim(), n);

/**
 * The session's own task list, newest state: a project thread's progress checklist, TodoWrite, or TaskCreate/TaskUpdate.
 * Returns { open: [...], done: n } or null.
 */
export function taskState(d, sessionId) {
  const last = d.prepare(
    `SELECT tool, detail FROM events WHERE session_id = ? AND kind = 'tool' AND detail NOT LIKE 'FAILED:%'
       AND (tool = 'TodoWrite' OR tool LIKE '%update_progress_checklist') ORDER BY id DESC LIMIT 1`
  ).get(sessionId);
  const tasks = d.prepare(
    `SELECT tool, detail FROM events WHERE session_id = ? AND tool IN ('TaskCreate','TaskUpdate') AND detail NOT LIKE 'FAILED:%' ORDER BY id`
  ).all(sessionId);
  if (tasks.length && (!last || d.prepare(
    `SELECT max(id) a FROM events WHERE session_id = ? AND tool IN ('TaskCreate','TaskUpdate')`).get(sessionId).a >
    d.prepare(`SELECT max(id) a FROM events WHERE session_id = ? AND (tool = 'TodoWrite' OR tool LIKE '%update_progress_checklist')`).get(sessionId).a)) {
    // Task ids are handed out in order of creation (1, 2, 3…).
    const list = [];
    for (const t of tasks) {
      if (t.tool === 'TaskCreate') list.push({ text: t.detail.replace(/^\+\s*/, ''), status: 'pending' });
      else {
        const m = /^#(\S+)\s+(\w+)?/.exec(t.detail);
        const item = m && list[Number(m[1]) - 1];
        if (item && m[2]) item.status = m[2];
      }
    }
    const open = list.filter((t) => !/^(completed|deleted)$/.test(t.status)).map((t) => `[${t.status}] ${t.text}`);
    return { open, done: list.length - open.length };
  }
  if (!last) return null;
  if (last.tool === 'TodoWrite') {
    const items = last.detail.split(/;\s(?=\[)/).map((x) => x.trim()).filter(Boolean);
    const open = items.filter((x) => !/^\[completed\]/.test(x));
    return { open, done: items.length - open.length };
  }
  // Checklist: a header line, then one step per line starting with ✓ (done), ✱ (in progress) or ○ (not started).
  const lines = last.detail.split('\n').map((x) => x.trim()).filter(Boolean);
  const steps = lines.filter((x) => /^[✓✱○]/.test(x));
  const open = steps.filter((x) => !x.startsWith('✓'));
  const head = lines.find((x) => !/^[✓✱○]/.test(x));
  return { open, done: steps.length - open.length, head };
}

/** The user's latest requests in this session, newest first, without thread wrapper text. */
function recentRequests(d, sessionId, n, chars) {
  return d.prepare(`SELECT detail FROM events WHERE session_id = ? AND kind = 'prompt' ORDER BY id DESC LIMIT ?`).all(sessionId, n * 2)
    .map((p) => oneLine(promptText(p.detail), chars)).filter((p) => p.length > 1).slice(0, n);
}

function recentEdits(d, sessionId, n) {
  return [...new Set(d.prepare(
    `SELECT substr(detail, 1, instr(detail || ':', ':') - 1) f FROM events
     WHERE session_id = ? AND tool IN ('Edit','Write','MultiEdit','NotebookEdit') ORDER BY id DESC LIMIT 60`
  ).all(sessionId).map((r) => r.f.replace(/ \(\d+ chars\)$/, '')))].slice(0, n);
}

/**
 * Where this same session is now: used after a compaction so Claude picks up exactly where it was.
 * Short on purpose: the latest checkpoint (done / still open), the task list, the latest requests and files.
 * Older notes from the session are listed by title only; their full text is one `get` away.
 */
export function thisSession(d, sessionId, { previous = false } = {}) {
  const s = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) return '';
  const mems = d.prepare(`SELECT * FROM memories WHERE session_id = ? AND superseded_at IS NULL ORDER BY id DESC`).all(sessionId);
  const latest = mems.find((m) => m.type === 'session');
  // Open todos are listed in their own section of the same context, so they are not repeated here.
  const others = mems.filter((m) => m.type !== 'session' && m.type !== 'todo').slice(0, 12);
  const tasks = taskState(d, sessionId);
  const prompts = recentRequests(d, sessionId, 5, 300);
  const edited = recentEdits(d, sessionId, 12);
  const failed = d.prepare(
    `SELECT tool, detail FROM events WHERE session_id = ? AND detail LIKE 'FAILED:%' ORDER BY id DESC LIMIT 2`
  ).all(sessionId);
  if (!mems.length && !prompts.length && !edited.length && !tasks) return '';
  const out = [previous
    ? `## Where you left off (threadkeeper: this conversation continues the session of ${s.last_activity.slice(0, 16).replace('T', ' ')} UTC)`
    : '## Where you are now in this session (recorded by threadkeeper; survives compaction)'];
  if (prompts.length) {
    out.push(`Latest request from the user: ${prompts[0]}`);
    if (prompts.length > 1) out.push('Before that, newest first:\n' + prompts.slice(1).map((p) => `- ${p}`).join('\n'));
  }
  if (tasks?.open.length) out.push(`Your task list${tasks.head ? ` (${oneLine(tasks.head, 80)})` : ''}, still open${tasks.done ? ` (${tasks.done} done)` : ''}:\n` +
    tasks.open.slice(0, 10).map((t) => `- ${oneLine(t, 160)}`).join('\n'));
  if (latest) out.push(`Latest checkpoint (${latest.created_at.slice(11, 16)} UTC): ${oneLine(latest.body, 700)}`);
  if (edited.length) out.push(`Files changed recently: ${edited.join(', ')}`);
  if (failed.length) out.push(`Recent failures: ${failed.map((f) => `${f.tool} ${oneLine(f.detail.slice(8), 150)}`).join(' | ')}`);
  if (others.length) out.push(`Earlier notes from this session, newest first (may be out of date; \`get\` #id for detail): ` +
    others.map((m) => `#${m.id} ${oneLine(m.title, 70)}`).join('; '));
  return out.join('\n');
}

/**
 * A short reminder of the current task, added to the user's message in a very long conversation (deep in a big
 * context the goal set many turns ago gets lost, and with a 1M window a compaction may never come).
 * At most once every `anchorEvery` prompts, only above `anchorTokens` of context. ~100-250 tokens.
 */
export function anchorContext(d, sessionId, ctxTokens) {
  const tasks = taskState(d, sessionId);
  const latest = d.prepare(`SELECT * FROM memories WHERE session_id = ? AND type = 'session' AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(sessionId);
  const prompts = recentRequests(d, sessionId, 3, 200);
  const edited = recentEdits(d, sessionId, 8);
  if (!tasks?.open.length && !latest && prompts.length < 2) return '';
  const out = [`threadkeeper: this conversation is long (~${Math.round(ctxTokens / 1000)}k tokens). Where you are, so the current task stays in view:`];
  if (tasks?.open.length) out.push(`- Open steps: ${tasks.open.slice(0, 6).map((t) => oneLine(t, 100)).join(' | ')}`);
  if (latest) out.push(`- Last checkpoint (${latest.created_at.slice(11, 16)} UTC): ${oneLine(latest.body, 350)}`);
  if (prompts.length > 1) out.push(`- Earlier requests, newest first: ${prompts.slice(1).map((p) => `"${p}"`).join(' · ')}`);
  if (edited.length) out.push(`- Files changed lately: ${edited.join(', ')}`);
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

/** The transcript starts well before threadkeeper first saw this session: a resumed or forked copy of an older one. */
function carriesOlderHistory(d, sessionId) {
  const s = d.prepare('SELECT started_at, transcript_path FROM sessions WHERE id = ?').get(sessionId);
  if (!s?.transcript_path) return false;
  try {
    const fd = fs.openSync(s.transcript_path, 'r');
    const buf = Buffer.alloc(65536);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, len).toString('utf8'));
    return !!m && Date.parse(s.started_at) - Date.parse(m[1]) > 10 * 60000;
  } catch { return false; }
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
  let current = sessionId && compact ? thisSession(d, sessionId) : '';
  if (compact && sessionId && carriesOlderHistory(d, sessionId)) {
    // A resumed or forked conversation gets a new session id and carries the old one's history: threadkeeper has
    // (almost) nothing under the new id, so hand back where the session it continues left off.
    const prev = d.prepare(
      `SELECT id FROM sessions WHERE project = ? AND id != ? AND last_activity > ? AND (prompts > 0 OR tool_calls > 0)
       ORDER BY last_activity DESC LIMIT 1`
    ).get(project, sessionId, new Date(Date.now() - 2 * 86400000).toISOString());
    const before = prev ? thisSession(d, prev.id, { previous: true }) : '';
    if (before) current = [before, current.replace(/^## Where you are now[^\n]*\n?/, '### Since then\n')].filter((x) => x.trim() && x.trim() !== '### Since then').join('\n');
  }
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
  // Notes this same session wrote are still in context, except in a long session: ones written before its last
  // compaction, or hours ago, may be gone from view and can be recalled like any other note.
  const compacted = d.prepare('SELECT value FROM sync_state WHERE key = ?').get('compact:' + sessionId)?.value || '';
  const hoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
  const rows = d.prepare(
    `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ? AND m.project = ? AND (m.session_id IS NULL OR m.session_id != ? OR m.created_at < ? OR m.created_at < ?)
       AND (m.status IS NULL OR m.status = 'open') AND m.superseded_at IS NULL AND m.type NOT IN ('brief','session')
     ORDER BY ${RANK} LIMIT 12`
  ).all(terms.map((t) => `"${t}"*`).join(' OR '), project, sessionId, compacted, hoursAgo);
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
