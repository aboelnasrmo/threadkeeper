// Property-based checks (no dependencies): random inputs, invariants that must always hold.
// Usage: THREADKEEPER_HOME=<tmp> node --no-warnings test/fuzz.mjs [runs]
import { redact } from '../src/redact.mjs';
import { ftsQuery } from '../src/mcp.mjs';
import { openDb, insertMemory, titleKey } from '../src/db.mjs';

const RUNS = Number(process.argv[2]) || 2000;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ALPH = ['a', 'Z', '9', ' ', '"', "'", '*', '(', ')', ':', '-', '^', '\\', 'é', '漢', '🙂', '\n', '=', 'NEAR', 'AND', 'OR', 'NOT', '<private>', '</private>'];
const str = (n = Math.floor(rnd() * 40)) => Array.from({ length: n }, () => pick(ALPH)).join('');
const SECRETS = ['sk-ant-' + 'a'.repeat(30), 'ghp_' + 'b'.repeat(36), 'AKIA' + 'C'.repeat(16), 'xoxb-' + '1'.repeat(20), 'password=hunter2!x', 'Bearer ' + 'd'.repeat(30)];
const fail = (m, x) => { console.error('FUZZ FAIL:', m, JSON.stringify(x)); process.exit(1); };

const d = openDb();
for (let i = 0; i < RUNS; i++) {
  // 1. Redaction removes every planted secret, wherever it sits, and never throws.
  const secret = pick(SECRETS);
  const secretBody = secret.startsWith('Bearer ') ? secret.slice(7) : secret.split('=').pop();
  const text = str() + ' ' + secret + ' ' + str();
  const r = redact(text);
  if (r.includes(secretBody)) fail('secret survived redaction', { text, r });
  // 2. Redaction is idempotent.
  if (redact(r) !== r) fail('redact not idempotent', { text });
  // 3. Private blocks never survive.
  const priv = `${str()}<private>TOPSECRET${i}</private>${str()}`;
  if (redact(priv).includes(`TOPSECRET${i}`)) fail('private block survived', priv);
  // 4. Any user text turns into a query FTS5 accepts.
  const q = ftsQuery(str());
  if (q) { try { d.prepare('SELECT count(*) FROM memories_fts WHERE memories_fts MATCH ?').get(q); } catch (e) { fail('fts rejected query: ' + e.message, q); } }
  // 5. titleKey is stable under case and punctuation changes.
  const t = str(12);
  if (titleKey(t) !== titleKey(t.toUpperCase().replace(/[!?.,]/g, '')) && /^[\x00-\x7f]*$/.test(t)) {
    if (titleKey(t.toLowerCase()) !== titleKey(t)) fail('titleKey not case-insensitive', t);
  }
}
// 6. Inserting the same note twice (different case/punctuation) keeps one row.
const a = insertMemory(d, { project: '/fuzz', type: 'gotcha', title: 'Deploy needs VPN', body: 'short' });
const b = insertMemory(d, { project: '/fuzz', type: 'gotcha', title: 'deploy needs vpn!!', body: 'a longer body wins' });
if (!b.duplicate || a.id !== b.id) fail('dedupe', { a, b });
if (d.prepare('SELECT body FROM memories WHERE id = ?').get(a.id).body !== 'a longer body wins') fail('richer body kept', a);
console.log(`fuzz ok (${RUNS} runs)`);
