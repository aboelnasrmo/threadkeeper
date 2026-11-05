#!/usr/bin/env node
// threadkeeper command line. Run with no arguments for help.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { HOME, loadConfig, VERSION, claudeCommand } from './config.mjs';
import { openDb, projectFor, openTodos } from './db.mjs';

const [cmd, arg, ...rest] = process.argv.slice(2);
const HELP = `threadkeeper: personal memory for Claude Code

  viewer [port]            live web viewer (default http://localhost:37777)
  status                   counts, pending summaries, errors
  list [folder]            notes for a project (default: current folder)
  todos [folder]           open todos for a project
  forget [folder|--all]    wipe a project's memory, or everything
  summarize <session-id>   summarize a session now
  import-claude-mem [db]   import history from the original claude-mem (default ~/.claude-mem/claude-mem.db)
  desktop [remove]         give Claude Desktop the same memory (restart Desktop after)
  sync [folder]            sync notes with your other machines through a shared folder
  export [folder] [out]    write a project's memory as Markdown files (brief.md, decision.md, ...)
  usage [days]              tokens threadkeeper added to Claude's context and summary-model calls (default 7 days)
  brief [folder] [--refresh]   show (or rebuild) the project brief loaded at every session start
  import-claude-memory     bring in Claude Code's own memory files from every project on this machine
  recover [folder] [--all] [N]  rebuild sessions threadkeeper missed from Claude Code transcripts and summarize them
                           (default: since threadkeeper was installed, up to 3; --all = any age)
  encrypt [key]            encrypt synced notes: on the first machine with no key (prints the key),
                           then on each other machine with that key
  backup                   save a backup now (one is made automatically each day; last 7 kept)
  restore [YYYY-MM-DD]     list backups, or restore one (quit Claude Code and Desktop first)
  week [days]              what got done per project over the last 7 days
  doctor                   check that everything is wired up
`;

