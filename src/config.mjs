import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0'; }
})();
export const HOME = process.env.THREADKEEPER_HOME || path.join(os.homedir(), '.threadkeeper');

const DEFAULTS = {
  enabled: true,
  // A session is summarized only if it edited a file or made at least this many tool calls.
  minToolCalls: 5,
  // Model used for summaries (passed to `claude -p --model`).
  model: 'haiku',
  // How many recent session summaries to inject at session start, and a size cap.
  contextSessions: 4,
  contextMaxChars: 9000,
  contextLooseNotes: 6,
  // Max characters of session log sent to the summarizer.
  summarizeMaxChars: 10000,
  // Show past notes about a file the first time Claude reads or edits it in a session.
  fileContext: true,
  // Show up to N past notes that match each prompt you type.
  promptRecall: true,
  promptRecallMax: 2,
  // Folders (and everything under them) that are never recorded.
  ignoreProjects: [],
  // Raw activity log (not memories) older than this many days is deleted. 0 = keep forever.
  keepActivityDays: 60,
  // Start the web viewer (http://localhost:37777) automatically with the first Claude Code session.
  autoViewer: true,
  // Shared folder for syncing notes with your other machines (e.g. a Google Drive folder). Empty = off.
  syncDir: '',
  viewerPort: 37777,
  // Living project brief (architecture, current state, decisions, traps), loaded at every session start.
  // Refreshed by the summary model after this many new notes.
  brief: true,
  briefEvery: 20,
  briefMaxChars: 4500,
  // 'essentials' loads the brief's short Essentials section at start (full page on demand); 'full' loads it all.
  briefAtStart: 'essentials',
  // Save a checkpoint summary during long sessions: after this many tool calls, or this many minutes with real work.
  checkpointTools: 60,
  checkpointMinutes: 30,
  // When a search finds little, ask the summary model for related words and search again.
  smartSearch: true,
  // Bring in Claude Code's own memory files (~/.claude/projects/<project>/memory/*.md).
  importClaudeMemory: true,
  // Recover sessions threadkeeper missed (hooks not running) from Claude Code's transcripts.
  recoverMissed: true,
  // Stop Claude re-reading a file it already read in full this session when the file hasn't changed since
  // (its content is still in context). A second attempt always goes through. Files smaller than this are let through.
  // Show one line to you at session start ("threadkeeper: 1,328 notes · loaded brief + ~750 tokens").
  showStatus: true,
  // Background: give older notes search tags (a few batched model calls a day per project), so search matches by meaning.
  tagNotes: true,
  rereadGuard: true,
  rereadMinBytes: 3000,
  // Very long conversations: once the context passes anchorTokens, add a short "where you are" reminder
  // (task list, last checkpoint, recent requests, files) to every anchorEvery-th message. ~100-250 tokens each.
  taskAnchor: true,
  anchorTokens: 200000,
  anchorEvery: 6,
};

/**
 * How to start the `claude` CLI. On Windows an npm install puts a claude.cmd shim on PATH, which Node can't run
 * without a shell; the native installer gives claude.exe, which it can. Prefer claude.exe, else go through the shell
 * (arguments are fixed flags; the prompt goes on stdin).
 */
export function claudeCommand() {
  const bin = process.env.THREADKEEPER_CLAUDE_BIN; // tests: a fake claude (a Node script runs on every OS)
  if (bin) return /\.[cm]?js$/.test(bin) ? { cmd: process.execPath, pre: [bin], shell: false } : { cmd: bin, shell: false };
  if (process.platform !== 'win32') return { cmd: 'claude', shell: false };
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir.replace(/^"|"$/g, ''), 'claude.exe');
    try { if (fs.statSync(exe).isFile()) return { cmd: exe, shell: false }; } catch {}
  }
  return { cmd: 'claude', shell: true };
}

/** Paths on Windows and macOS are case-insensitive: compare them that way there. */
export const samePathCase = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));

export function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true });
  const file = path.join(HOME, 'settings.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try { fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n'); } catch {}
  }
  return { ...DEFAULTS, ...user };
}

export function logError(where, err) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(
      path.join(HOME, 'errors.log'),
      `${new Date().toISOString()} [${where}] ${err && err.stack ? err.stack : err}\n`
    );
  } catch {}
}
