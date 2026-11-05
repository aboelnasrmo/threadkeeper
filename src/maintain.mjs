#!/usr/bin/env node
// Background housekeeping for one project, started at most once a day from SessionStart:
//  - notes about files that git says were deleted are retired (no model call)
//  - near-duplicates and settled investigation chains are merged into one note (a model call only if any are found)
//  - untagged notes get search tags, in batches
//  - the project brief is refreshed if enough has changed
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, logError } from './config.mjs';
import { openDb, now, markSuperseded, updateMemory, filesOf } from './db.mjs';
import { redact, clip } from './redact.mjs';

const DAY = 86400000;
const getState = (d, k) => d.prepare('SELECT value FROM sync_state WHERE key = ?').get(k)?.value ?? null;
const setState = (d, k, v) => d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

export function maintenanceDue(d, project) {
  const last = getState(d, 'maint:' + project);
  return !last || Date.now() - Date.parse(last) > DAY;
}

/** Retire notes whose files were all deleted in git (and are still gone). Returns how many. */
export function retireDeletedFiles(project) {
  if (!fs.existsSync(path.join(project, '.git'))) return 0;
  const r = spawnSync('git', ['-C', project, 'log', '--diff-filter=D', '--name-only', '--pretty=format:', '--since=365.days'], {
    encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return 0;
  const deleted = new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).filter((f) => !fs.existsSync(path.join(project, f))));
  if (!deleted.size) return 0;
  const d = openDb();
  const rows = d.prepare(
    `SELECT DISTINCT m.id FROM memory_files f JOIN memories m ON m.id = f.memory_id
     WHERE m.project = ? AND m.superseded_at IS NULL AND m.pinned = 0 AND m.type NOT IN ('session','brief')`
  ).all(project);
  const retire = rows.filter((m) => {
    const files = filesOf(d, m.id);
    return files.length && files.every((f) => deleted.has(f));
  }).map((m) => m.id);
  return markSuperseded(d, project, retire, 'its files were deleted');
}

/**
 * Flag notes whose files were heavily rewritten since the note was written (at least half of each file's current
 * size and 30+ lines changed, for at least half of the note's files). Flagged notes are labelled wherever they are
 * shown, so Claude checks the code before trusting them. One git call per project. Returns how many changed state.
 */
export function flagStale(project) {
  if (!fs.existsSync(path.join(project, '.git'))) return 0;
  const d = openDb();
  const notes = d.prepare(
    `SELECT DISTINCT m.id, m.created_at, m.stale_at FROM memories m JOIN memory_files f ON f.memory_id = m.id
     WHERE m.project = ? AND m.superseded_at IS NULL AND m.type NOT IN ('session','brief','todo')`
  ).all(project);
  if (!notes.length) return 0;
  const oldest = notes.reduce((a, n) => (n.created_at < a ? n.created_at : a), notes[0].created_at);
  const r = spawnSync('git', ['-C', project, 'log', `--since=${oldest}`, '--numstat', '--format=@%cI', '--no-renames'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return 0;
  const changes = new Map(); // file -> [[time, lines], ...]
  let t = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@')) { t = Date.parse(line.slice(1)); continue; }
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (m) (changes.get(m[3]) || changes.set(m[3], []).get(m[3])).push([t, Number(m[1]) + Number(m[2])]);
  }
  const sizeCache = new Map();
  const lines = (f) => {
    if (!sizeCache.has(f)) {
      let n = 0;
      try { const st = fs.statSync(path.join(project, f)); n = st.size > 2e6 ? 1e9 : fs.readFileSync(path.join(project, f), 'utf8').split('\n').length; } catch {}
      sizeCache.set(f, n);
    }
    return sizeCache.get(f);
  };
  const filesQ = d.prepare('SELECT path FROM memory_files WHERE memory_id = ?');
  const set = d.prepare('UPDATE memories SET stale_at = ? WHERE id = ?');
  let n = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const note of notes) {
      const since = Date.parse(note.created_at);
      const files = filesQ.all(note.id).map((x) => x.path).filter((f) => !path.isAbsolute(f));
      if (!files.length) continue;
      const churned = files.filter((f) => {
        const changed = (changes.get(f) || []).filter(([ct]) => ct > since).reduce((a, [, l]) => a + l, 0);
        return changed >= 30 && changed >= 0.5 * Math.max(lines(f), 1);
      }).length;
      const stale = churned > 0 && churned >= files.length / 2;
      if (stale !== !!note.stale_at) { set.run(stale ? now() : null, note.id); n++; }
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return n;
}

const STOP = new Set('the and for with from that this was were are not into after before when then than its has have only still also which while about over now'.split(' '));
const words = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []).filter((w) => !STOP.has(w)));
function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const SETTLE_MS = 3 * DAY;
/**
 * Groups of live notes that should become one:
 *  - near-duplicates: same type, very similar titles, any age;
 *  - investigation chains: notes written within two days of each other about the same thing (shared file and
 *    overlapping title, or strongly overlapping title), once settled for 3 days. A debugging session leaves
 *    "suspect X", "X ruled out", "fixed by Y": one note with the final understanding is cheaper and clearer.
 * Each group is newest first; at most `maxGroups`, newest groups first.
 */