switch (cmd) {
  case 'encrypt': {
    const { syncKey, setSyncKey, runSync } = await import('./sync.mjs');
    const had = syncKey();
    if (arg) {
      const k = setSyncKey(arg);
      console.log(had && had.toString('base64url') !== k ? 'Sync key replaced.' : 'Sync key saved. This machine now reads and writes encrypted notes.');
    } else if (had) {
      console.log(`Encryption is on. The key (keep it in a password manager; run "encrypt <key>" on your other machines):\n\n  ${had.toString('base64url')}\n`);
    } else {
      const k = setSyncKey();
      console.log(`Encryption turned on. Your key (save it in a password manager; without it synced notes can't be read):\n\n  ${k}\n\nOn each other machine run:\n  node <threadkeeper folder>/src/cli.mjs encrypt ${k}`);
    }
    // An older threadkeeper may have skipped past sealed lines it couldn't read: read encrypted files again from the start.
    openDb().prepare(`DELETE FROM sync_state WHERE key LIKE 'offset:%.e1.jsonl'`).run();
    try { const r = runSync(loadConfig(), { force: true }); if (r) console.log(`Synced: ${r.received} received, ${r.sent} sent; this machine's file in the sync folder is now encrypted.`); }
    catch (e) { console.log(`(sync not run: ${e.message})`); }
    break;
  }
  case 'backup': {
    const { backup } = await import('./backup.mjs');
    console.log(`Saved ${backup()}`);
    break;
  }
  case 'restore': {
    const { listBackups } = await import('./backup.mjs');
    const all = listBackups();
    if (!arg) {
      if (!all.length) console.log('No backups yet.');
      for (const b of all) console.log(`${b.day}  ${(b.bytes / 1048576).toFixed(1)} MB  ${b.path}`);
      if (all.length) console.log('\nRestore one with: restore YYYY-MM-DD (quit Claude Code and Claude Desktop first)');
      break;
    }
    const b = all.find((x) => x.day === arg);
    if (!b) { console.error(`No backup from ${arg}.`); process.exit(1); }
    const live = path.join(HOME, 'memory.db');
    const keep = path.join(HOME, `memory.before-restore-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
    if (fs.existsSync(live)) {
      const { DatabaseSync } = await import('node:sqlite');
      const cur = new DatabaseSync(live);
      cur.exec(`VACUUM INTO '${keep.replace(/'/g, "''")}'`);
      cur.close();
    }
    // The background viewer keeps the database open (on Windows that blocks replacing it): ask it to stop first.
    try { await fetch(`http://127.0.0.1:${loadConfig().viewerPort || 37777}/api/restart`, { method: 'POST', headers: { 'x-threadkeeper': '1' }, signal: AbortSignal.timeout(1000) }); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    for (const f of ['memory.db-wal', 'memory.db-shm']) fs.rmSync(path.join(HOME, f), { force: true });
    fs.copyFileSync(b.path, live);
    console.log(`Restored the backup from ${b.day}.${fs.existsSync(keep) ? ` The database as it was is kept at ${keep}.` : ''}`);
    break;
  }
  case 'week': {
    const { weekReport } = await import('./week.mjs');
    console.log(weekReport(Number(arg) || 7).text);
    break;
  }
  case 'status': {
    const d = openDb();
    const c = (sql) => d.prepare(sql).get().n;
    console.log(`data folder: ${HOME}`);
    console.log(`sessions: ${c('SELECT count(*) n FROM sessions')}, memories: ${c('SELECT count(*) n FROM memories')}, events: ${c('SELECT count(*) n FROM events')}`);
    console.log(`open todos: ${c("SELECT count(*) n FROM memories WHERE type = 'todo' AND status = 'open'")}`);
    console.log(`pending summaries: ${c('SELECT count(*) n FROM sessions WHERE summarized = 0 AND ended_at IS NOT NULL')}`);
    for (const r of d.prepare('SELECT project, count(*) n FROM memories GROUP BY project ORDER BY n DESC').all())
      console.log(`  ${r.n.toString().padStart(4)}  ${r.project}`);
    const err = path.join(HOME, 'errors.log');
    if (fs.existsSync(err)) console.log(`errors logged: see ${err}`);
    break;
  }
  case 'list': {
    const project = projectFor(arg || process.cwd());
    for (const m of openDb().prepare('SELECT * FROM memories WHERE project = ? ORDER BY id DESC LIMIT 40').all(project))
      console.log(`#${m.id} ${m.created_at.slice(0, 10)} [${m.type}${m.status ? ', ' + m.status : ''}${m.superseded_at ? ', outdated' : ''}] ${m.title}\n    ${m.body}`);
    break;
  }
  case 'todos': {
    for (const t of openTodos(projectFor(arg || process.cwd()), 50)) console.log(`#${t.id} ${t.title}\n    ${t.body}`);
    break;
  }
  case 'forget': {
    const d = openDb();
    // Only sessions after this point may be rebuilt from Claude Code transcripts; otherwise forget would be undone.
    d.prepare("INSERT INTO sync_state(key, value) VALUES ('installed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
    if (arg === '--all') {
      d.exec('DELETE FROM memories; DELETE FROM events; DELETE FROM sessions; DELETE FROM injected_files; UPDATE tombstones SET remote = 1;');
      console.log('All memory wiped.');
    } else {
      const project = projectFor(arg || process.cwd());
      d.prepare('DELETE FROM sessions WHERE project = ?').run(project);
      d.prepare('DELETE FROM memories WHERE project = ?').run(project);
      d.exec('UPDATE tombstones SET remote = 1'); // a local wipe is not sent to your other machines
      console.log(`Memory wiped for ${project}`);
    }
    break;
  }
  case 'summarize': {
    const { summarizeSession } = await import('./summarize.mjs');
    console.log(summarizeSession(arg, loadConfig()));
    break;
  }
  case 'import-claude-mem': {
    const { importClaudeMem } = await import('./import-claude-mem.mjs');
    const r = importClaudeMem(arg && arg !== '--again' ? arg : undefined, { again: [arg, ...rest].includes('--again') });
    if (r.skipped) console.log(`Already imported (${r.already} notes). Pass --again to import a second copy.`);
    else {
      console.log(`Imported ${r.observations} observations and ${r.summaries} session summaries.`);
      console.log('They attach to a project the first time you open Claude Code in a folder with the same name:');
      for (const p of r.projects) console.log(`  ${String(p.n).padStart(5)}  ${p.project.replace('claude-mem:', '')}`);
    }
    break;
  }
  case 'usage': {
    const { usageSummary } = await import('./db.mjs');
    const u = usageSummary(Number(arg) || 7);
    console.log(`Last ${u.days} days:`);
    console.log(`  added to Claude's context: ~${u.injected.tokens.toLocaleString()} tokens over ${u.injected.times} injections`);
    console.log(`  saved by the re-read guard: ~${u.saved.tokens.toLocaleString()} tokens over ${u.saved.rereads} unchanged re-reads`);
    console.log(`  summary model (${loadConfig().model}): ${u.model.calls} calls, ~${u.model.tokensIn.toLocaleString()} tokens in, ~${u.model.tokensOut.toLocaleString()} tokens out`);
    break;
  }
  case 'export': {
    // Plain Markdown copy of a project's memory (brief + one file per note type), e.g. for Obsidian or a backup.
    const folder = arg && !arg.startsWith('--') ? arg : process.cwd();
    const project = projectFor(folder);
    const out = path.resolve(rest[0] || path.join(process.cwd(), 'threadkeeper-export', path.basename(project)));
    const d = openDb();
    const rows = d.prepare(`SELECT * FROM memories WHERE project = ? AND superseded_at IS NULL ORDER BY type, created_at DESC`).all(project);
    if (!rows.length) { console.log(`No notes for ${project}`); break; }
    fs.mkdirSync(out, { recursive: true });
    const byType = {};
    for (const m of rows) (byType[m.type] ||= []).push(m);
    for (const [type, list] of Object.entries(byType)) {
      const text = type === 'brief' ? list[0].body
        : `# ${type}\n\n` + list.map((m) => `## ${m.title}\n_${m.created_at.slice(0, 10)} · #${m.id}${m.pinned ? ' · pinned' : ''}${m.status ? ' · ' + m.status : ''}_\n\n${m.body}\n`).join('\n');
      fs.writeFileSync(path.join(out, `${type}.md`), text + '\n');
    }
    console.log(`Wrote ${Object.keys(byType).length} files (${rows.length} notes) to ${out}`);
    break;
  }
  case 'brief': {
    const flags = [arg, ...rest];
    const folder = arg && !arg.startsWith('--') ? arg : process.cwd();
    const project = projectFor(folder);
    const { currentBrief, refreshBrief } = await import('./brief.mjs');
    if (flags.includes('--refresh')) {
      console.log('Writing the brief with the summary model (can take a minute)…');
      const b = await refreshBrief(project, loadConfig());
      console.log(b || 'Nothing to write a brief from yet (or another process is writing it).');
    } else {
      const b = currentBrief(openDb(), project);
      console.log(b ? b.body : `No brief yet for ${project}. Run: brief --refresh`);
    }
    break;
  }
  case 'import-claude-memory': {
    const { importAllClaudeMemory } = await import('./recover.mjs');
    const r = importAllClaudeMemory();
    if (!r.length) console.log('No Claude Code memory files found.');
    for (const x of r) console.log(`${String(x.imported).padStart(4)} new or changed  ${x.project}`);
    break;
  }
  case 'recover': {
    const flags = [arg, ...rest];
    const folder = arg && !arg.startsWith('--') && !/^\d+$/.test(arg) ? arg : process.cwd();
    const project = projectFor(folder);
    const limit = Number(flags.find((f) => /^\d+$/.test(f || ''))) || 3;
    const { recoverMissed } = await import('./recover.mjs');
    const cfg = loadConfig();
    const rec = recoverMissed(project, cfg, { all: flags.includes('--all'), limit, olderThanMs: 0 });
    console.log(rec.length ? `Rebuilt ${rec.length} session(s) for ${project}; summarizing…` : `No missed sessions found for ${project}.`);
    const { summarizeSession } = await import('./summarize.mjs');
    for (const r of rec) {
      try { console.log(`  ${r.when.slice(0, 16)}  ${r.prompts} prompts, ${r.tools} tool calls → ${summarizeSession(r.id, cfg)} notes`); }
      catch (e) { console.log(`  ${r.id}: ${e.message}`); }
    }
    break;
  }
  case 'doctor': {
    const ok = (b, msg, fix) => console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `\n    → ${fix}` : ''}`);
    const [maj, min] = process.versions.node.split('.').map(Number);
    console.log(`threadkeeper ${VERSION} (${path.dirname(path.dirname(fileURLToPath(import.meta.url)))})`);
    ok(maj > 22 || (maj === 22 && min >= 13), `node ${process.versions.node}`, `needs Node 22.13+ (${process.platform === 'darwin' ? 'brew upgrade node' : 'install the current Node from nodejs.org'})`);
    let dbOk = true;
    try { openDb(); } catch { dbOk = false; }
    ok(dbOk, `database at ${path.join(HOME, 'memory.db')}`);
    const cc = claudeCommand();
    const c = spawnSync(cc.cmd, ['--version'], { encoding: 'utf8', shell: cc.shell, windowsHide: true });
    ok(c.status === 0, `claude CLI ${c.stdout?.trim() || 'not found'}`, 'summaries need the `claude` command on PATH');
    const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    let installed = false;
    try { installed = fs.readFileSync(pluginsFile, 'utf8').includes('threadkeeper'); } catch {}
    ok(installed, 'plugin installed in Claude Code', 'in Claude Code run /plugin, add the threadkeeper marketplace and install threadkeeper@threadkeeper');
    const cfgNow = loadConfig();
    ok(true, cfgNow.syncDir ? `sync folder: ${cfgNow.syncDir}` : 'sync: off (optional: sync <shared folder>)');
    if (cfgNow.syncDir) { const { syncKey } = await import('./sync.mjs'); ok(true, syncKey() ? 'synced notes are encrypted' : 'synced notes are NOT encrypted (optional: encrypt)'); }
    const { desktopConfigPath } = await import('./desktop.mjs');
    let desk = false;
    try { desk = fs.readFileSync(desktopConfigPath(), 'utf8').includes('"threadkeeper"'); } catch {}
    ok(true, desk ? `Claude Desktop connected (${desktopConfigPath()})` : 'Claude Desktop: not connected (optional: desktop)');
    const { listBackups } = await import('./backup.mjs');
    const bk = listBackups()[0];
    ok(true, bk ? `last backup: ${bk.day} (${listBackups().length} kept)` : 'backups: none yet (one is made at the next session start)');
    const { healthProblems } = await import('./health.mjs');
    const probs = healthProblems(cfgNow);
    for (const p of probs) ok(p.level !== 'warn', p.text);
    if (!probs.length) ok(true, 'no problems (no errors in the last 24 h, summaries and sync healthy)');
    break;
  }
  case 'sync': {
    const { runSync, machineId } = await import('./sync.mjs');
    const file = path.join(HOME, 'settings.json');
    if (arg === 'off' || (arg && arg !== 'now')) {
      const folder = arg === 'off' ? '' : path.resolve(arg.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (folder && !fs.existsSync(folder)) { console.log(`Folder not found: ${folder}`); process.exit(1); }
      const cur = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
      fs.writeFileSync(file, JSON.stringify({ ...cur, syncDir: folder }, null, 2) + '\n');
      if (!folder) { console.log('Sync turned off.'); break; }
      console.log(`Sync folder set: ${folder}`);
    }
    const cfg = loadConfig();
    if (!cfg.syncDir) { console.log('Sync is off. Turn it on with: sync <shared folder>'); break; }
    const r = runSync(cfg, { force: true });
    if (!r) console.log('Another sync is running; try again in a minute.');
    else console.log(`This machine: ${r.machine}\nFolder: ${r.dir}\nReceived ${r.received} changes, sent ${r.sent.notes} notes and ${r.sent.deletes} deletions.\nFrom now on it syncs by itself whenever Claude Code starts and after each summary.`);
    break;
  }
  case 'desktop': {
    const { desktop } = await import('./desktop.mjs');
    const file = desktop(arg === 'remove' ? 'remove' : 'install');
    console.log(arg === 'remove' ? `Removed threadkeeper from ${file}` : `Added threadkeeper to ${file}\nQuit and reopen Claude Desktop. Then ask it: "what's in threadkeeper for my-app?"`);
    console.log(`(previous config saved as ${file}.before-threadkeeper)`);
    break;
  }
  case 'viewer': {
    const { startViewer } = await import('./viewer.mjs');
    const port = Number(arg) || 37777;
    startViewer(port);
    const url = `http://localhost:${port}`;
    const [opener, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    try { spawn(opener, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
    break;
  }
  default:
    console.log(HELP);
}
