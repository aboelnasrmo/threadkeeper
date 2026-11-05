// Scale check: N notes across projects, then time the hot paths. Usage: THREADKEEPER_HOME=<tmp> node --no-warnings test/bench.mjs [N]
import fs from 'node:fs';
import path from 'node:path';
import { openDb, insertMemory } from '../src/db.mjs';
import { search } from '../src/mcp.mjs';
import { buildContext, promptContext, fileContext } from '../src/context.mjs';
import { loadConfig, HOME } from '../src/config.mjs';

const N = Number(process.argv[2]) || 100000;
const d = openDb();
const words = 'auth login token cache redis sqlite deploy vpn docker build swift flutter quran audio player timeline api webhook payment invoice regex email parser router layout theme crash memory leak index query migration'.split(' ');
const w = (i, k) => Array.from({ length: k }, (_, j) => words[(i * 7 + j * 13) % words.length]).join(' ');
const types = ['decision', 'bugfix', 'feature', 'discovery', 'gotcha', 'note', 'session'];
let t = Date.now();
d.exec('BEGIN');
for (let i = 0; i < N; i++) {
  insertMemory(d, { sessionId: null, project: `/p/proj${i % 20}`, type: types[i % types.length], title: `${w(i, 4)} #${i}`,
    body: `${w(i + 3, 40)} details ${i}`, files: [`src/${words[i % words.length]}/${i % 300}.ts`] });
}
d.exec('COMMIT');
const insertMs = Date.now() - t;
const time = (label, fn, reps = 20) => { const s = process.hrtime.bigint(); for (let i = 0; i < reps; i++) fn(i); console.log(`${label.padEnd(34)} ${(Number(process.hrtime.bigint() - s) / 1e6 / reps).toFixed(1)} ms`); };
const cfg = loadConfig();
console.log(`inserted ${N} notes in ${(insertMs / 1000).toFixed(1)}s; db ${(fs.statSync(path.join(HOME, 'memory.db')).size / 1e6).toFixed(0)} MB (+wal)`);
time('search (one project)', (i) => search({ query: 'login token regex' }, `/p/proj${i % 20}`));
time('search (all projects)', () => search({ query: 'docker deploy vpn', all_projects: true }, '/p/proj1'));
time('session-start context', (i) => buildContext(`/p/proj${i % 20}`, cfg, {}));
time('per-prompt recall', (i) => promptContext(`/p/proj${i % 20}`, 'bench' + i, 'why does the login token cache break after deploy?'));
time('file-open recall', (i) => fileContext(`/p/proj${i % 20}`, 'bench-f' + i, `src/auth/${i % 300}.ts`));
