#!/usr/bin/env node
// Entry point for every Claude Code hook. Must never break Claude: all errors are logged and swallowed.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, logError, HOME, VERSION, samePathCase } from './config.mjs';
import { openDb, ensureSession, addEvent, projectFor, qualifies, pendingWork, now, relPath, EDIT_TOOLS, recordUsage, gitBranch } from './db.mjs';
import { redact, clip, isSensitivePath } from './redact.mjs';

const STALE_MS = 2 * 60 * 60 * 1000; // a session idle this long without SessionEnd counts as finished
const LOCK_MS = 5 * 60 * 1000;       // a summarizer lock older than this is from a crashed run
const locked = (s) => s.summarizing_since && Date.now() - Date.parse(s.summarizing_since) < LOCK_MS;
const expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** One short, redacted line describing a tool call. */
export function describeTool(name, input = {}, project) {
  let fp = input.file_path || input.notebook_path || input.path;
  if (fp && isSensitivePath(fp)) return `${relPath(project, fp)} (sensitive file, content not stored)`;
  if (fp) fp = relPath(project, fp);
  switch (name) {
    case 'Read':
      // Partial reads are marked so the re-read guard only trusts full reads.
      return (fp || '') + (input.offset || input.limit || input.pages ? ` [part]` : '');
    case 'Write':
      return `${fp} (${String(input.content ?? '').length} chars)`;
    case 'Edit':
      return `${fp}: ${clip(redact(input.new_string ?? ''), 240)}`;
    case 'MultiEdit':
      return `${fp}: ${(input.edits || []).length} edits; ${clip(redact(input.edits?.[0]?.new_string ?? ''), 200)}`;
    case 'NotebookEdit':
      return `${fp}: ${clip(redact(input.new_source ?? ''), 200)}`;
    case 'Bash':
      return clip(redact(input.command ?? ''), 300);
    case 'Grep':
    case 'Glob':
      return clip(`${input.pattern ?? ''}${fp ? ' in ' + fp : ''}`, 200);
    case 'WebFetch':
      return clip(input.url ?? '', 200);
    case 'WebSearch':
      return clip(input.query ?? '', 200);
    case 'Task':
    case 'Agent':
      return clip(redact(input.description ?? input.prompt ?? ''), 200);
    case 'TodoWrite':
      return clip((input.todos || []).map((t) => `[${t.status}] ${t.content}`).join('; '), 300);
    default:
      return clip(redact(JSON.stringify(input)), 200);
  }
}

// Tools that add noise without telling a future session anything.
const SKIP_TOOLS = /^(ToolSearch|mcp__(plugin_)?threadkeeper.*|TaskList|TaskGet|ListMcpResourcesTool)$/;

function spawnDetached(file, ...args) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), file);
  spawn(process.execPath, ['--no-warnings', script, ...args], {
    cwd: HOME, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, THREADKEEPER_DISABLE: '1' },
  }).unref();
}

export function spawnSummarizer(sessionId, mode = 'final') {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'summarize.mjs');
  const child = spawn(process.execPath, ['--no-warnings', script, sessionId, mode], {
    cwd: HOME,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, THREADKEEPER_DISABLE: '1' },
  });
  child.unref();
}

/** Keep the viewer running in the background: start it if nothing answers on its port. */
function ensureViewer(cfg) {
  if (!cfg.autoViewer) return;
  const port = Number(cfg.viewerPort) || 37777;
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.setTimeout(300);
  const start = () => {
    sock.destroy();
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer.mjs');
    spawn(process.execPath, ['--no-warnings', script, '--quiet'], {
      cwd: HOME, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, THREADKEEPER_DISABLE: '1', THREADKEEPER_PORT: String(port) },
    }).unref();
  };
  return new Promise((resolve) => {
    sock.once('connect', () => { sock.destroy(); replaceIfOld(port, start).finally(resolve); });
    sock.once('error', () => { start(); resolve(); });
    sock.once('timeout', () => { sock.destroy(); resolve(); });
  });
}

