#!/usr/bin/env node
// The living project brief: one page per project (architecture, current state, decisions, traps, open threads)
// that the summary model keeps up to date and that is loaded at the top of every session.
// Thousands of notes can't all fit in context; the brief is what makes them usable.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, logError } from './config.mjs';
import { openDb, now, insertMemory, updateMemory, markSuperseded } from './db.mjs';
import { redact, clip } from './redact.mjs';
import { isScratch } from './attribute.mjs';

const LOCK_MS = 10 * 60 * 1000;
const FIRST_BRIEF_MIN_NOTES = 6;

export function currentBrief(d, project) {
  return d.prepare(
    `SELECT * FROM memories WHERE project = ? AND type = 'brief' AND superseded_at IS NULL
     ORDER BY coalesce(updated_at, created_at) DESC LIMIT 1`
  ).get(project) || null;
}

const live = `superseded_at IS NULL AND type NOT IN ('brief') AND NOT (type = 'todo' AND status = 'done')`;

/** Notes the brief hasn't absorbed yet. */
function newNotes(d, project, since) {
  return d.prepare(
    `SELECT * FROM memories WHERE project = ? AND ${live} AND coalesce(updated_at, created_at) > ? ORDER BY created_at, id`
  ).all(project, since || '');
}

export function needsBrief(d, project, cfg) {
  if (!cfg.brief || isScratch(project) || project.startsWith('sync:') || project.startsWith('claude-mem:') || project === 'general') return false;
  const b = currentBrief(d, project);
  const n = d.prepare(
    `SELECT count(*) n FROM memories WHERE project = ? AND ${live} AND coalesce(updated_at, created_at) > ?`
  ).get(project, b ? b.updated_at || b.created_at : '').n;
  if (!b) return n >= FIRST_BRIEF_MIN_NOTES;
  return n >= (Number(cfg.briefEvery) || 12);
}

/** Pick what the model reads. First brief: the most useful slice of history. Refresh: what's new. */
function material(d, project, brief, budget) {
  let rows;
  if (brief) {
    // Overlap by 15 minutes so notes written while the last brief was being made aren't missed.
    const since = new Date(Date.parse(brief.updated_at || brief.created_at) - 15 * 60 * 1000).toISOString();
    rows = newNotes(d, project, since);
  } else {
    const pick = (sql, n) => d.prepare(`SELECT * FROM memories WHERE project = ? AND ${live} AND ${sql} ORDER BY created_at DESC LIMIT ${n}`).all(project);
    const seen = new Map();
    for (const r of [
      ...pick(`(pinned = 1 OR source IN ('manual','claude-memory'))`, 40),
      ...pick(`type IN ('decision','gotcha')`, 80),
      ...pick(`type = 'todo'`, 20),
      ...pick(`type = 'session'`, 40),
      ...pick(`type NOT IN ('session','todo','decision','gotcha')`, 120),
    ]) seen.set(r.id, r);
    rows = [...seen.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }
  // Newest material wins when over budget.
  const out = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const line = `#${r.id} ${r.created_at.slice(0, 10)} [${r.type}${r.status ? ', ' + r.status : ''}${r.pinned ? ', pinned' : ''}] ${r.title}: ${clip(r.body, 700)}`;
    if (used + line.length > budget) break;
    out.unshift(line);
    used += line.length;
  }
  return { lines: out, ids: new Set(rows.map((r) => r.id)) };
}

/** Recent commit subjects: what actually shipped, even in sessions threadkeeper didn't see. */
export function recentCommits(project, since, n = 40) {
  try {
    const args = ['-C', project, 'log', '--no-merges', '--date=short', '--pretty=format:%ad %s', '-n', String(n)];
    if (since) args.push(`--since=${since}`);
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean).map((l) => clip(redact(l), 160)) : [];
  } catch { return []; }
}

