// Connect Claude Desktop to threadkeeper: adds (or removes) the threadkeeper tools in claude_desktop_config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function desktopConfigPath() {
  if (process.env.THREADKEEPER_DESKTOP_CONFIG) return process.env.THREADKEEPER_DESKTOP_CONFIG;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return windowsConfigPath();
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

// Claude Desktop on Windows keeps its config in different places depending on how it was
// installed (%APPDATA%\Claude, %LOCALAPPDATA%\Claude-Data\<profile>, or a Store package).
// Prefer a config that already has threadkeeper, then the most recently changed one.
export function windowsConfigPath(env = process.env, home = os.homedir()) {
  const name = 'claude_desktop_config.json';
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const fallback = path.join(roaming, 'Claude', name);
  const found = [fallback];
  const sub = (dir, pick) => { try { for (const d of fs.readdirSync(dir)) if (pick(d)) found.push(pick(d) === true ? path.join(dir, d, name) : path.join(dir, d, pick(d), name)); } catch {} };
  sub(path.join(local, 'Claude-Data'), () => true);
  sub(path.join(local, 'Packages'), (d) => (/^Claude_/i.test(d) ? path.join('LocalCache', 'Roaming', 'Claude') : false));
  const real = found.filter((f) => fs.existsSync(f)).map((f) => {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch {}
    return { f, mine: text.includes('"threadkeeper"'), t: fs.statSync(f).mtimeMs };
  });
  real.sort((a, b) => (b.mine - a.mine) || (b.t - a.t));
  // No config yet: use an existing Desktop data folder rather than creating %APPDATA%\Claude.
  return real[0]?.f || found.slice(1).find((f) => fs.existsSync(path.dirname(f))) || fallback;
}

// Claude Desktop starts a small launcher in ~/.threadkeeper that runs the newest installed copy of
// the plugin, so Desktop picks up auto-updates too instead of staying on the clone it was set up from.
export function writeLauncher() {
  const home = process.env.THREADKEEPER_HOME || path.join(os.homedir(), '.threadkeeper');
  fs.mkdirSync(home, { recursive: true });
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.mjs');
  const file = path.join(home, 'desktop-mcp.mjs');
  fs.writeFileSync(file, `// Written by threadkeeper. Runs the newest installed threadkeeper MCP server for Claude Desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const FALLBACK = ${JSON.stringify(here)};
let target = FALLBACK;
try {
  const list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  const entries = Object.entries(list.plugins || {}).filter(([k]) => k.startsWith('threadkeeper@')).flatMap(([, v]) => v);
  entries.sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));
  for (const e of entries) {
    const f = e.installPath && path.join(e.installPath, 'src', 'mcp.mjs');
    if (f && fs.existsSync(f)) { target = f; break; }
  }
} catch {}
const mod = await import(pathToFileURL(target).href);
mod.serve();
`);
  return file;
}

export function desktop(action = 'install') {
  const file = desktopConfigPath();
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { cfg = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error(`${file} is not valid JSON; fix it first (nothing was changed).`); }
    if (!fs.existsSync(file + '.before-threadkeeper')) fs.writeFileSync(file + '.before-threadkeeper', raw); // keep the original, never overwrite it
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  cfg.mcpServers = cfg.mcpServers || {};
  if (action === 'remove') {
    delete cfg.mcpServers['threadkeeper'];
  } else {
    const script = writeLauncher();
    // Absolute node path: Claude Desktop does not load your shell PATH.
    cfg.mcpServers['threadkeeper'] = {
      command: process.execPath,
      args: ['--no-warnings', script],
      env: { THREADKEEPER_CLIENT: 'desktop', ...(process.env.THREADKEEPER_HOME ? { THREADKEEPER_HOME: process.env.THREADKEEPER_HOME } : {}) },
    };
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}
