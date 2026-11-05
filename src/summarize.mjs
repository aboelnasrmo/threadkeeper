#!/usr/bin/env node
// Detached worker: turns the not-yet-summarized part of a session into memories using `claude -p`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attributeProject } from './attribute.mjs';
import path from 'node:path';
import { loadConfig, logError } from './config.mjs';
import { openDb, now, insertMemory, openTodos, resolveTodos, MEMORY_TYPES, qualifies, markSuperseded, recordUsage, RANK } from './db.mjs';
import { redact, clip } from './redact.mjs';
import { assistantReplies } from './transcript.mjs';

const LOCK_MS = 5 * 60 * 1000;
const KINDS = MEMORY_TYPES.filter((t) => t !== 'session' && t !== 'brief');

// Looking things up tells a future session little; what changed, what ran and what failed does.
const LOOKUP_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead|TodoWrite|TaskCreate|TaskUpdate|TaskGet|TaskList|ToolSearch)$/;

export function buildLog(events, maxChars) {
  const lines = [];
  let last = null, repeat = 0, lookups = 0;
  const flush = () => {
    if (repeat > 1) lines[lines.length - 1] += ` ×${repeat}`;
    repeat = 0;
    if (lookups) { lines.push(`  - (${lookups} file reads/searches)`); lookups = 0; last = null; }
  };
  for (const e of events) {
    if (e.kind === 'prompt') { flush(); last = null; lines.push(`\nUSER: ${e.detail}`); continue; }
    if (LOOKUP_TOOLS.test(e.tool || '') && !String(e.detail).startsWith('FAILED')) { lookups++; continue; }
    const text = `  - ${e.tool}: ${e.detail}`;
    if (text === last) { repeat++; continue; }
    flush();
    lines.push(text); last = text; repeat = 1;
  }
  flush();
  let text = lines.join('\n');
  if (text.length > maxChars) text = '[earlier activity trimmed]\n' + text.slice(text.length - maxChars);
  return text;
}

