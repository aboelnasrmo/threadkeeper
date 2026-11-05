// Cross-platform smoke test (Windows, macOS, Linux): the main paths end to end, with a fake `claude`.
// The full suite is test/run.sh (bash); this one needs only Node, so CI runs it on every OS.
// Usage: node test/smoke.mjs
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOME = tmp('mm-home-');
fs.writeFileSync(path.join(HOME, 'settings.json'), JSON.stringify({ autoViewer: false }));
const PROJ = fs.realpathSync.native(tmp('mm-proj-'));
fs.mkdirSync(path.join(PROJ, '.git'));
fs.mkdirSync(path.join(PROJ, 'src', 'auth'), { recursive: true });
const ENV = { ...process.env, THREADKEEPER_HOME: HOME, THREADKEEPER_CLAUDE_BIN: path.join(ROOT, 'test', 'fakebin', 'claude.mjs'), THREADKEEPER_CLAUDE_PROJECTS: tmp('mm-cp-') };

let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + String(extra).slice(0, 600)}`); if (!ok) failures++; };
const node = (args, opts = {}) => spawnSync(process.execPath, ['--no-warnings', ...args], { encoding: 'utf8', env: { ...ENV, ...(opts.env || {}) }, input: opts.input, timeout: 60000 });
const hook = (event, session, body = {}, cwd = path.join(PROJ, 'src')) =>
  node([path.join(ROOT, 'src', 'hook.mjs'), event], { input: JSON.stringify({ session_id: session, cwd, ...body }) }).stdout;
const cli = (home, ...args) => node([path.join(ROOT, 'src', 'cli.mjs'), ...args], { env: { THREADKEEPER_HOME: home } }).stdout;
const q = (sql, home = HOME) => { const d = new DatabaseSync(path.join(home, 'memory.db')); try { return d.prepare(sql).all(); } finally { d.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch {} await sleep(150); } return false; }

// 1. Capture a session and summarize it.
hook('SessionStart', 's1');
hook('UserPromptSubmit', 's1', { prompt: 'fix the login validation' });
hook('PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src', 'auth', 'validate.ts'), new_string: 'x' } });
for (let i = 0; i < 5; i++) hook('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: `npm test ${i}` } });
hook('SessionEnd', 's1', { reason: 'exit' });
check(await waitFor(() => q("SELECT summarized FROM sessions WHERE id = 's1'")[0]?.summarized === 1), 'session is summarized', JSON.stringify(q('SELECT * FROM sessions')));
check(q("SELECT path FROM memory_files").some((r) => r.path === 'src/auth/validate.ts'), 'note files are stored relative, with / on every OS', JSON.stringify(q('SELECT path FROM memory_files')));

// 2. The next session starts with that memory.
const ctx = hook('SessionStart', 's2');
check(ctx.includes('Added login form validation'), 'next session gets the summary', ctx);

// 3. One folder is one project, whatever the letter case, on Windows and macOS.
if (process.platform === 'win32' || process.platform === 'darwin') {
  const flipped = PROJ.replace(/[a-z]/g, (c) => c.toUpperCase());
  if (flipped !== PROJ) {
    hook('SessionStart', 's3', {}, flipped);
    check(new Set(q('SELECT project FROM sessions').map((r) => r.project)).size === 1, 'path letter case does not split a project', JSON.stringify(q('SELECT project FROM sessions')));
  }
}

// 4. MCP search finds the note.
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'validation' } } });
const mcp = node([path.join(ROOT, 'src', 'mcp.mjs')], { input: init + '\n' + call + '\n', env: { CLAUDE_PROJECT_DIR: PROJ } });
check(/validation/i.test(mcp.stdout) && mcp.stdout.includes('"id":2'), 'MCP search', mcp.stdout + mcp.stderr);

// 5. Off the record: nothing is kept.
hook('UserPromptSubmit', 's4', { prompt: 'off the record please' });
hook('PostToolUse', 's4', { tool_name: 'Bash', tool_input: { command: 'cat salaries.csv' } });
check(q("SELECT count(*) n FROM events WHERE session_id = 's4'")[0].n === 0, 'off the record keeps nothing');

// 6. Viewer answers on localhost only, and refuses writes without its header.
const port = 38000 + Math.floor(Math.random() * 1000);
const viewer = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'viewer.mjs'), '--quiet'], { env: { ...ENV, THREADKEEPER_PORT: String(port) }, stdio: 'ignore' });
try {
  let home = null;
  for (let i = 0; i < 60 && !home; i++) { try { home = await (await fetch(`http://127.0.0.1:${port}/api/home`)).json(); } catch { await sleep(150); } }
  check(home && Array.isArray(home.activity) && home.activity.length === 30, 'viewer home API', JSON.stringify(home));
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  check(page.includes('id="detail"'), 'viewer page');
  const forbidden = await fetch(`http://127.0.0.1:${port}/api/memories/1/delete`, { method: 'POST' });
  check(forbidden.status === 403, 'viewer write guard');
} finally { viewer.kill(); }

// 7. Encrypted sync between two machines through a shared folder.
const SYNC = tmp('mm-sync-'), A = tmp('mm-a-'), B = tmp('mm-b-');
for (const h of [A, B]) fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ autoViewer: false }));
node(['--input-type=module', '-e', `import {openDb,insertMemory} from ${JSON.stringify(new URL('../src/db.mjs', import.meta.url).href)};
  insertMemory(openDb(),{project:${JSON.stringify(path.join(os.homedir(), 'projects', 'My-App'))},type:'gotcha',title:'Deploy needs VPN',body:'office VPN only'});`], { env: { THREADKEEPER_HOME: A } });
cli(A, 'sync', SYNC);
const key = (cli(A, 'encrypt').match(/^\s{2}(\S{30,})$/m) || [])[1];
check(!!key, 'encryption key printed');
check(fs.readdirSync(SYNC).some((f) => f.endsWith('.e1.jsonl')) && !fs.readdirSync(SYNC).filter((f) => f.endsWith('.jsonl')).some((f) => fs.readFileSync(path.join(SYNC, f), 'utf8').includes('VPN')), 'sync file is encrypted');
// Machine B has the same project in a different place and letter case.
node(['--input-type=module', '-e', `import {openDb} from ${JSON.stringify(new URL('../src/db.mjs', import.meta.url).href)};
  openDb().prepare("INSERT INTO sessions(id,project,started_at,last_activity) VALUES ('w1', ?, '2026', '2026')").run(${JSON.stringify(path.join(tmp('mm-elsewhere-'), 'my-app'))});`], { env: { THREADKEEPER_HOME: B } });
cli(B, 'encrypt', key || 'x');
cli(B, 'sync', SYNC);
check(q("SELECT project FROM memories WHERE title = 'Deploy needs VPN'", B).some((r) => /my-app$/.test(r.project)), 'synced note lands in the same project on the other machine', JSON.stringify(q('SELECT project, title FROM memories', B)));

// 8. Doctor runs.
check(/threadkeeper \d+\.\d+\.\d+/.test(cli(HOME, 'doctor')), 'doctor');

console.log(failures ? `\n${failures} check(s) failed on ${process.platform}` : `\nsmoke ok on ${process.platform}`);
process.exit(failures ? 1 : 0);
