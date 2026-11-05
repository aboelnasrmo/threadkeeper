// Share a project's key knowledge with teammates through the repo: the brief, decisions and gotchas, written to
// .claude/team-memory.md. Claude Code loads it for everyone once CLAUDE.md imports it (`share --link` adds the line),
// so teammates' Claude benefits even without threadkeeper. Only live notes; refreshed by housekeeping once the file exists.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

export const SHARE_FILE = path.join('.claude', 'team-memory.md');
const IMPORT_LINE = '@.claude/team-memory.md';
const MAX_CHARS = 12000;

export function teamMemory(project, d = openDb()) {
  const brief = d.prepare(`SELECT body FROM memories WHERE project = ? AND type = 'brief' AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`).get(project);
  const pick = (type, n) => d.prepare(
    `SELECT title, body, created_at FROM memories WHERE project = ? AND type = ? AND superseded_at IS NULL AND stale_at IS NULL
     ORDER BY pinned DESC, used_count DESC, created_at DESC LIMIT ?`).all(project, type, n);
  const one = (m) => `- **${m.title}** (${m.created_at.slice(0, 10)}): ${m.body.replace(/\s+/g, ' ').slice(0, 300)}`;
  const out = [
    `# Team memory: ${path.basename(project)}`,
    '',
    '_Written by threadkeeper from past Claude Code sessions. Shared so every teammate\'s Claude knows the project\'s decisions and traps. ' +
      'Verify against the code before relying on it; edit the notes, not this file (it is regenerated)._',
  ];
  const ess = brief && /^##\s*Essentials\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(brief.body + '\n');
  if (ess) out.push('', '## Essentials', ess[1].trim());
  const decisions = pick('decision', 15), gotchas = pick('gotcha', 15);
  if (decisions.length) out.push('', '## Decisions', ...decisions.map(one));
  if (gotchas.length) out.push('', '## Gotchas', ...gotchas.map(one));
  let text = out.join('\n') + '\n';
  if (text.length > MAX_CHARS) text = text.slice(0, text.lastIndexOf('\n- ', MAX_CHARS)) + '\n';
  return { text, count: decisions.length + gotchas.length + (ess ? 1 : 0) };
}

/** Write (or refresh) the shared file. `link` also makes CLAUDE.md import it. */
export function share(project, { link = false } = {}) {
  const { text, count } = teamMemory(project);
  const file = path.join(project, SHARE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (before !== text) fs.writeFileSync(file, text);
  let linked = false;
  const claudeMd = path.join(project, 'CLAUDE.md');
  const cur = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
  if (cur.includes(IMPORT_LINE)) linked = true;
  else if (link) { fs.writeFileSync(claudeMd, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + `## Team memory\n${IMPORT_LINE}\n`); linked = true; }
  return { file, count, linked, changed: before !== text };
}

/** Housekeeping: keep an existing shared file current (never creates one). */
export function refreshShared(project) {
  if (!fs.existsSync(path.join(project, SHARE_FILE))) return false;
  return share(project).changed;
}
