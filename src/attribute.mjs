// Work done in one folder is often about another project ("cd ~/projects/x && ..." from another repo, or a Claude Desktop
// scratch folder editing a real repo). Notes belong to the project the files live in, or they pollute the wrong
// project's context and can't be found from the right one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFor } from './db.mjs';

const isNotAProject = (p) => { const r = path.resolve(p); return r === path.resolve(os.homedir()) || path.dirname(r) === r; };
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Claude Desktop scratch workspaces: places where work happens but no project lives. */
export const isScratch = (p) => /[\\/](scratch-workspaces|local-agent-mode-sessions)[\\/]/i.test(String(p));

/** Absolute paths an event touched (the file of a file tool, `cd /x` in a shell command). */
export function eventPaths(e) {
  const out = [];
  const d = String(e.detail || '');
  if (e.tool && e.tool !== 'Bash') {
    const m = /^((?:[A-Za-z]:[\\/]|\/)[^:\n]*?)(?::\s| \(\d+ chars\)| \[part\]| \[subagent\]| \(sensitive|$)/.exec(d);
    if (m) out.push(m[1]);
  } else if (e.tool === 'Bash') {
    for (const m of d.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/g)) out.push(m[2] || m[3] || m[4]);
  }
  return out.map((p) => p.replace(/^~(?=$|[\\/])/, os.homedir())).filter((p) => path.isAbsolute(p));
}

const rootCache = new Map();
function rootOf(p) {
  let dir = p;
  try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { dir = path.dirname(p); }
  if (rootCache.has(dir)) return rootCache.get(dir);
  let r = null;
  if (fs.existsSync(dir)) {
    const root = projectFor(dir);
    if (fs.existsSync(path.join(root, '.git')) && !isNotAProject(root) && !isScratch(root)) r = root;
  }
  rootCache.set(dir, r);
  return r;
}

/**
 * The project a session's notes belong to: its own, unless clearly most of its file work (edits count 3×) was
 * inside one other git repo. Returns the session's project when unsure.
 */
export function attributeProject(project, events) {
  const weight = new Map();
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'tool') continue;
    const w = EDITS.has(e.tool) ? 3 : 1;
    const paths = eventPaths(e);
    if (!paths.length) {
      // Relative paths in file tools are inside the session's own project.
      if (e.tool && e.tool !== 'Bash' && /^[^/\\\s][^:]*\.[A-Za-z0-9]+/.test(String(e.detail || ''))) { weight.set(project, (weight.get(project) || 0) + w); total += w; }
      continue;
    }
    for (const p of paths) {
      const root = p === project || p.startsWith(project + path.sep) || p.startsWith(project + '/') ? project : rootOf(p);
      if (!root) continue;
      weight.set(root, (weight.get(root) || 0) + w);
      total += w;
    }
  }
  let best = project, bestW = 0;
  for (const [r, w] of weight) if (r !== project && w > bestW) { best = r; bestW = w; }
  const own = weight.get(project) || 0;
  // Scratch folders have nothing of their own: any real repo they worked in wins.
  if (best !== project && (isScratch(project) ? bestW >= 3 : bestW >= 6 && bestW >= 0.6 * total && bestW > 2 * own)) return best;
  return project;
}