export function duplicateGroups(d, project, { threshold = 0.6, maxGroups = 25, maxSize = 8, skip = () => false } = {}) {
  const rows = d.prepare(
    `SELECT * FROM memories WHERE project = ? AND superseded_at IS NULL AND pinned = 0
       AND type NOT IN ('session','brief','todo') ORDER BY created_at, id LIMIT 4000`
  ).all(project);
  const settled = Date.now() - SETTLE_MS;
  const fileQ = d.prepare('SELECT path FROM memory_files WHERE memory_id = ?');
  const items = rows.map((r) => ({ r, w: words(r.title + ' ' + (r.tags && r.tags !== '-' ? r.tags : '')), tw: words(r.title), t: Date.parse(r.created_at), f: null }));
  const files = (it) => it.f || (it.f = new Set(fileQ.all(it.r.id).map((x) => x.path)));
  const parent = items.map((_, i) => i);
  const size = items.map(() => 1);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i, j) => { const x = find(i), y = find(j); if (x !== y && size[x] + size[y] <= maxSize) { parent[y] = x; size[x] += size[y]; } };
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.tw.size < 2) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.tw.size < 2) continue;
      if (a.r.type === b.r.type && jaccard(a.tw, b.tw) >= threshold) { join(i, j); continue; }
      if (b.t - a.t > 2 * DAY || b.t > settled) continue;
      const sim = jaccard(a.w, b.w);
      if (sim >= 0.4 || (sim >= 0.2 && [...files(a)].some((f) => files(b).has(f)))) join(i, j);
    }
  }
  const byRoot = new Map();
  items.forEach((it, i) => { const k = find(i); (byRoot.get(k) || byRoot.set(k, []).get(k)).push(it.r); });
  return [...byRoot.values()].filter((g) => g.length > 1 && !skip(g))
    .map((g) => g.sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : y.id - x.id)))
    .sort((x, y) => (x[0].created_at < y[0].created_at ? 1 : -1))
    .slice(0, maxGroups);
}

const MERGE_TYPES = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'gotcha', 'note']);

/** Merge near-duplicates: the newest note of each group gets the merged text, the rest are retired into it. */
export async function mergeDuplicates(project, cfg, { rounds = 1 } = {}) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const n = await mergeRound(project, cfg);
    total += n;
    if (!n) break;
  }
  return total;
}

async function mergeRound(project, cfg) {
  const d = openDb();
  // Groups the model chose not to merge are not offered again (until their notes change).
  const sig = (g) => 'nomerge:' + g.map((m) => m.id).sort((a, b) => a - b).join(',');
  const groups = duplicateGroups(d, project, { skip: (g) => getState(d, sig(g)) !== null });
  if (!groups.length) return 0;
  const { callClaude } = await import('./summarize.mjs');
  const prompt = `Each group below holds notes from a developer's past sessions about the same thing: repeats, or the steps
of one investigation. For each group write ONE note that a future session can act on: the final, current understanding
(what turned out true, what was done, what to do), keeping every concrete fact still worth knowing (names, paths, commands,
numbers, reasons). Where notes disagree or a later note revises an earlier one, the newer one wins; drop disproved guesses
unless "X was ruled out" saves future work. At most 900 characters per body. Pick the type that fits best from:
decision, bugfix, feature, refactor, discovery, gotcha, note.
Reply with ONLY a JSON object: {"merged": [{"group": 1, "type": "bugfix", "title": "...", "body": "..."}]}

${groups.map((g, i) => `GROUP ${i + 1}:\n${g.slice().reverse().map((m) => `- ${m.created_at.slice(0, 10)} [${m.type}] ${m.title}: ${clip(m.body.replace(/\s+/g, ' '), 500)}`).join('\n')}`).join('\n\n')}`;
  const text = callClaude(prompt, cfg, { timeout: 180_000, project });
  const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  let n = 0;
  const done = new Set();
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const m of Array.isArray(o.merged) ? o.merged : []) {
      const g = groups[Number(m.group) - 1];
      if (!g || done.has(g) || typeof m.title !== 'string' || typeof m.body !== 'string' || !m.body.trim()) continue;
      done.add(g);
      const [keep, ...rest] = g; // rows are newest first
      const type = MERGE_TYPES.has(m.type) ? m.type : keep.type;
      updateMemory(d, keep.id, { title: redact(m.title), body: redact(clip(m.body, 1500)), type });
      const add = d.prepare('INSERT OR IGNORE INTO memory_files(memory_id, path) VALUES (?, ?)');
      for (const r of rest) for (const f of filesOf(d, r.id)) add.run(keep.id, f);
      n += markSuperseded(d, project, rest.map((r) => r.id), keep.uid);
    }
    for (const g of groups) if (!done.has(g)) setState(d, sig(g), now());
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return n;
}