/** If the running viewer is from another threadkeeper version (e.g. before an auto-update), restart it. */
async function replaceIfOld(port, start) {
  const base = `http://127.0.0.1:${port}`;
  const ask = (p, opts = {}) => fetch(base + p, { ...opts, signal: AbortSignal.timeout(500) });
  try {
    const r = await ask('/api/version');
    const v = r.ok ? (await r.json()).version : null;
    if (v === VERSION) return;
    const bye = await ask('/api/restart', { method: 'POST', headers: { 'x-threadkeeper': '1' } });
    if (!bye.ok) return; // a viewer older than 0.4.4 can't be asked to stop; it is replaced after a reboot
    for (let i = 0; i < 20; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      try { await ask('/api/version'); } catch { return start(); }
    }
  } catch {}
}

/** Summarize finished sessions in this project that never got a summary (e.g. the terminal was closed). */
function catchUp(project, currentId, cfg) {
  const d = openDb();
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const rows = d.prepare(
    `SELECT * FROM sessions WHERE project = ? AND id != ? AND summarized = 0 AND summarize_attempts < 3
       AND (summarizing_since IS NULL OR summarizing_since < ?) AND (ended_at IS NOT NULL OR last_activity < ?)
     ORDER BY last_activity DESC LIMIT 3`
  ).all(project, currentId, new Date(Date.now() - LOCK_MS).toISOString(), cutoff);
  // Sessions left unsummarized in other projects shouldn't wait until that project is opened again
  // (the next session there would start without them). One at a time, newest first.
  rows.push(...d.prepare(
    `SELECT * FROM sessions WHERE project != ? AND id != ? AND summarized = 0 AND summarize_attempts < 3
       AND (summarizing_since IS NULL OR summarizing_since < ?) AND (ended_at IS NOT NULL OR last_activity < ?)
       AND last_activity > ? ORDER BY last_activity DESC LIMIT 1`
  ).all(project, currentId, new Date(Date.now() - LOCK_MS).toISOString(), cutoff, new Date(Date.now() - 14 * 86400000).toISOString()));
  for (const s of rows) {
    if (qualifies(s, cfg)) spawnSummarizer(s.id);
    else d.prepare(`UPDATE sessions SET summarized = CASE WHEN summarized_upto > 0 THEN 1 ELSE -1 END WHERE id = ?`).run(s.id);
  }
}

/** Memories imported from claude-mem are keyed by folder name; claim them for this project's full path. */
export function isNotAProject(p) {
  const r = path.resolve(p);
  return r === path.resolve(os.homedir()) || path.dirname(r) === r;
}

function adoptImported(project) {
  const d = openDb();
  const base = path.basename(project);
  for (const key of new Set(['claude-mem:' + base, 'sync:' + base, 'sync:' + base.toLowerCase()])) adoptKey(d, project, key);
}

function adoptKey(d, project, key) {
  if (!d.prepare(`SELECT 1 FROM memories WHERE project = ? LIMIT 1`).get(key)) return;
  d.exec('BEGIN IMMEDIATE');
  try {
    // Make absolute file paths inside this project relative, like threadkeeper stores them.
    d.prepare(
      `UPDATE OR IGNORE memory_files SET path = substr(path, ?) WHERE path LIKE ? AND memory_id IN (SELECT id FROM memories WHERE project = ?)`
    ).run(project.length + 2, project + '/%', key);
    d.prepare(
      `UPDATE OR IGNORE memory_files SET path = replace(substr(path, ?), '\\', '/') WHERE path LIKE ? AND memory_id IN (SELECT id FROM memories WHERE project = ?)`
    ).run(project.length + 2, project + '\\%', key);
    d.prepare(`UPDATE memories SET project = ? WHERE project = ?`).run(project, key);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Keep the raw activity log from growing forever; memories are kept. */
function prune(cfg) {
  const days = Number(cfg.keepActivityDays) || 0;
  if (days <= 0) return;
  const d = openDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  d.prepare(`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE last_activity < ? AND summarized != 0)`).run(cutoff);
  d.prepare(`DELETE FROM injected_files WHERE session_id IN (SELECT id FROM sessions WHERE last_activity < ?)`).run(cutoff);
}

let currentProject = null;
/** One line shown to the user (not to Claude) so it's visible that memory loaded. */
function statusLine(d, project, ctx, cfg) {
  const n = d.prepare(`SELECT count(*) n FROM memories WHERE project = ? AND superseded_at IS NULL`).get(project).n;
  if (!n && !ctx) return null;
  const brief = /## Project brief/.test(ctx || '');
  return `threadkeeper: ${n.toLocaleString()} notes for ${path.basename(project)}` +
    (ctx ? ` · loaded ${brief ? 'brief + ' : ''}~${Math.round(ctx.length / 4).toLocaleString()} tokens` : '') +
    (cfg.autoViewer ? ` · http://localhost:${cfg.viewerPort || 37777}` : '');
}

const emit = (eventName, text, status = null) => {
  if (text) recordUsage(currentProject, 'inject', text.length);
  if (text || status) process.stdout.write(JSON.stringify({
    ...(status ? { systemMessage: status } : {}),
    ...(text ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } } : {}),
  }));
};