export function buildBriefPrompt(project, brief, lines, maxChars, commits = []) {
  return `You maintain the PROJECT BRIEF for ${path.basename(project)}: a single page a developer's Claude Code reads at the
start of every session so it never loses the thread of long-running work. Below are ${brief ? 'the current brief and the notes recorded since it was written' : 'notes from past sessions, oldest first'}.

${brief ? 'Update' : 'Write'} the brief. Markdown, at most ${maxChars} characters, with these sections (skip one only if there is nothing for it):
## Essentials              (at most 900 characters: what the project is, what is being worked on right now, the 3 traps
                            that cost the most time, and the command to build/run/deploy. This part loads in every session.)
## What this is            (1-3 sentences: purpose, stack, where it runs)
## Architecture and layout (key components, folders, how they connect; concrete names)
## Current state           (what works, what is in progress, latest milestones with dates)
## Decisions               (choice → reason; keep the ones still in force)
## Traps and gotchas       (non-obvious constraints that cost time before)
## Open threads            (unfinished work and next steps)
## How to work here        (commands, environments, deploy steps, conventions)

Rules: newer notes override older ones. Drop facts that later notes show are no longer true. Be concrete (file names,
commands, hosts, versions); no filler. Refer to notes as #id where a detail is worth looking up. Never include secrets.

Reply with ONLY a JSON object:
{ "brief": "the markdown", "outdated": [ids of notes below that later notes show are wrong or replaced] }
${brief ? `\nCURRENT BRIEF (updated ${String(brief.updated_at || brief.created_at).slice(0, 10)}):\n${brief.body}\n` : ''}
NOTES:
${lines.join('\n')}
${commits.length ? `\nRECENT GIT COMMITS (newest first; use them for "Current state"):\n${commits.join('\n')}` : ''}`;
}

export function parseBrief(text, maxChars) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON in brief response');
  const o = JSON.parse(text.slice(start, end + 1));
  if (typeof o.brief !== 'string' || o.brief.trim().length < 40) throw new Error('empty brief');
  return {
    brief: clip(o.brief.trim(), maxChars + 500),
    outdated: Array.isArray(o.outdated) ? o.outdated.map(Number).filter(Number.isInteger) : [],
  };
}

function claim(d, project) {
  const key = 'brief_lock:' + project;
  d.exec('BEGIN IMMEDIATE');
  try {
    const held = d.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value;
    if (held && Date.now() - Date.parse(held) < LOCK_MS) { d.exec('COMMIT'); return false; }
    d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, now());
    d.exec('COMMIT');
    return true;
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

/** Write or refresh the brief. Returns the new brief text, or null if another process is on it. */
export async function refreshBrief(project, cfg = loadConfig()) {
  const d = openDb();
  if (!claim(d, project)) return null;
  try {
    const { callClaude } = await import('./summarize.mjs');
    const brief = currentBrief(d, project);
    const maxChars = Number(cfg.briefMaxChars) || 7000;
    const { lines, ids } = material(d, project, brief, brief ? 24000 : 60000);
    if (!lines.length && brief) return brief.body;
    if (!lines.length) return null;
    const commits = recentCommits(project, brief ? String(brief.updated_at || brief.created_at).slice(0, 10) : null);
    const out = parseBrief(callClaude(buildBriefPrompt(project, brief, lines, maxChars, commits), cfg, { timeout: 300_000, project }), maxChars);
    const body = redact(out.brief);
    d.exec('BEGIN IMMEDIATE');
    try {
      let uid;
      if (brief) {
        updateMemory(d, brief.id, { body });
        uid = brief.uid;
      } else {
        const { id } = insertMemory(d, { project, type: 'brief', title: `Project brief: ${path.basename(project)}`, body, source: 'auto' });
        uid = d.prepare('SELECT uid FROM memories WHERE id = ?').get(id).uid;
      }
      // A brief from another machine may exist too: keep only the one just written.
      d.prepare(`UPDATE memories SET superseded_at = ?, superseded_by = ?, updated_at = ? WHERE project = ? AND type = 'brief' AND uid != ? AND superseded_at IS NULL`)
        .run(now(), uid, now(), project, uid);
      markSuperseded(d, project, out.outdated.filter((id) => ids.has(id)), 'project brief');
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    if (cfg.syncDir) import('./sync.mjs').then((m) => m.runSync(cfg, { force: true })).catch((e) => logError('sync', e));
    return body;
  } finally {
    d.prepare('DELETE FROM sync_state WHERE key = ?').run('brief_lock:' + project);
  }
}

export async function maybeRefreshBrief(project, cfg = loadConfig()) {
  if (needsBrief(openDb(), project, cfg)) return refreshBrief(project, cfg);
  return null;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const project = process.argv[2];
  if (project) maybeRefreshBrief(project).catch((e) => logError(`brief ${project}`, e));
}