/** Give untagged notes (older ones, imported, synced from an older version) search tags. Batched and capped per run. */
export async function tagNotes(project, cfg, { batch = 60, maxCalls = 4 } = {}) {
  const d = openDb();
  const { callClaude } = await import('./summarize.mjs');
  let tagged = 0;
  for (let call = 0; call < maxCalls; call++) {
    const rows = d.prepare(
      `SELECT id, title, body FROM memories WHERE project = ? AND tags IS NULL AND superseded_at IS NULL AND type NOT IN ('brief')
       ORDER BY created_at DESC LIMIT ?`
    ).all(project, batch);
    if (!rows.length) break;
    const text = callClaude(
      `For each note below from a developer's past coding sessions, give 6-10 other words someone might search for to find it:
synonyms, the technologies, components and concepts involved, not already in the title. Reply with ONLY a JSON object
mapping note id to a space-separated string, e.g. {"12": "database postgres migration schema"}.

${rows.map((r) => `${r.id}: ${r.title} — ${clip(r.body.replace(/\s+/g, ' '), 220)}`).join('\n')}`, cfg, { timeout: 120_000, project });
    const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const st = d.prepare('UPDATE memories SET tags = ?, updated_at = ? WHERE id = ? AND project = ? AND tags IS NULL'); // updated_at: syncs, so the other machine doesn't pay for it again
    d.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const t = typeof o[r.id] === 'string' ? o[r.id].replace(/[^\p{L}\p{N}_ .,/+#-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        tagged += Number(st.run(t || '-', now(), r.id, project).changes); // '-' = looked at, nothing to add
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  return tagged;
}

export async function maintain(project, cfg = loadConfig()) {
  const d = openDb();
  setState(d, 'maint:' + project, now());
  const out = { retired: 0, merged: 0, tagged: 0 };
  try { out.retired = retireDeletedFiles(project); } catch (e) { logError('maintain deleted files', e); }
  try { out.stale = flagStale(project); } catch (e) { logError('maintain stale notes', e); }
  // Merging runs daily while there is something to merge (usually nothing, so no model call). The first run on a
  // project does more rounds, to work through imported history.
  const lastMerge = getState(d, 'merge:' + project);
  if (cfg.mergeDuplicates !== false) {
    setState(d, 'merge:' + project, now());
    try { out.merged = await mergeDuplicates(project, cfg, { rounds: lastMerge ? 3 : 5 }); } catch (e) { logError('maintain merge', e); }
  }
  if (cfg.tagNotes !== false) {
    // A big untagged backlog (imported history) is worked through faster: tags are what makes search find by meaning.
    const backlog = d.prepare(`SELECT count(*) n FROM memories WHERE project = ? AND tags IS NULL AND superseded_at IS NULL`).get(project).n;
    try { out.tagged = await tagNotes(project, cfg, { maxCalls: backlog > 300 ? 10 : 4 }); } catch (e) { logError('maintain tags', e); }
  }
  try { await (await import('./brief.mjs')).maybeRefreshBrief(project, cfg); } catch (e) { logError('brief', e); }
  if ((out.retired || out.merged || out.tagged) && cfg.syncDir) {
    try { (await import('./sync.mjs')).runSync(cfg, { force: true }); } catch (e) { logError('sync', e); }
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv[2]) maintain(process.argv[2]).catch((e) => logError('maintain', e));