/** Earlier notes this session may have changed: they match its prompts or the files it touched. */
export function relatedNotes(d, session, events, limit = 12) {
  const words = new Set();
  for (const e of events) {
    if (e.kind !== 'prompt') continue;
    for (const w of String(e.detail).toLowerCase().match(/[\p{L}\p{N}_]{5,}/gu) || []) words.add(w);
  }
  const files = new Set();
  for (const e of events) {
    if (e.kind === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool || '')) files.add(String(e.detail).split(/[:(]/)[0].trim());
  }
  const out = new Map();
  if (files.size) {
    const rows = d.prepare(
      `SELECT m.* FROM memory_files f JOIN memories m ON m.id = f.memory_id
       WHERE f.path IN (${[...files].map(() => '?').join(',')}) AND m.project = ? AND m.superseded_at IS NULL
         AND m.type NOT IN ('session','brief','todo') AND (m.session_id IS NULL OR m.session_id != ?)
       ORDER BY m.id DESC LIMIT ?`
    ).all(...files, session.project, session.id, limit);
    for (const r of rows) out.set(r.id, r);
  }
  const terms = [...words].slice(0, 20);
  if (terms.length && out.size < limit) {
    try {
      const rows = d.prepare(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.project = ? AND m.superseded_at IS NULL
           AND m.type NOT IN ('session','brief','todo') AND (m.session_id IS NULL OR m.session_id != ?)
         ORDER BY ${RANK} LIMIT ?`
      ).all(terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), session.project, session.id, limit);
      for (const r of rows) if (out.size < limit) out.set(r.id, r);
    } catch {}
  }
  return [...out.values()];
}

export function buildPrompt({ project, log, replies = [], todos = [], related = [], partial = false }) {
  const todoBlock = todos.length
    ? `\nOPEN TODOS from earlier sessions (id: title — detail):\n${todos.map((t) => `${t.id}: ${t.title} — ${clip(t.body, 200)}`).join('\n')}\n`
    : '';
  const relatedBlock = related.length
    ? `\nEARLIER NOTES on the same topics (id: title — detail). If this session shows one is now wrong or replaced, list it in "outdated":\n${related.map((m) => `${m.id}: ${m.title} — ${clip(m.body, 220)}`).join('\n')}\n`
    : '';
  const replyBlock = replies.length ? `\nCLAUDE'S REPLIES (most recent last):\n${replies.map((r) => `> ${r}`).join('\n')}\n` : '';
  return `You write memory notes for a developer's future Claude Code sessions in the project ${project}.
Below is ${partial ? 'the latest part of an ongoing session' : 'a log of one session'}: the user's prompts, the tools Claude used, and Claude's replies.

Write notes that will save time next session. Record what was built, fixed, decided or learned and WHY, with concrete
details (file names, commands, error messages, reasons). Skip anything trivial, routine, or easily re-discovered.
Do not describe the act of reading files; record what was learned from them.

Reply with ONLY a JSON object, no prose:
{
  "summary": "2-4 sentences: what was worked on, what got done, what is still unfinished",
  "memories": [
    { "type": "${KINDS.join('|')}", "title": "short and specific", "body": "1-3 sentences with the concrete details", "files": ["paths this note is about"], "pin": false, "everywhere": false,
      "tags": "6-10 other words someone might search for to find this note: synonyms, the technologies, components and concepts involved, not already in the title" }
  ],
  "resolved_todos": [ids of OPEN TODOS that this session clearly finished],
  "outdated": [ids of EARLIER NOTES that this session proved wrong or replaced (e.g. a setting changed, a bug's real cause found)]
}
Types: decision = design choice and its reason; bugfix = what broke, root cause, fix; feature = new capability;
refactor = restructure; discovery = how something works; gotcha = trap or non-obvious constraint; todo = unfinished work
the developer will want to pick up; note = anything else worth keeping.
When the user gave a standing instruction for future work ("always…", "never…", "from now on…", "don't ever…"), save it as
its own memory with "pin": true so it loads in every session. Use pin for nothing else. If that instruction is about how
the user wants Claude to work in general (how to talk to them, git and commit habits, asking before acting, tools, testing
habits) rather than about this project's code or setup, also set "everywhere": true so it applies in all their projects.
At most 6 memories. Only list resolved_todos and outdated ids you are sure about; when a note is outdated, write the
corrected fact as a new memory. Never include secrets.
${todoBlock}${relatedBlock}${replyBlock}
SESSION LOG:
${log}`;
}

export function parseResponse(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON in response: ' + text.slice(0, 200));
  const obj = JSON.parse(text.slice(start, end + 1));
  const memories = [];
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    memories.push({ type: 'session', title: 'Session summary', body: obj.summary.trim(), files: [] });
  }
  for (const m of Array.isArray(obj.memories) ? obj.memories.slice(0, 6) : []) {
    if (!m || typeof m.title !== 'string' || typeof m.body !== 'string' || !m.title.trim()) continue;
    memories.push({
      type: KINDS.includes(m.type) ? m.type : 'note',
      title: clip(m.title.trim(), 160),
      body: clip(m.body.trim(), 1200),
      files: Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string' && f.length < 300) : [],
      pin: m.pin === true && m.type !== 'todo',
      everywhere: m.pin === true && m.everywhere === true && m.type !== 'todo',
      tags: typeof m.tags === 'string' ? clip(m.tags.replace(/[^\p{L}\p{N}_ .,/+#-]/gu, ' ').replace(/\s+/g, ' ').trim(), 200) : null,
    });
  }
  const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
  const resolved = ids(obj.resolved_todos);
  const outdated = ids(obj.outdated);
  if (!memories.length && !resolved.length) throw new Error('empty summary');
  return { memories, resolved, outdated };
}

export function callClaude(prompt, cfg, { timeout = 180_000, project = 'general' } = {}) {
  const bin = process.env.THREADKEEPER_CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, ['-p', '--model', cfg.model, '--output-format', 'text'], {
    windowsHide: true,
    input: prompt,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, THREADKEEPER_DISABLE: '1' },
  });
  if (r.error) throw r.error;
  recordUsage(project, 'model', prompt.length, (r.stdout || '').length);
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
  return r.stdout;
}

/** Take the per-session lock so two summarizers never process the same events. */
function claim(d, sessionId) {
  const stale = new Date(Date.now() - LOCK_MS).toISOString();
  const r = d.prepare(
    `UPDATE sessions SET summarizing_since = ?, summarize_attempts = summarize_attempts + 1
     WHERE id = ? AND (summarizing_since IS NULL OR summarizing_since < ?)`
  ).run(now(), sessionId, stale);
  return Number(r.changes) === 1;
}

/** @param {{partial?: boolean}} opts partial = mid-session save (PreCompact / long session) */
export function summarizeSession(sessionId, cfg = loadConfig(), { partial = false } = {}) {
  const d = openDb();
  let s = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  if (!s) return 'missing';
  if (!qualifies(s, cfg)) {
    if (!partial) d.prepare(`UPDATE sessions SET summarized = CASE WHEN summarized_upto > 0 THEN 1 ELSE -1 END WHERE id = ?`).run(sessionId);
    return 'too-small';
  }
  if (!claim(d, sessionId)) return 'busy';
  s = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  try {
    const events = d.prepare(`SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id`).all(sessionId, s.summarized_upto);
    // Notes go to the project the work was about (see attribute.mjs), not always the folder Claude ran in.
    const project = attributeProject(s.project, events);
    const lastId = events.length ? events[events.length - 1].id : s.summarized_upto;
    const todos = openTodos(project, 15);
    const related = relatedNotes(d, { ...s, project }, events);
    const prompt = buildPrompt({
      related,
      project,
      log: buildLog(events, cfg.summarizeMaxChars),
      replies: assistantReplies(s.transcript_path, { since: events[0]?.ts, maxChars: 4000, perReply: 400 }),
      todos,
      partial,
    });
    const { memories, resolved, outdated } = parseResponse(callClaude(prompt, cfg, { project: project }));
    const relatedIds = new Set(related.map((m) => m.id));
    const todoIds = new Set(todos.map((t) => t.id));
    d.exec('BEGIN IMMEDIATE');
    try {
      let firstUid = null;
      for (const m of memories) {
        const { id } = insertMemory(d, { sessionId, project: m.everywhere ? 'general' : project, type: m.type, title: redact(m.title), body: redact(m.body), files: m.files, pinned: m.pin, tags: m.tags });
        if (!firstUid && m.type !== 'session') firstUid = d.prepare('SELECT uid FROM memories WHERE id = ?').get(id)?.uid;
      }
      markSuperseded(d, project, outdated.filter((id) => relatedIds.has(id)), firstUid || 'a later session');
      resolveTodos(d, project, resolved.filter((id) => todoIds.has(id)));
      d.prepare(
        `UPDATE sessions SET summarized = CASE WHEN ? THEN 0 ELSE 1 END, summarized_upto = ?, summarizing_since = NULL,
           summarize_attempts = 0, checkpoint_at = ? WHERE id = ?`
      ).run(partial ? 1 : 0, lastId, now(), sessionId);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
    try { if (cfg.syncDir) import('./sync.mjs').then((m) => m.runSync(cfg, { force: true })).catch((e) => logError('sync', e)); } catch {}
    return memories.length;
  } catch (e) {
    const gaveUp = s.summarize_attempts >= 3;
    d.prepare(`UPDATE sessions SET summarizing_since = NULL, summarized = CASE WHEN ? THEN -1 ELSE summarized END WHERE id = ?`)
      .run(gaveUp ? 1 : 0, sessionId);
    throw e;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [id, mode] = process.argv.slice(2);
  try {
    const cfg = loadConfig();
    summarizeSession(id, cfg, { partial: mode === 'partial' });
    const project = openDb().prepare('SELECT project FROM sessions WHERE id = ?').get(id)?.project;
    if (project) import('./brief.mjs').then((b) => b.maybeRefreshBrief(project, cfg)).catch((e) => logError('brief', e));
  } catch (e) {
    logError(`summarize ${id}`, e);
  }
}
