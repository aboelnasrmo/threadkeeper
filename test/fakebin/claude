#!/usr/bin/env node
// Fake `claude -p` for tests: records the prompt, answers with canned JSON.
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
const n = fs.readdirSync(process.env.THREADKEEPER_HOME).filter((f) => f.startsWith('prompt-')).length + 1;
fs.writeFileSync(`${process.env.THREADKEEPER_HOME}/prompt-${n}.txt`, prompt);
fs.writeFileSync(`${process.env.THREADKEEPER_HOME}/last-prompt.txt`, prompt);
if (process.env.FAKE_FAIL) { console.error('boom'); process.exit(1); }
if (prompt.includes('PROJECT BRIEF')) {
  const ids = [...prompt.matchAll(/^#(\d+) .*OLDFACT/gm)].map((m) => Number(m[1]));
  console.log(JSON.stringify({ brief: '## Essentials\nLogin validation project; ESSENTIALMARK.\n## What this is\nA test project with login validation.\n## Traps and gotchas\nEmail regex must allow plus signs (#1).\nBRIEFMARK', outdated: [...ids, 424242] }));
  process.exit(0);
}
if (prompt.includes('mapping note id to a space-separated string')) {
  const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => m[1]);
  console.log(JSON.stringify(Object.fromEntries(ids.map((id) => [id, 'backfilltag zebra']))));
  process.exit(0);
}
if (prompt.includes('about the same thing: repeats')) {
  console.log(JSON.stringify({ merged: [{ group: 1, title: 'Deploy script needs the VPN', body: 'MERGED: deploy.sh only works on the office VPN; use the Tailscale exit node from home.' }] }));
  process.exit(0);
}
if (prompt.includes('searches their notes with')) { console.log('["postgresql","postgres","sqlite"]'); process.exit(0); }
const related = [...prompt.matchAll(/^(\d+): .*OLDFACT/gm)].map((m) => Number(m[1]));
const todo = prompt.match(/OPEN TODOS[^\n]*\n(\d+):/);
const out = todo
  ? { summary: 'Fixed the empty-email case; all auth tests pass.', memories: [
      { type: 'bugfix', title: 'validate() returned undefined for empty email', body: 'Now returns an EmptyEmail error.', files: ['src/auth/validate.ts'] }],
      resolved_todos: [Number(todo[1]), 99999], outdated: [...related, 77777] }
  : { summary: 'Added login form validation; tests still failing on the empty-email case.', memories: [
      { type: 'bugfix', title: 'Email regex rejected plus signs', body: 'Fixed in src/auth/validate.ts by allowing + in the local part.', files: ['src/auth/validate.ts'], tags: 'authentication sanitizer signup' },
      { type: 'todo', title: 'Empty-email test failing', body: 'npm test auth fails; validate() returns undefined instead of an error.', files: ['src/auth/validate.ts'] }],
      outdated: related };
if (/USER: .*from now on/i.test(prompt)) out.memories.push({ type: 'gotcha', title: 'Always run lint before commit', body: 'User rule.', pin: true });
if (/USER: .*all my projects/i.test(prompt)) out.memories.push({ type: 'gotcha', title: 'Never push without asking', body: 'User rule for all work.', pin: true, everywhere: true });
console.log('Sure! ' + JSON.stringify(out));