async function main() {
  if (process.env.THREADKEEPER_DISABLE === '1') return;
  const event = process.argv[2];
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const raw = await readStdin();
  let input = {};
  try { input = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : {}; } catch { return; }
  const sessionId = input.session_id;
  if (!sessionId) return;
  const project = projectFor(input.cwd || process.cwd());
  // Home folder and drive roots aren't projects: notes there would sync as a user name or "C:".
  if (isNotAProject(project)) return;
  currentProject = project;
  const ci = (p) => samePathCase(path.resolve(p));
  if ((cfg.ignoreProjects || []).map(expandHome).some((p) => ci(project) === ci(p) || ci(project).startsWith(ci(p) + path.sep))) return;

  if (event === 'PreToolUse') {
    if (cfg.rereadGuard !== false && input.tool_name === 'Read') {
      const { rereadCheck } = await import('./reread.mjs');
      const reason = rereadCheck(project, sessionId, input, cfg);
      if (reason) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
        return;
      }
    }
    // Read-only and fast: show past notes the first time a file is touched this session.
    if (!cfg.fileContext) return;
    const fp = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (!fp || isSensitivePath(fp)) return;
    const { fileContext } = await import('./context.mjs');
    emit('PreToolUse', fileContext(project, sessionId, fp));
    return;
  }

  if (event === 'SubagentStart') {
    // Helper agents start blank and re-explore the code to find their way: give them the essentials up front.
    if (cfg.subagentContext === false) return;
    const { subagentContext } = await import('./context.mjs');
    emit('SubagentStart', subagentContext(project, cfg));
    return;
  }

  ensureSession(sessionId, project, input.transcript_path);
  const d = openDb();

  switch (event) {
    case 'SessionStart': {
      adoptImported(project);
      prune(cfg);
      await ensureViewer(cfg);
      if (cfg.syncDir) spawnDetached('sync.mjs');
      try { if (cfg.backup !== false && (await import('./backup.mjs')).backupDue(d)) spawnDetached('backup.mjs'); } catch (e) { logError('backup check', e); }
      const notices = [];
      if (cfg.importClaudeMemory) {
        try { (await import('./recover.mjs')).importClaudeMemory(project); } catch (e) { logError('import claude memory', e); }
      }
      if (cfg.recoverMissed && input.source !== 'compact') {
        try {
          const missed = (await import('./recover.mjs')).findMissed(project, cfg);
          if (missed.length) {
            spawnDetached('recover.mjs', project);
            notices.push(`threadkeeper found ${missed.length} earlier session(s) here that it never recorded (its hooks weren't running, usually because the app was opened before Node was installed: fully quit and reopen it). It is rebuilding them from Claude Code's transcripts now. Tell the user once.`);
          }
        } catch (e) { logError('find missed', e); }
      }
      catchUp(project, sessionId, cfg);
      try {
        const { healthProblems } = await import('./health.mjs');
        for (const p of healthProblems(cfg)) if (p.level === 'warn') notices.push(`threadkeeper problem: ${p.text}. Tell the user once.`);
      } catch (e) { logError('health', e); }
      try {
        // Housekeeping (retire notes about deleted files, merge near-duplicates weekly, refresh the brief) runs
        // in the background at most once a day, or sooner when the brief is due.
        const { needsBrief } = await import('./brief.mjs');
        const { maintenanceDue } = await import('./maintain.mjs');
        const { isScratch } = await import('./attribute.mjs');
        if (isScratch(project)) { /* Desktop scratch folders: nothing to maintain */ }
        else if (maintenanceDue(d, project)) spawnDetached('maintain.mjs', project);
        else if (needsBrief(d, project, cfg)) spawnDetached('brief.mjs', project);
      } catch (e) { logError('maintenance check', e); }
      try { d.prepare('UPDATE sessions SET branch = ? WHERE id = ?').run(gitBranch(project), sessionId); } catch {}
      const { buildContext } = await import('./context.mjs');
      const ctx = buildContext(project, cfg, { sessionId, source: input.source, notices });
      const status = cfg.showStatus === false ? null : statusLine(d, project, ctx, cfg);
      emit('SessionStart', ctx, status);
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = redact(input.prompt ?? '');
      if (prompt.trim()) addEvent(sessionId, 'prompt', null, clip(prompt, 1500));
      if (cfg.promptRecall && prompt.trim()) {
        const { promptContext } = await import('./context.mjs');
        emit('UserPromptSubmit', promptContext(project, sessionId, prompt, cfg.promptRecallMax));
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const name = input.tool_name || 'unknown';
      if (SKIP_TOOLS.test(name)) break;
      let detail = describeTool(name, input.tool_input || {}, project);
      if (name === 'Read' && input.agent_id) detail += ' [subagent]';
      if (event === 'PostToolUseFailure') detail = `FAILED: ${detail} → ${clip(redact(input.error ?? ''), 200)}`;
      addEvent(sessionId, 'tool', name, detail, { isEdit: EDIT_TOOLS.has(name) && event === 'PostToolUse' });
      break;
    }
    case 'Stop': {
      // Very long sessions: save a partial summary so nothing is lost if the session dies.
      // Checkpoints: long or long-running sessions save a partial summary (and sync it) as they go,
      // so a crash, a closed terminal or a switch to another machine loses nothing.
      const s = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      if (s && !locked(s)) {
        const w = pendingWork(s);
        const since = Date.parse(s.checkpoint_at || s.started_at);
        const timeUp = Date.now() - since > (Number(cfg.checkpointMinutes) || 20) * 60000;
        if (w.tools >= (Number(cfg.checkpointTools) || 40) || (timeUp && (w.edits > 0 || w.tools >= cfg.minToolCalls))) spawnSummarizer(sessionId, 'partial');
      }
      break;
    }
    case 'PreCompact': {
      d.prepare(`INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('compact:' + sessionId, now());
      // Synchronous on purpose: notes must be saved BEFORE the conversation is compacted,
      // so the SessionStart(compact) hook right after can hand them back.
      const s = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      if (s && !locked(s) && qualifies(s, cfg)) {
        const { summarizeSession } = await import('./summarize.mjs');
        try { summarizeSession(sessionId, cfg, { partial: true }); } catch (e) { logError('precompact', e); }
      }
      break;
    }
    case 'SessionEnd': {
      d.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now(), sessionId);
      d.prepare(`DELETE FROM injected_files WHERE session_id = ?`).run(sessionId);
      const s = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      if (!s) break;
      if (qualifies(s, cfg)) spawnSummarizer(sessionId);
      else d.prepare(`UPDATE sessions SET summarized = CASE WHEN summarized_upto > 0 THEN 1 ELSE -1 END WHERE id = ?`).run(sessionId);
      break;
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => logError(`hook ${process.argv[2]}`, e)).finally(() => process.exit(0));
}
