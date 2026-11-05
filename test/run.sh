#!/usr/bin/env bash
# End-to-end tests of threadkeeper with a fake `claude`. Usage: bash test/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export THREADKEEPER_HOME="$(mktemp -d)"
export THREADKEEPER_CLAUDE_BIN="$ROOT/test/fakebin/claude"
export THREADKEEPER_CLAUDE_PROJECTS="$(mktemp -d)"
echo '{"autoViewer":false}' > "$THREADKEEPER_HOME/settings.json"
PROJ="$(mktemp -d)"; mkdir -p "$PROJ/.git" "$PROJ/src/auth"
H="node --no-warnings $ROOT/src/hook.mjs"
S=sess-1
j() { node -e 'console.log(JSON.stringify(Object.assign({session_id:process.argv[1],cwd:process.argv[2]},JSON.parse(process.argv[3]))))' "$S" "$PROJ/src" "$1"; }
DB="$THREADKEEPER_HOME/memory.db"
q() { node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare(process.argv[2]).all()))" "$DB" "$1"; }
fail() { echo "FAIL: $*"; [[ -f "$THREADKEEPER_HOME/errors.log" ]] && cat "$THREADKEEPER_HOME/errors.log"; exit 1; }
waitfor() { for _ in $(seq 1 40); do [[ "$(q "$1")" == "$2" ]] && return 0; sleep 0.1; done; fail "timeout waiting for $1 == $2 (got $(q "$1"))"; }
mcp() { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$@" | CLAUDE_PROJECT_DIR="$PROJ" node --no-warnings "$ROOT/src/mcp.mjs"; }
call() { echo "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }

echo "1. capture + redaction"
j '{}' | $H SessionStart >/dev/null
j '{"prompt":"fix the login validation <private>my pw is hunter2</private>"}' | $H UserPromptSubmit
j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/auth/validate.ts"}}' | $H PostToolUse
# Fake secrets are assembled at run time so secret scanners don't flag this file.
FAKE_KEY="abcd1234""secret"; FAKE_BEARER="abcdefghijklm""nopqrstuvwxyz123"; FAKE_TOKEN="super""secret123"
j '{"tool_name":"Edit","tool_input":{"file_path":"'"$PROJ"'/src/auth/validate.ts","new_string":"const re = /^[^@+]+@/; // api_''key='"$FAKE_KEY"'"}}' | $H PostToolUse
j '{"tool_name":"Read","tool_input":{"file_path":".env"}}' | $H PostToolUse
j '{"tool_name":"Bash","tool_input":{"command":"curl -H \"Authori''zation: Bea''rer '"$FAKE_BEARER"'\" x && npm test auth"},"error":"exit 1"}' | $H PostToolUseFailure
j '{"tool_name":"ToolSearch","tool_input":{"query":"x"}}' | $H PostToolUse
[[ "$(q 'select project from sessions')" == *"\"$PROJ\""* ]] || fail "project should be git root"
EV="$(q 'select detail from events')"
[[ "$EV" == *hunter2* ]] && fail "private tag leaked"
[[ "$EV" == *"$FAKE_KEY"* ]] && fail "api_key leaked"
[[ "$EV" == *"$FAKE_BEARER"* ]] && fail "bearer token leaked"
[[ "$EV" == *"sensitive file"* ]] || fail ".env not flagged"
[[ "$EV" == *'"src/auth/validate.ts"'* ]] || fail "paths should be project-relative: $EV"
[[ "$EV" == *'FAILED: curl'* ]] || fail "failure not recorded"
[[ "$EV" == *ToolSearch* ]] && fail "noise tool recorded"

echo "2. session end -> summary with files and a todo"
j '{"reason":"exit"}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-1'" '[{"summarized":1}]'
[[ "$(q 'select count(*) n from memories')" == '[{"n":3}]' ]] || fail "expected 3 memories"
[[ "$(q "select status from memories where type='todo'")" == '[{"status":"open"}]' ]] || fail "todo should be open"
[[ "$(q 'select distinct path from memory_files')" == '[{"path":"src/auth/validate.ts"}]' ]] || fail "memory files"
[[ "$(q "select title from memories_fts where memories_fts match 'regex'")" == *"plus signs"* ]] || fail "fts search"
grep -q "USER: fix the login validation \[private\]" "$THREADKEEPER_HOME/prompt-1.txt" || fail "prompt to summarizer"

echo "3. next session: context has open todo; file notes appear once"
S=sess-2
CTX="$(j '{}' | $H SessionStart)"
[[ "$CTX" == *"Open todos"* && "$CTX" == *"Empty-email test failing"* && "$CTX" == *"plus signs"* ]] || fail "context injection: $CTX"
[[ -z "$(j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/auth/validate.ts"}}' | $H PreToolUse)" ]] || fail "notes shown at session start must not repeat on file open"
[[ -z "$(j '{"prompt":"why does the email regex reject plus signs again?"}' | $H UserPromptSubmit)" ]] || fail "notes shown at session start must not repeat on prompt"
[[ -z "$(j '{"prompt":"ok go on"}' | S=sess-2b $H UserPromptSubmit)" ]] || fail "short replies never recall"
S=sess-2b  # a session that didn't load them at start (e.g. resumed)
FC="$(j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/auth/validate.ts"}}' | $H PreToolUse)"
[[ "$FC" == *'"hookEventName":"PreToolUse"'* && "$FC" == *"past notes about src/auth/validate.ts"* ]] || fail "file context: $FC"
FC2="$(j '{"tool_name":"Read","tool_input":{"file_path":"src/auth/validate.ts"}}' | $H PreToolUse)"
[[ -z "$FC2" ]] || fail "file context should show once per session"
[[ -z "$(j '{"tool_name":"Read","tool_input":{"file_path":"src/other.ts"}}' | $H PreToolUse)" ]] || fail "no notes for unrelated file"

S=sess-2c
PR="$(j '{"prompt":"why does the email regex reject plus signs again?"}' | $H UserPromptSubmit)"
[[ "$PR" == *'"hookEventName":"UserPromptSubmit"'* && "$PR" == *"plus signs"* ]] || fail "prompt recall: $PR"
[[ -z "$(j '{"prompt":"email regex plus signs"}' | $H UserPromptSubmit)" ]] || fail "prompt recall should not repeat a note"
[[ -z "$(j '{"prompt":"refactor the payment webhook"}' | $H UserPromptSubmit)" ]] || fail "prompt recall should stay quiet when nothing matches"

echo "4. later work resolves the todo (and ignores bogus ids)"
S=sess-2
j '{"tool_name":"Edit","tool_input":{"file_path":"src/auth/validate.ts","new_string":"if (!email) return EmptyEmail"}}' | $H PostToolUse
j '{"reason":"exit"}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-2'" '[{"summarized":1}]'
[[ "$(q "select status from memories where type='todo'")" == '[{"status":"done"}]' ]] || fail "todo should be resolved"
grep -q "OPEN TODOS" "$THREADKEEPER_HOME/prompt-2.txt" || fail "open todos sent to summarizer"
[[ "$(j '{}' | S=x $H SessionStart)" == *"Open todos"* ]] && fail "resolved todo still in context"

echo "5. small session skipped; PreCompact partial save then final remainder"
S=sess-3
j '{}' | $H SessionStart >/dev/null
j '{"tool_name":"Read","tool_input":{"file_path":"README.md"}}' | $H PostToolUse
j '{"reason":"exit"}' | $H SessionEnd
[[ "$(q "select summarized from sessions where id='sess-3'")" == '[{"summarized":-1}]' ]] || fail "small session should be skipped"
S=sess-4
j '{}' | $H SessionStart >/dev/null
j '{"tool_name":"Write","tool_input":{"file_path":"a.ts","content":"x"}}' | $H PostToolUse
j '{"prompt":"build the a.ts module"}' | $H UserPromptSubmit >/dev/null
j '{"trigger":"auto"}' | $H PreCompact
[[ "$(q "select summarized, summarized_upto > 0 as up from sessions where id='sess-4'")" == '[{"summarized":0,"up":1}]' ]] || fail "PreCompact must save synchronously"
CC="$(j '{"source":"compact"}' | $H SessionStart)"
[[ "$CC" == *"This session so far"* && "$CC" == *"build the a.ts module"* && "$CC" == *"Files changed in this session: a.ts"* ]] || fail "post-compact context: $CC"
[[ "$(j '{"source":"startup"}' | S=sess-4b $H SessionStart)" == *"This session so far"* ]] && fail "fresh session should not get 'this session'"
j '{"reason":"exit"}' | $H SessionEnd
[[ "$(q "select summarized from sessions where id='sess-4'")" == '[{"summarized":1}]' ]] || fail "nothing new after partial -> done: $(q "select summarized, summarized_upto, tool_calls, prompts, edits from sessions where id='sess-4'")"

echo "6. summarizer failures retry then give up; lock prevents double runs"
S=sess-5
j '{}' | $H SessionStart >/dev/null
j '{"tool_name":"Write","tool_input":{"file_path":"b.ts","content":"x"}}' | $H PostToolUse
for i in 1 2 3 4; do FAKE_FAIL=1 node --no-warnings "$ROOT/src/summarize.mjs" sess-5 2>/dev/null || true; done
[[ "$(q "select summarized from sessions where id='sess-5'")" == '[{"summarized":-1}]' ]] || fail "should give up after retries"
rm -f "$THREADKEEPER_HOME/errors.log"
node --no-warnings -e "
  const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);
  d.prepare(\"UPDATE sessions SET summarized=0, summarize_attempts=0, summarizing_since=? WHERE id='sess-5'\").run(new Date().toISOString());" "$DB"
R="$(node --no-warnings --input-type=module -e "import {summarizeSession} from '$ROOT/src/summarize.mjs'; console.log(summarizeSession('sess-5'))")"
[[ "$R" == busy ]] || fail "lock should make second summarizer back off, got $R"

echo "7. MCP tools: search, get, timeline, remember, resolve_todo"
OUT="$(mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  "$(call search '{"query":"email regex"}')" "$(call search '{"query":"\"); DROP TABLE memories; --"}')" \
  "$(call search '{"file":"src/auth/validate.ts","include_done":true}')" "$(call get '{"ids":[2]}')" "$(call timeline '{"id":2}')" \
  "$(call remember '{"title":"Deploy needs VPN","body":"Staging deploy only works on the office VPN; tok''en='"$FAKE_TOKEN"'","type":"gotcha"}')" \
  "$(call remember '{"title":"Write docs","body":"README is out of date","type":"todo"}')")"
[[ "$(echo "$OUT" | wc -l)" -eq 9 ]] || fail "mcp should answer 9 requests: $OUT"
for want in '"name":"timeline"' 'plus signs' 'files: src/auth/validate.ts' '▶ #2' 'Saved as #' 'Empty-email test failing'; do
  [[ "$OUT" == *"$want"* ]] || fail "mcp output missing $want"
done
[[ "$OUT" == *"$FAKE_TOKEN"* || "$(q 'select body from memories')" == *"$FAKE_TOKEN"* ]] && fail "remember must redact"
[[ "$(mcp "$(call remember '{"title":"deploy needs VPN!","body":"Staging deploy only works on the office VPN (also prod).","type":"gotcha"}')")" == *"Already remembered"* ]] || fail "duplicate note should merge"
TODO_ID="$(q "select id from memories where title='Write docs'" | grep -o '[0-9]\+')"
[[ "$(mcp "$(call resolve_todo "{\"ids\":[$TODO_ID]}")")" == *"Marked 1 todo"* ]] || fail "resolve_todo"
S=sess-6; CTX="$(j '{}' | $H SessionStart)"
[[ "$CTX" == *"Deploy needs VPN"* ]] || fail "manual notes in context"

echo "8. import from claude-mem, adopted by folder name"
CM="$(mktemp -d)/claude-mem.db"
node --no-warnings -e "
  const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);
  d.exec(\"CREATE TABLE observations(id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, created_at TEXT, created_at_epoch INTEGER);\");
  d.exec(\"CREATE TABLE session_summaries(id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, created_at TEXT, created_at_epoch INTEGER);\");
  const p=process.argv[2];
  d.prepare('INSERT INTO observations(project,type,title,narrative,facts,files_modified,created_at_epoch) VALUES (?,?,?,?,?,?,?)').run(require('path').basename(p),'decision','Use SQLite for cache','Chose SQLite over Redis to keep it local.','[\"no server\"]',JSON.stringify([p+'/src/cache.ts']),1700000000000);
  d.prepare('INSERT INTO observations(project,type,title,narrative,created_at_epoch) VALUES (?,?,?,?,?)').run('other','sensitive','skip me','x',1700000000000);
  d.prepare('INSERT INTO session_summaries(project,request,completed,created_at_epoch) VALUES (?,?,?,?)').run('other','Set up CI','CI green',1700000000000);
" "$CM" "$PROJ"
IMP="$(node --no-warnings "$ROOT/src/cli.mjs" import-claude-mem "$CM")"
[[ "$IMP" == *"Imported 1 observations and 1 session summaries"* ]] || fail "import: $IMP"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" import-claude-mem "$CM")" == *"Already imported"* ]] || fail "import should be idempotent"
S=sess-7; j '{}' | $H SessionStart >/dev/null
[[ "$(q "select project from memories where title='Use SQLite for cache'")" == *"\"$PROJ\""* ]] || fail "imported memory not adopted"
[[ "$(S=sess-7x j '{"tool_input":{"file_path":"src/cache.ts"}}' | $H PreToolUse)" == *"Use SQLite for cache"* ]] || fail "imported file paths should be relative after adopt"
[[ "$(j '{}' | S=sess-7b $H SessionStart)" == *"Other recent notes"*"Use SQLite for cache"* ]] || fail "imported notes should load at session start"
[[ "$(printf '\xef\xbb\xbf{"session_id":"bom-1","cwd":"%s"}' "$PROJ" | $H SessionStart)" == *"Use SQLite for cache"* ]] || fail "hook must accept input with a BOM"

echo "9. guards: recursion, bad input, ignored projects"
S=sess-8
j '{}' | THREADKEEPER_DISABLE=1 $H SessionStart
[[ "$(q "select count(*) n from sessions where id='sess-8'")" == '[{"n":0}]' ]] || fail "recursion guard"
echo 'not json' | $H PostToolUse || fail "hook must exit 0"
BEFORE="$(q 'select count(*) n from sessions')"
node -e 'console.log(JSON.stringify({session_id:"home-1",cwd:require("os").homedir()}))' | $H SessionStart >/dev/null
[[ "$(q 'select count(*) n from sessions')" == "$BEFORE" ]] || fail "home folder must not be recorded as a project"
echo "{\"enabled\":true,\"ignoreProjects\":[\"$PROJ\"]}" > "$THREADKEEPER_HOME/settings.json"
j '{}' | $H SessionStart >/dev/null
[[ "$(q "select count(*) n from sessions where id='sess-8'")" == '[{"n":0}]' ]] || fail "ignored project recorded"
echo '{"autoViewer":false}' > "$THREADKEEPER_HOME/settings.json"

echo "10. viewer: API, todos, CSRF and host guards"
THREADKEEPER_PORT=37791 node --no-warnings "$ROOT/src/viewer.mjs" >/dev/null 2>&1 & VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf localhost:37791/ >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf localhost:37791/ | grep -q ">threadkeeper</button>" || fail "viewer page"
[[ "$(curl -s localhost:37791/api/overview)" == *'"todos":'* ]] || fail "viewer overview"
[[ "$(curl -s localhost:37791/api/sessions/sess-1)" == *'"files":["src/auth/validate.ts"]'* ]] || fail "viewer session files"
[[ "$(curl -s -XPOST localhost:37791/api/memories/1/delete)" == *forbidden* ]] || fail "viewer csrf guard"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.test' localhost:37791/api/overview)" == 403 ]] || fail "viewer host guard"
[[ "$(curl -s localhost:37791/api/notes?type=bugfix)" == *'"typeCounts"'* ]] || fail "notes api"
HOMEJ="$(curl -s localhost:37791/api/home)"
[[ "$HOMEJ" == *'"activity":'* && "$HOMEJ" == *'"types":'* && "$(node -p 'JSON.parse(process.argv[1]).activity.length' "$HOMEJ")" == 30 ]] || fail "home api: $HOMEJ"
[[ "$(node -p 'const h=JSON.parse(process.argv[1]); h.usageByProject.length > 0 && h.usageByProject[0].added > 0 && h.usage.injected.tokens > 0' "$HOMEJ")" == true ]] || fail "usage per project: $HOMEJ"
UP="$(node -p 'JSON.parse(process.argv[1]).usageByProject[0].project' "$HOMEJ")"
[[ "$(curl -s "localhost:37791/api/home?project=$(node -p 'encodeURIComponent(process.argv[1])' "$UP")")" == *'"injected":{"times":'*'"usageByProject":[]'* ]] || fail "project usage"
BULK="$(curl -s -XPOST -H 'x-threadkeeper: 1' -H 'content-type: application/json' -d '{"ids":[2,3],"action":"pin"}' localhost:37791/api/notes/bulk)"
[[ "$BULK" == *'"changed":2'* && "$(q 'select count(*) n from memories where id in (2,3) and pinned=1')" == '[{"n":2}]' ]] || fail "bulk pin: $BULK"
[[ "$(curl -s -XPOST -H 'x-threadkeeper: 1' -d '{"ids":[2],"action":"nuke"}' localhost:37791/api/notes/bulk)" == *'unknown action'* ]] || fail "bulk rejects unknown actions"
EXP="$(curl -s -D - "localhost:37791/api/export?project=$(node -p 'encodeURIComponent(process.argv[1])' "$PROJ")")"
[[ "$EXP" == *'attachment; filename='*'-memory.md'* && "$EXP" == *'## Bug fixes'* && "$EXP" == *'Files: `src/auth/validate.ts`'* ]] || fail "export: ${EXP:0:500}"
[[ "$(curl -s 'localhost:37791/api/notes?q=database&smart=1')" == *'"also":["postgresql"'* ]] || fail "viewer meaning search"
[[ "$(curl -s 'localhost:37791/api/notes?stale=1')" == *'"total":0'* ]] || fail "stale filter"
UPD="$(curl -s -XPOST -H 'x-threadkeeper: 1' -H 'content-type: application/json' -d '{"pinned":true,"body":"edited <b>body</b>"}' localhost:37791/api/notes/1)"
[[ "$UPD" == *'"pinned":1'* && "$UPD" == *'edited <b>body</b>'* ]] || fail "note update: $UPD"
[[ "$(curl -s -XPOST -H 'x-threadkeeper: 1' -d 'nope' localhost:37791/api/notes/1)" == *'bad json'* ]] || fail "bad json rejected"
[[ "$(j '{}' | S=sess-pin $H SessionStart)" == *"Pinned and remembered"* ]] || fail "pinned note in context"
if node -e "require('playwright')" 2>/dev/null; then
  SHOTS="${SHOTS:-$THREADKEEPER_HOME}"
  node "$ROOT/test/viewer.e2e.cjs" 37791 "$SHOTS" || fail "viewer browser test"
else
  echo "   (browser test skipped: playwright not installed)"
fi

echo "11. viewer starts itself with a session, only once"
echo '{"autoViewer":true,"viewerPort":37792}' > "$THREADKEEPER_HOME/settings.json"
S=sess-9; j '{}' | $H SessionStart >/dev/null; j '{}' | $H SessionStart >/dev/null
for _ in $(seq 1 30); do curl -sf localhost:37792/api/overview >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf localhost:37792/api/overview >/dev/null || fail "auto viewer did not start"
sleep 0.5
[[ "$(pgrep -fc "viewer.mjs --quiet" || true)" -le 1 ]] || fail "viewer started twice"
pkill -f "viewer.mjs --quiet" || true
# An older viewer still running after an update is replaced by the current one.
node -e 'require("http").createServer((q,r)=>{r.setHeader("content-type","application/json");if(q.url==="/api/restart"){r.end("{}");setTimeout(()=>process.exit(0),20)}else r.end(JSON.stringify({version:"0.0.1"}))}).listen(37792,"127.0.0.1")' &
for _ in $(seq 1 30); do curl -sf localhost:37792/api/version >/dev/null 2>&1 && break; sleep 0.1; done
S=sess-9b; j '{}' | $H SessionStart >/dev/null
for _ in $(seq 1 30); do [[ "$(curl -sf localhost:37792/api/version 2>/dev/null)" == *"$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"* ]] && break; sleep 0.1; done
[[ "$(curl -sf localhost:37792/api/version)" == *"$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"* ]] || fail "old viewer was not replaced"
pkill -f "viewer.mjs --quiet" || true
# Re-running desktop keeps the original backup.
BK="$(mktemp -d)/c.json"; echo '{"orig":1}' > "$BK"
THREADKEEPER_DESKTOP_CONFIG="$BK" node --no-warnings "$ROOT/src/cli.mjs" desktop >/dev/null; THREADKEEPER_DESKTOP_CONFIG="$BK" node --no-warnings "$ROOT/src/cli.mjs" desktop >/dev/null
[[ "$(cat "$BK.before-threadkeeper")" == '{"orig":1}' ]] || fail "desktop backup overwritten"
node --no-warnings "$ROOT/src/cli.mjs" doctor | head -1 | grep -q "^threadkeeper [0-9]" || fail "doctor should print the version"

echo "12. sync between two machines through a shared folder"
SYNC="$(mktemp -d)"; A="$(mktemp -d)"; B="$(mktemp -d)"
M() { THREADKEEPER_HOME="$1" node --no-warnings "$ROOT/src/cli.mjs" "${@:2}"; }
N() { THREADKEEPER_HOME="$1" node --no-warnings --input-type=module -e "$2"; }
N "$A" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  insertMemory(d,{project:'/Users/mo/projects/webapp',type:'gotcha',title:'Deploy needs VPN',body:'office VPN only',files:['/Users/mo/projects/webapp/deploy.sh']});
  insertMemory(d,{project:'/Users/mo/projects/webapp',type:'note',title:'Delete me later',body:'x'});"
M "$A" sync "$SYNC" | grep -q "sent 2 notes" || fail "sync A export"
N "$B" "import {openDb} from '$ROOT/src/db.mjs'; const d=openDb(); d.prepare(\"INSERT INTO sessions(id,project,started_at,last_activity) VALUES ('w1','C:/Users/me/projects/webapp','2026','2026')\").run();"
M "$B" sync "$SYNC" | grep -q "Received 2 changes" || fail "sync B import"
[[ "$(N "$B" "import {openDb} from '$ROOT/src/db.mjs'; console.log(JSON.stringify(openDb().prepare(\"select project, title from memories where title='Deploy needs VPN'\").all()))")" == *'C:/Users/me/projects/webapp'* ]] || fail "synced note should land in B's webapp project"
[[ "$(N "$B" "import {openDb} from '$ROOT/src/db.mjs'; console.log(JSON.stringify(openDb().prepare('select path from memory_files').all()))")" == *'deploy.sh'* ]] || fail "files synced"
# B edits one note, A deletes the other; both converge, nothing echoes back.
N "$B" "import {openDb,updateMemory} from '$ROOT/src/db.mjs'; const d=openDb(); const m=d.prepare(\"select id from memories where title='Deploy needs VPN'\").get(); updateMemory(d,m.id,{body:'office VPN only, or the Tailscale exit node',pinned:true});"
N "$A" "import {openDb} from '$ROOT/src/db.mjs'; openDb().prepare(\"delete from memories where title='Delete me later'\").run();"
M "$B" sync >/dev/null; M "$A" sync >/dev/null; M "$B" sync >/dev/null
for H2 in "$A" "$B"; do
  R="$(N "$H2" "import {openDb} from '$ROOT/src/db.mjs'; console.log(JSON.stringify(openDb().prepare('select title, body, pinned from memories order by title').all()))")"
  [[ "$R" == '[{"title":"Deploy needs VPN","body":"office VPN only, or the Tailscale exit node","pinned":1}]' ]] || fail "machines did not converge: $R"
done
[[ "$(M "$A" sync | grep -o 'sent [0-9]* notes')" == "sent 0 notes" ]] || fail "applied changes must not echo back"
# A half-written line (cloud still uploading) is ignored until complete.
printf '{"op":"put","uid":"zz","project":"webapp","type":"note","title":"Half","body":"b","version":"2099-01-01T00:00:00Z"' >> "$SYNC/other-machine.jsonl"
M "$A" sync >/dev/null
[[ "$(N "$A" "import {openDb} from '$ROOT/src/db.mjs'; console.log(openDb().prepare(\"select count(*) n from memories where title='Half'\").get().n)")" == 0 ]] || fail "partial line applied"
printf '}\n' >> "$SYNC/other-machine.jsonl"; M "$A" sync >/dev/null
[[ "$(N "$A" "import {openDb} from '$ROOT/src/db.mjs'; console.log(openDb().prepare(\"select count(*) n from memories where title='Half'\").get().n)")" == 1 ]] || fail "completed line not applied"
# Encryption: A turns it on; its file becomes sealed; B waits (warned) until it has the key, then catches up.
KEY="$(M "$A" encrypt | grep -oE '^  [A-Za-z0-9_-]{43}$' | head -1 | tr -d ' ')"
[[ ${#KEY} == 43 ]] || fail "encrypt prints a key"
ls "$SYNC" | grep -q "^$(cat "$A/machine-id").jsonl$" && fail "plaintext file must be gone"
grep -q "Deploy needs VPN" "$SYNC"/*.e1.jsonl && fail "encrypted file must not show note text"
N "$A" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; insertMemory(openDb(),{project:'/Users/mo/projects/webapp',type:'note',title:'Secret server name',body:'db7.internal'});"
M "$A" sync >/dev/null
grep -q "db7.internal" "$SYNC"/* && fail "new notes must be sealed"
M "$B" sync >/dev/null
[[ "$(N "$B" "import {openDb} from '$ROOT/src/db.mjs'; console.log(openDb().prepare(\"select count(*) n from memories where title='Secret server name'\").get().n)")" == 0 ]] || fail "no key, no read"
[[ "$(M "$B" doctor)" == *"encrypted with a key this machine doesn't have"* ]] || fail "missing key warned"
M "$B" encrypt "$KEY" >/dev/null
[[ "$(N "$B" "import {openDb} from '$ROOT/src/db.mjs'; console.log(openDb().prepare(\"select count(*) n from memories where title='Secret server name'\").get().n)")" == 1 ]] || fail "with the key, B catches up"
[[ "$(M "$B" doctor)" != *"doesn't have"* ]] || fail "warning clears"
# Claude Desktop config writer keeps other servers and makes a backup.
DC="$(mktemp -d)/claude_desktop_config.json"; echo '{"mcpServers":{"other":{"command":"x"}}}' > "$DC"
THREADKEEPER_DESKTOP_CONFIG="$DC" node --no-warnings "$ROOT/src/cli.mjs" desktop >/dev/null
[[ "$(cat "$DC")" == *'"other"'* && "$(cat "$DC")" == *'THREADKEEPER_CLIENT'* && -f "$DC.before-threadkeeper" ]] || fail "desktop config"
OUT="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"vpn","project":"webapp"}}}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"projects","arguments":{}}}' | THREADKEEPER_HOME="$B" THREADKEEPER_CLIENT=desktop node --no-warnings "$ROOT/src/mcp.mjs")"
[[ "$OUT" == *"Deploy needs VPN"* && "$OUT" == *"webapp: 3 notes"* ]] || fail "desktop-mode tools: $OUT"
# Desktop runs the launcher, which follows the newest installed plugin copy.
FH="$(mktemp -d)"; mkdir -p "$FH/.claude/plugins"
echo "{\"plugins\":{\"threadkeeper@threadkeeper\":[{\"installPath\":\"$ROOT\",\"lastUpdated\":\"2099\"}]}}" > "$FH/.claude/plugins/installed_plugins.json"
LA="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).mcpServers["threadkeeper"].args[1])' "$DC")"
[[ "$LA" == "$B/desktop-mcp.mjs" || "$LA" == */desktop-mcp.mjs ]] || fail "desktop should use the launcher: $LA"
OUT="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | HOME="$FH" THREADKEEPER_HOME="$B" THREADKEEPER_CLIENT=desktop node --no-warnings "$LA")"
[[ "$OUT" == *"\"version\":\"$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")\""* ]] || fail "launcher / server version: $OUT"

echo "12b. Windows paths"
N "$A" "import {relPath} from '$ROOT/src/db.mjs'; import {isSensitivePath} from '$ROOT/src/redact.mjs';
  const ok = relPath('C:/p','src\\\\a.ts')==='src/a.ts' && isSensitivePath('C:\\\\Users\\\\me\\\\proj\\\\.env') && isSensitivePath('C:\\\\x\\\\id_rsa') && !isSensitivePath('C:\\\\x\\\\env.ts');
  if (!ok) process.exit(1);" || fail "windows path handling"
WD="$(mktemp -d)"; mkdir -p "$WD/L/Claude-Data/claude_x" "$WD/R/Claude"; echo '{}' > "$WD/R/Claude/claude_desktop_config.json"
echo '{"mcpServers":{"threadkeeper":{}}}' > "$WD/L/Claude-Data/claude_x/claude_desktop_config.json"
[[ "$(N "$A" "import {windowsConfigPath} from '$ROOT/src/desktop.mjs'; console.log(windowsConfigPath({APPDATA:'$WD/R',LOCALAPPDATA:'$WD/L'},'/x'))")" == *Claude-Data/claude_x/* ]] || fail "windows desktop config should prefer the one with threadkeeper"

echo "14. outdated notes, project brief, smart search, checkpoints, Claude memory files, missed sessions, health"
echo '{"autoViewer":false,"briefEvery":2}' > "$THREADKEEPER_HOME/settings.json"
# A session that touches a file retires the earlier note it proves wrong.
OLD_ID="$(mcp "$(call remember '{"title":"OLDFACT validate allows any email","body":"validate.ts accepts anything","type":"discovery","files":["src/auth/validate.ts"]}')" | grep -o 'Saved as #[0-9]*' | grep -o '[0-9]*')"
[[ -n "$OLD_ID" ]] || fail "remember OLDFACT"
S=sess-14
j '{}' | $H SessionStart >/dev/null
j '{"prompt":"fix validate email handling"}' | $H UserPromptSubmit >/dev/null
j '{"tool_name":"Edit","tool_input":{"file_path":"'"$PROJ"'/src/auth/validate.ts","new_string":"x"}}' | $H PostToolUse
j '{}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-14'" '[{"summarized":1}]'
grep -q "EARLIER NOTES" "$THREADKEEPER_HOME/last-prompt.txt" || fail "summarizer should see related earlier notes"
waitfor "select superseded_at is not null o from memories where id=$OLD_ID" '[{"o":1}]'
OUT="$(mcp "$(call search '{"query":"OLDFACT"}')")"; [[ "$OUT" == *OLDFACT* ]] && fail "outdated note should not be recalled: $OUT"
[[ "$(mcp "$(call search '{"query":"OLDFACT","include_outdated":true}')")" == *OUTDATED* ]] || fail "outdated note findable on request"
[[ "$(mcp "$(call get "{\"ids\":[$OLD_ID]}")")" == *"OUTDATED since"* ]] || fail "get should flag outdated"
# The brief: written by the model, loaded first at session start, and it retires stale notes too.
mcp "$(call remember '{"title":"OLDFACT2 deploy uses FTP","body":"old way","type":"note"}')" >/dev/null
(cd "$PROJ" && node --no-warnings "$ROOT/src/cli.mjs" brief --refresh) | grep -q BRIEFMARK || fail "brief --refresh"
[[ "$(q "select count(*) n from memories where type='brief' and superseded_at is null")" == '[{"n":1}]' ]] || fail "one live brief"
[[ "$(q "select superseded_at is not null o from memories where title like 'OLDFACT2%'")" == '[{"o":1}]' ]] || fail "brief should retire stale notes"
CTX="$(S=sess-15 j '{}' | $H SessionStart)"
[[ "$CTX" == *"Project brief: essentials"*ESSENTIALMARK*"Full brief has: What this is"* ]] || fail "brief essentials in session context: $CTX"
[[ "$CTX" == *BRIEFMARK* ]] && fail "full brief should load on demand only"
[[ "$CTX" == *OLDFACT* ]] && fail "outdated notes must not be in context"
[[ "$(mcp "$(call brief '{}')")" == *BRIEFMARK* ]] || fail "brief tool"
# Smart search: few exact hits → related words from the model.
mcp "$(call remember '{"title":"Live server runs PostgreSQL","body":"moved from SQLite on 2026-10-06","type":"discovery"}')" >/dev/null
OUT="$(mcp "$(call search '{"query":"database"}')")"
[[ "$OUT" == *"also searched"* && "$OUT" == *PostgreSQL* ]] || fail "smart search: $OUT"
# Checkpoints: a long session saves a partial summary while it runs.
echo '{"autoViewer":false,"checkpointTools":3}' > "$THREADKEEPER_HOME/settings.json"
S=sess-16; j '{}' | $H SessionStart >/dev/null
for i in 1 2 3 4 5 6; do j '{"tool_name":"Bash","tool_input":{"command":"npm test '$i'"}}' | $H PostToolUse; done
j '{}' | $H Stop
waitfor "select checkpoint_at is not null c, summarized from sessions where id='sess-16'" '[{"c":1,"summarized":0}]'
# Claude Code's own memory files come in (feedback is pinned), and edits update the same note.
ENC="$(node -e 'console.log(process.argv[1].replace(/[^A-Za-z0-9]/g,"-"))' "$PROJ")"
mkdir -p "$THREADKEEPER_CLAUDE_PROJECTS/$ENC/memory"
printf -- '---\nname: no-force-push\ndescription: Never force-push main\nmetadata:\n  type: feedback\n---\nMO lost work once. Use a branch.\n' > "$THREADKEEPER_CLAUDE_PROJECTS/$ENC/memory/no-force-push.md"
echo '- [x](no-force-push.md)' > "$THREADKEEPER_CLAUDE_PROJECTS/$ENC/memory/MEMORY.md"
CTX="$(S=sess-17 j '{}' | $H SessionStart)"
[[ "$CTX" == *"Never force-push main"* ]] || fail "claude memory file should load as pinned: $CTX"
sleep 0.05; printf -- '---\ndescription: Never force-push main\ntype: feedback\n---\nUse a branch and a PR.\n' > "$THREADKEEPER_CLAUDE_PROJECTS/$ENC/memory/no-force-push.md"
S=sess-17 j '{}' | $H SessionStart >/dev/null
[[ "$(q "select count(*) n, max(body) b from memories where source='claude-memory'")" == '[{"n":1,"b":"Use a branch and a PR."}]' ]] || fail "memory file update"
# Sessions the hooks never saw are rebuilt from transcripts and summarized, with a notice.
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).prepare(\"INSERT OR REPLACE INTO sync_state(key,value) VALUES('installed_at','2000-01-01')\").run()" "$DB"
T="$THREADKEEPER_CLAUDE_PROJECTS/$ENC/lost-1.jsonl"
node -e '
  const L=[]; const cwd=process.argv[2];
  L.push({type:"user",cwd,timestamp:"2026-11-01T10:00:00Z",message:{role:"user",content:"set up the deploy script for staging "+"x".repeat(3000)}});
  L.push({type:"assistant",timestamp:"2026-11-01T10:01:00Z",message:{content:[{type:"text",text:"Writing it."},{type:"tool_use",name:"Write",input:{file_path:cwd+"/deploy.sh",content:"echo hi"}}]}});
  L.push({type:"user",isMeta:true,message:{content:"<command-name>/exit</command-name>"}});
  require("fs").writeFileSync(process.argv[1], L.map(JSON.stringify).join("\n")+"\n");' "$T" "$PROJ"
touch -d '30 minutes ago' "$T"
CTX="$(S=sess-18 j '{}' | $H SessionStart)"
[[ "$CTX" == *"never recorded"* ]] || fail "missed-session notice: $CTX"
waitfor "select recovered, summarized, edits from sessions where id='lost-1'" '[{"recovered":1,"summarized":1,"edits":1}]'
[[ "$(S=sess-19 j '{}' | $H SessionStart)" == *"never recorded"* ]] && fail "notice should not repeat once recovered"
# Health: errors surface in doctor and at session start.
echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) [test] Error: something broke" >> "$THREADKEEPER_HOME/errors.log"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" doctor)" == *"something broke"* ]] || fail "doctor should show recent errors"
[[ "$(S=sess-20 j '{}' | $H SessionStart)" == *"threadkeeper problem"*"something broke"* ]] || fail "session start should warn about errors"
rm "$THREADKEEPER_HOME/errors.log"
# Outdated marks and the brief travel between machines.
SA="$(mktemp -d)"; SB="$(mktemp -d)"; SD="$(mktemp -d)"
N "$SA" "import {openDb,insertMemory,markSuperseded} from '$ROOT/src/db.mjs'; const d=openDb();
  const {id}=insertMemory(d,{project:'/a/webapp',type:'note',title:'Stale',body:'x'}); markSuperseded(d,null,[id],'test');
  insertMemory(d,{project:'/a/webapp',type:'brief',title:'Project brief: webapp',body:'B'.repeat(6000)});"
M "$SA" sync "$SD" >/dev/null; M "$SB" sync "$SD" >/dev/null
[[ "$(N "$SB" "import {openDb} from '$ROOT/src/db.mjs'; console.log(JSON.stringify(openDb().prepare('select type, superseded_at is not null o, length(body) l from memories order by id').all()))")" == '[{"type":"note","o":1,"l":1},{"type":"brief","o":0,"l":6000}]' ]] || fail "superseded + brief sync"

echo "15. lean context: resume, compact, compressed summarizer input, rules, housekeeping, usage"
echo '{"autoViewer":false}' > "$THREADKEEPER_HOME/settings.json"
S=sess-21; j '{}' | $H SessionStart >/dev/null
j '{"prompt":"from now on run lint before every commit please"}' | $H UserPromptSubmit >/dev/null
for i in 1 2 3; do j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/a'$i'.ts"}}' | $H PostToolUse; done
for i in 1 2; do j '{"tool_name":"Bash","tool_input":{"command":"npm run lint"}}' | $H PostToolUse; done
j '{"tool_name":"Edit","tool_input":{"file_path":"'"$PROJ"'/src/a1.ts","new_string":"x"}}' | $H PostToolUse
j '{}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-21'" '[{"summarized":1}]'
grep -q "(3 file reads/searches)" "$THREADKEEPER_HOME/last-prompt.txt" && grep -q "npm run lint ×2" "$THREADKEEPER_HOME/last-prompt.txt" || fail "summarizer input should be compressed: $(cat "$THREADKEEPER_HOME/last-prompt.txt" | tail -8)"
[[ "$(q "select pinned from memories where title='Always run lint before commit'")" == '[{"pinned":1}]' ]] || fail "standing rule should pin itself"
# Resume: only what changed since; compact: no recent-session dump.
mcp "$(call remember '{"title":"Fresh from the other machine","body":"new fact","type":"note"}')" >/dev/null
RC="$(S=sess-21 j '{"source":"resume"}' | $H SessionStart)"
[[ "$RC" == *"Fresh from the other machine"* && "$RC" != *"Recent sessions"* && "$RC" != *"Project brief"* ]] || fail "resume context: $RC"
CC="$(S=sess-21 j '{"source":"compact"}' | $H SessionStart)"
[[ "$CC" == *"This session so far"* && "$CC" != *"Recent sessions"* ]] || fail "compact context: $CC"
# Housekeeping: notes about git-deleted files retire; near-duplicates merge.
G="$(mktemp -d)"; git -C "$G" init -q; git -C "$G" config user.email t@t; git -C "$G" config user.name t
echo a > "$G/gone.ts"; echo b > "$G/kept.ts"; git -C "$G" add -A; git -C "$G" commit -qm one; git -C "$G" rm -q gone.ts; git -C "$G" commit -qm two
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  insertMemory(d,{project:'$G',type:'discovery',title:'gone.ts parses dates',body:'x',files:['gone.ts']});
  insertMemory(d,{project:'$G',type:'discovery',title:'kept.ts formats',body:'y',files:['kept.ts']});
  insertMemory(d,{project:'$G',type:'gotcha',title:'Deploy script needs office VPN',body:'deploy.sh fails off VPN'});
  insertMemory(d,{project:'$G',type:'gotcha',title:'Deploy script needs the office VPN connection',body:'use Tailscale from home'});"
N "$THREADKEEPER_HOME" "import {maintain} from '$ROOT/src/maintain.mjs'; const r=await maintain('$G'); console.log(JSON.stringify(r))" | grep -q '"retired":1,"merged":1' || fail "maintain"
[[ "$(q "select title, superseded_at is not null o from memories where project='$G' order by id")" == *'"gone.ts parses dates","o":1'*'"kept.ts formats","o":0'* ]] || fail "deleted-file notes"
[[ "$(q "select count(*) n from memories where project='$G' and type='gotcha' and superseded_at is null and body like 'MERGED%'")" == '[{"n":1}]' ]] || fail "merged duplicates"
# Re-read guard: an unchanged, fully read file is not read again; the second attempt goes through; edits reset it.
S=sess-22; j '{}' | $H SessionStart >/dev/null
head -c 6000 /dev/urandom | base64 > "$PROJ/src/big.ts"; touch -d '5 minutes ago' "$PROJ/src/big.ts"
RD='{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/big.ts"}}'
[[ -z "$(j "$RD" | $H PreToolUse | grep -o deny)" ]] || fail "first read must go through"
j "$RD" | $H PostToolUse
[[ "$(j "$RD" | $H PreToolUse)" == *'"permissionDecision":"deny"'*"unchanged since your full read"* ]] || fail "unchanged re-read should be stopped"
[[ "$(j "$RD" | $H PreToolUse)" != *deny* ]] || fail "second attempt must go through"
[[ "$(j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/big.ts","offset":10,"limit":5}}' | $H PreToolUse)" != *deny* ]] || fail "tiny slices are never stopped"
[[ "$(j '{"tool_name":"Read","tool_input":{"file_path":"'"$PROJ"'/src/big.ts","offset":10,"limit":200}}' | $H PreToolUse)" == *deny* ]] || fail "a big slice of a fully read, unchanged file is stopped"
echo more >> "$PROJ/src/big.ts"
[[ "$(j "$RD" | $H PreToolUse)" != *deny* ]] || fail "changed file must be read"
[[ "$(j '{"tool_name":"Read","agent_id":"a1","tool_input":{"file_path":"'"$PROJ"'/src/big.ts"}}' | $H PreToolUse)" != *deny* ]] || fail "subagents are never stopped"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" usage)" == *"saved by the re-read guard: ~"* ]] || fail "usage shows savings"
# Usage meter.
[[ "$(q "select count(*)>0 a from usage where kind='inject'")" == '[{"a":1}]' && "$(q "select count(*)>0 a from usage where kind='model'")" == '[{"a":1}]' ]] || fail "usage meter"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" usage)" == *"tokens"* ]] || fail "usage command"

echo "16. meaning search tags, status line, export, commits in the brief"
echo '{"autoViewer":false}' > "$THREADKEEPER_HOME/settings.json"
OUT="$(mcp "$(call search '{"query":"sanitizer"}')")"
[[ "$OUT" == *"Email regex rejected plus signs"* ]] || fail "tags from the summarizer should make notes findable by meaning: $OUT"
mcp "$(call remember '{"title":"Untagged old note","body":"from before tags","type":"note"}')" >/dev/null
N "$THREADKEEPER_HOME" "import {tagNotes} from '$ROOT/src/maintain.mjs'; console.log(await tagNotes('$PROJ', (await import('$ROOT/src/config.mjs')).loadConfig()))" | grep -q '^[1-9]' || fail "tag backfill"
[[ "$(mcp "$(call search '{"query":"zebra"}')")" == *"Untagged old note"* ]] || fail "backfilled tags searchable"
ST="$(S=sess-30 j '{}' | $H SessionStart)"
[[ "$ST" == *'"systemMessage":"threadkeeper: '*' notes for '* ]] || fail "status line: ${ST:0:300}"
EX="$(mktemp -d)"; (cd "$PROJ" && node --no-warnings "$ROOT/src/cli.mjs" export . "$EX") | grep -q "Wrote" && [[ -f "$EX/brief.md" && -f "$EX/bugfix.md" ]] || fail "export"
GP="$(mktemp -d)"; git -C "$GP" init -q; git -C "$GP" config user.email t@t; git -C "$GP" config user.name t
echo x > "$GP/a"; git -C "$GP" add -A; git -C "$GP" commit -qm "Switch production to PostgreSQL"
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb(); for (let i=0;i<7;i++) insertMemory(d,{project:'$GP',type:'note',title:'n'+i+' thing',body:'b'});"
N "$THREADKEEPER_HOME" "import {refreshBrief} from '$ROOT/src/brief.mjs'; await refreshBrief('$GP')" >/dev/null
grep -q "RECENT GIT COMMITS" "$THREADKEEPER_HOME/last-prompt.txt" && grep -q "Switch production to PostgreSQL" "$THREADKEEPER_HOME/last-prompt.txt" || fail "brief should see recent commits"

echo "17. notes go to the project the work was about; stale todos; precise prompt recall; catch-up across projects"
OTH="$(mktemp -d)"; mkdir -p "$OTH/.git" "$OTH/lib"
S=sess-40; j '{}' | $H SessionStart >/dev/null
j '{"prompt":"fix the parser in the other repo please"}' | $H UserPromptSubmit
for f in a b c; do
  j '{"tool_name":"Read","tool_input":{"file_path":"'"$OTH"'/lib/'$f'.ts"}}' | $H PostToolUse
  j '{"tool_name":"Edit","tool_input":{"file_path":"'"$OTH"'/lib/'$f'.ts","new_string":"x"}}' | $H PostToolUse
done
j '{"tool_name":"Bash","tool_input":{"command":"cd '"$OTH"' && npm test"}}' | $H PostToolUse
j '{"reason":"exit"}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-40'" '[{"summarized":1}]'
[[ "$(q "select count(*) n from memories where session_id='sess-40' and project='$OTH'")" != '[{"n":0}]' ]] || fail "notes should go to the repo the files are in: $(q "select project from memories where session_id='sess-40'")"
[[ "$(q "select count(*) n from memories where session_id='sess-40' and project='$PROJ'")" == '[{"n":0}]' ]] || fail "no notes left in the folder Claude ran in"
[[ "$(q "select path from memory_files f join memories m on m.id=f.memory_id where m.session_id='sess-40' limit 1")" != *"$OTH"* ]] || fail "files relative to the attributed project"
N "$THREADKEEPER_HOME" "import {attributeProject,isScratch} from '$ROOT/src/attribute.mjs';
  const ev=[{kind:'tool',tool:'Edit',detail:'src/x.ts: y'},{kind:'tool',tool:'Read',detail:'$OTH/lib/a.ts'}];
  if (attributeProject('$PROJ',ev)!=='$PROJ') throw 'one stray read must not move notes';
  if (!isScratch('/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b')) throw 'scratch';
  if (attributeProject('/Users/x/Library/Application Support/Claude/scratch-workspaces/a',[{kind:'tool',tool:'Edit',detail:'$OTH/lib/a.ts: z'}])!=='$OTH') throw 'scratch work goes to the repo';"
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  const {id}=insertMemory(d,{project:'$PROJ',type:'todo',title:'Ancient chore from long ago',body:'z'});
  d.prepare(\"update memories set status='open', created_at='2020-01-01T00:00:00.000Z', updated_at=NULL where id=?\").run(id);"
TC="$(S=sess-41 j '{}' | $H SessionStart)"
[[ "$TC" != *"Ancient chore"* && "$TC" == *"older open todo(s) not shown"* ]] || fail "stale todos hidden at start: ${TC:0:600}"
[[ -z "$(S=sess-41 j '{"prompt":"please refactor the payment webhook retry handler"}' | $H UserPromptSubmit)" ]] || fail "unrelated prompt must recall nothing"
# Investigation chains: settled notes about the same thing are grouped to become one; unrelated notes are not.
CH="$(mktemp -d)"
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  const old=new Date(Date.now()-10*864e5).toISOString();
  for (const [t,b] of [['Athan silent on Samsung: suspect channel sound','maybe channel'],['Athan silent on Samsung: notification volume is zero','volume 0'],['Athan audible on Samsung after volume raised','fixed by volume'],['Unrelated widget padding tweak','z']]) {
    const {id}=insertMemory(d,{project:'$CH',type:'discovery',title:t,body:b,files:[t.startsWith('Athan')?'lib/notify.dart':'lib/w.dart']}); d.prepare('update memories set created_at=? where id=?').run(old,id); }"
N "$THREADKEEPER_HOME" "import {openDb} from '$ROOT/src/db.mjs'; import {duplicateGroups} from '$ROOT/src/maintain.mjs'; const g=duplicateGroups(openDb(),'$CH'); if (g.length!==1||g[0].length!==3) throw new Error(JSON.stringify(g.map(x=>x.map(m=>m.title))))" || fail "investigation chain grouping"
N "$THREADKEEPER_HOME" "import {mergeDuplicates} from '$ROOT/src/maintain.mjs'; console.log(await mergeDuplicates('$CH', (await import('$ROOT/src/config.mjs')).loadConfig(), {rounds:3}))" | grep -qx 2 || fail "chain merged once, not re-offered"
# A finished session in another project is summarized from any session start.
S=sess-42; j '{}' | $H SessionStart >/dev/null
for i in 1 2 3 4 5 6; do j '{"tool_name":"Bash","tool_input":{"command":"make step'$i'"}}' | $H PostToolUse; done
N "$THREADKEEPER_HOME" "import {openDb} from '$ROOT/src/db.mjs'; openDb().prepare(\"update sessions set project='/elsewhere/proj', last_activity=?, ended_at=? where id='sess-42'\").run(new Date(Date.now()-3*3600e3).toISOString(), new Date(Date.now()-3*3600e3).toISOString())"
S=sess-43 j '{}' | $H SessionStart >/dev/null
waitfor "select summarized from sessions where id='sess-42'" '[{"summarized":1}]'

echo "18. backups, subagent context, notes on rewritten files, Desktop chats, weekly report"
node --no-warnings "$ROOT/src/cli.mjs" backup | grep -q "Saved" || fail "backup"
ls "$THREADKEEPER_HOME/backups/" | grep -q '^memory-....-..-..\.db$' || fail "backup file"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" restore)" == *"$(date -u +%Y-%m-%d)"* ]] || fail "restore lists backups"
SA="$(S=sess-50 j '{"agent_id":"ag1","agent_type":"Explore"}' | $H SubagentStart)"
[[ "$SA" == *'"hookEventName":"SubagentStart"'* && "$SA" == *"ESSENTIALMARK"* && "$SA" != *"Recent sessions"* ]] || fail "subagent context: ${SA:0:400}"
SG="$(mktemp -d)"; git -C "$SG" init -q; git -C "$SG" config user.email t@t; git -C "$SG" config user.name t
seq 1 40 > "$SG/a.ts"; seq 1 40 > "$SG/b.ts"; git -C "$SG" add -A; git -C "$SG" commit -qm one
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  for (const f of ['a.ts','b.ts']) insertMemory(d,{project:'$SG',type:'discovery',title:f+' holds the parser',body:'x',files:[f]});"
sleep 1.2; seq 100 160 > "$SG/a.ts"; git -C "$SG" commit -qam rewrite
N "$THREADKEEPER_HOME" "import {flagStale} from '$ROOT/src/maintain.mjs'; console.log(flagStale('$SG'))" | grep -qx 1 || fail "flag stale"
[[ "$(q "select title from memories where project='$SG' and stale_at is not null")" == '[{"title":"a.ts holds the parser"}]' ]] || fail "only the rewritten file's note is stale"
[[ "$(cd "$SG" && S=sess-51 PROJ="$SG" node -e 'console.log(JSON.stringify({session_id:"sess-51",cwd:process.argv[1],tool_name:"Read",tool_input:{file_path:process.argv[1]+"/a.ts"}}))' "$SG" | $H PreToolUse)" == *"files changed a lot since"* ]] || fail "stale label on file notes"
DOUT="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$(call save_chat '{"project":"'"$(basename "$PROJ")"'","summary":"Planned the billing rewrite. Chose Stripe over Paddle.","notes":[{"type":"decision","title":"Billing goes through Stripe","body":"Paddle fees too high."}]}')" | THREADKEEPER_CLIENT=desktop node --no-warnings "$ROOT/src/mcp.mjs")"
[[ "$DOUT" == *"save_chat once"* && "$DOUT" == *"Saved 2 note(s)"* ]] || fail "desktop save_chat: $DOUT"
[[ "$(q "select count(*) n from memories where project='$PROJ' and source='desktop'")" == '[{"n":2}]' ]] || fail "desktop notes stored in the project"
WK="$(node --no-warnings "$ROOT/src/cli.mjs" week)"
[[ "$WK" == *"$(basename "$PROJ")"* && "$WK" == *"Billing goes through Stripe"* ]] || fail "week report: ${WK:0:400}"
# Preferences: a rule the summarizer marks "everywhere", or remember everywhere, loads in every project.
mcp "$(call remember '{"title":"Keep replies short","body":"MO wants short answers, no fluff.","everywhere":true}')" >/dev/null
[[ "$(q "select project, pinned from memories where title='Keep replies short'")" == '[{"project":"general","pinned":1}]' ]] || fail "everywhere goes to general, pinned"
PX="$(S=sess-60 j '{}' | $H SessionStart)"
[[ "$PX" == *"Your preferences (apply in every project)"*"Keep replies short"* ]] || fail "preferences at start: ${PX:0:500}"
[[ "$(S=sess-61 j '{"agent_id":"a"}' | $H SubagentStart)" == *"Keep replies short"* ]] || fail "preferences for helper agents"
S=sess-62; j '{}' | $H SessionStart >/dev/null
j '{"prompt":"in all my projects never push without asking me"}' | $H UserPromptSubmit
for i in 1 2 3 4 5; do j '{"tool_name":"Bash","tool_input":{"command":"git status '$i'"}}' | $H PostToolUse; done
j '{"reason":"exit"}' | $H SessionEnd
waitfor "select project from memories where title='Never push without asking'" '[{"project":"general"}]'
[[ "$(stat -c %a "$THREADKEEPER_HOME")" == 700 && "$(stat -c %a "$THREADKEEPER_HOME/memory.db")" == 600 ]] || fail "data folder must be private"
# Cross-OS: project keys ignore case and separators; ~user isn't expanded as home; relPath keeps '/' paths.
N "$THREADKEEPER_HOME" "import {projectKey} from '$ROOT/src/sync.mjs'; import {relPath} from '$ROOT/src/db.mjs';
  const ok = projectKey('C:\\\\Users\\\\me\\\\My-App')==='my-app' && projectKey('/Users/me/my-app')==='my-app' && projectKey('general')==='general'
    && relPath('/a/app','/a/app/src/x.js')==='src/x.js' && relPath('/a/app','/a/app2/x.js')==='/a/app2/x.js';
  if (!ok) throw new Error('cross-os keys')" || fail "cross-OS project keys and paths"
echo "19. off the record: one session, or a pause for everything"
S=sess-70; j '{}' | $H SessionStart >/dev/null
j '{"prompt":"look at the billing code"}' | $H UserPromptSubmit >/dev/null
for i in 1 2 3; do j '{"tool_name":"Bash","tool_input":{"command":"ls '$i'"}}' | $H PostToolUse; done
OFFR="$(j '{"prompt":"off the record please, this is about salaries"}' | $H UserPromptSubmit)"
[[ "$OFFR" == *"off the record"* ]] || fail "off the record reply: $OFFR"
for i in 1 2 3 4 5 6; do j '{"tool_name":"Edit","tool_input":{"file_path":"'"$PROJ"'/salaries.md"}}' | $H PostToolUse; done
j '{"prompt":"next one"}' | $H UserPromptSubmit >/dev/null
[[ "$(q "select count(*) n from events where session_id='sess-70'")" == '[{"n":0}]' ]] || fail "private session keeps no events"
j '{"reason":"exit"}' | $H SessionEnd
[[ "$(q "select summarized from sessions where id='sess-70'")" == '[{"summarized":-1}]' ]] || fail "private session is not summarized"
[[ "$(N "$THREADKEEPER_HOME" "import {privacyCommand} from '$ROOT/src/privacy.mjs'; console.log([privacyCommand(\"don't remember this session\"), privacyCommand('Back on the record'), privacyCommand('why does the app not remember this setting?'), privacyCommand('fix it')].join(','))")" == "off,on,," ]] || fail "privacy phrases"
node --no-warnings "$ROOT/src/cli.mjs" pause 2 | grep -q "Paused until" || fail "pause"
S=sess-71
[[ "$(j '{}' | $H SessionStart)" == *"threadkeeper is paused"* ]] || fail "paused notice at start"
j '{"prompt":"refactor the parser"}' | $H UserPromptSubmit >/dev/null
for i in 1 2 3 4 5 6; do j '{"tool_name":"Edit","tool_input":{"file_path":"'"$PROJ"'/p.ts"}}' | $H PostToolUse; done
j '{"reason":"exit"}' | $H SessionEnd
[[ "$(q "select count(*) n from events where session_id='sess-71'")" == '[{"n":0}]' ]] || fail "paused: no capture"
node --no-warnings "$ROOT/src/cli.mjs" resume | grep -q "Remembering again" || fail "resume"
S=sess-72; j '{"prompt":"hello there friend"}' | $H UserPromptSubmit >/dev/null
[[ "$(q "select count(*) n from events where session_id='sess-72'")" == '[{"n":1}]' ]] || fail "resumed: capture works"
echo "20. learn which recalled notes Claude uses; mute the ones it never does"
PL="$(mktemp -d)"; mkdir -p "$PL/src"; git -C "$PL" init -q
N "$THREADKEEPER_HOME" "import {openDb,insertMemory} from '$ROOT/src/db.mjs'; const d=openDb();
  insertMemory(d,{project:'$PL',type:'gotcha',title:'Alpha cache needs a warmup',body:'a',files:['a.ts']});
  insertMemory(d,{project:'$PL',type:'decision',title:'Beta queue uses Redis',body:'b'});
  insertMemory(d,{project:'$PL',type:'discovery',title:'Gamma retry noise',body:'c'});
  insertMemory(d,{project:'$PL',type:'note',title:'Delta deploy steps',body:'d'});"
DID="$(q "select id from memories where title='Delta deploy steps'" | grep -o '[0-9]*')"
BID="$(q "select id from memories where title='Beta queue uses Redis'" | grep -o '[0-9]*')"
TR="$PL/t.jsonl"; echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Following note #'"$DID"' for the deploy."}]}}' > "$TR"
jl() { node -e 'console.log(JSON.stringify(Object.assign({session_id:process.argv[1],cwd:process.argv[2],transcript_path:process.argv[3]},JSON.parse(process.argv[4]))))' "$S" "$PL/src" "$TR" "$1"; }
for i in 1 2 3 4; do
  S=learn-$i
  [[ "$(jl '{}' | $H SessionStart)" == *"Gamma retry noise"* ]] || fail "unused note still shown before it is muted ($i)"
  jl '{"tool_name":"mcp__plugin_threadkeeper_threadkeeper__get","tool_input":{"ids":['"$BID"']}}' | $H PostToolUse
  jl '{"tool_name":"Read","tool_input":{"file_path":"'"$PL"'/a.ts"}}' | $H PostToolUse
  jl '{"reason":"exit"}' | $H SessionEnd
  waitfor "select count(*) n from injected_files where session_id='learn-$i'" '[{"n":0}]'
done
[[ "$(q "select title, shown_count s, used_count u from memories where project='$PL' order by id")" == '[{"title":"Alpha cache needs a warmup","s":4,"u":4},{"title":"Beta queue uses Redis","s":4,"u":4},{"title":"Gamma retry noise","s":4,"u":0},{"title":"Delta deploy steps","s":4,"u":4}]' ]] || fail "use counts: $(q "select title, shown_count, used_count from memories where project='$PL'")"
S=learn-5; L5="$(jl '{}' | $H SessionStart)"
[[ "$L5" != *"Gamma retry noise"* && "$L5" == *"Beta queue uses Redis"* ]] || fail "never-used note is muted: ${L5:0:600}"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" usage)" == *"recalled notes Claude used: "*"never-used note(s) no longer load"* ]] || fail "usage shows recall rate: $(node --no-warnings "$ROOT/src/cli.mjs" usage)"
[[ "$(N "$THREADKEEPER_HOME" "import {recallStats} from '$ROOT/src/learn.mjs'; const r=recallStats('$PL'); console.log(r.rate, r.quiet)")" == "0.75 1" ]] || fail "project recall stats"
echo "21. team memory file for teammates"
SH="$(node --no-warnings "$ROOT/src/cli.mjs" share "$PROJ" --link)"
[[ "$SH" == *"CLAUDE.md imports it"* ]] || fail "share: $SH"
grep -q "^## Gotchas" "$PROJ/.claude/team-memory.md" && grep -q "Deploy needs VPN" "$PROJ/.claude/team-memory.md" || fail "team memory content: $(cat "$PROJ/.claude/team-memory.md")"
grep -q "ESSENTIALMARK" "$PROJ/.claude/team-memory.md" || fail "team memory has the brief essentials"
grep -qE "sk-[A-Za-z0-9]{10}|ghp_[A-Za-z0-9]{10}" "$PROJ/.claude/team-memory.md" && fail "team memory must not carry secrets"
node --no-warnings "$ROOT/src/cli.mjs" share "$PROJ" --link >/dev/null
[[ "$(grep -c '@.claude/team-memory.md' "$PROJ/CLAUDE.md")" == 1 ]] || fail "CLAUDE.md import added once"
echo "22. conflicts with pinned rules, searching your own prompts, welcome, weekly savings"
CF="$(mktemp -d)"; mkdir -p "$CF/.git" "$CF/src"
PIN_ID="$(CLAUDE_PROJECT_DIR="$CF" bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}" "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"remember\",\"arguments\":{\"title\":\"OLDFACT always use tabs\",\"body\":\"pinned rule\",\"pin\":true,\"files\":[\"src/fmt.ts\"]}}}" | node --no-warnings '"$ROOT"'/src/mcp.mjs' | grep -o 'Saved as #[0-9]*' | grep -o '[0-9]*')"
[[ -n "$PIN_ID" && "$(q "select pinned from memories where id=$PIN_ID")" == '[{"pinned":1}]' ]] || fail "pinned rule saved"
jc() { node -e 'console.log(JSON.stringify(Object.assign({session_id:process.argv[1],cwd:process.argv[2]},JSON.parse(process.argv[3]))))' "$S" "$CF/src" "$1"; }
S=sess-80; jc '{}' | $H SessionStart >/dev/null
jc '{"prompt":"reformat fmt with spaces from now on"}' | $H UserPromptSubmit >/dev/null
jc '{"tool_name":"Edit","tool_input":{"file_path":"'"$CF"'/src/fmt.ts","new_string":"x"}}' | $H PostToolUse
jc '{}' | $H SessionEnd
waitfor "select summarized from sessions where id='sess-80'" '[{"summarized":1}]'
[[ "$(q "select superseded_at is null live from memories where id=$PIN_ID")" == '[{"live":1}]' ]] || fail "a pinned rule is never retired silently"
[[ "$(q "select count(*) n from conflicts where old_id=$PIN_ID and resolved_at is null")" == '[{"n":1}]' ]] || fail "conflict recorded"
CFC="$(S=sess-81 jc '{}' | $H SessionStart)"
[[ "$CFC" == *"Notes that disagree"*"OLDFACT always use tabs"* ]] || fail "conflict shown at start: ${CFC:0:800}"
CID="$(q "select id from conflicts where old_id=$PIN_ID" | grep -o '[0-9]*')"
[[ "$(CLAUDE_PROJECT_DIR="$CF" mcp "$(call settle_conflict '{"id":'"$CID"',"keep":"old"}')")" == *"Settled"* ]] || fail "settle conflict"
[[ "$(S=sess-82 jc '{}' | $H SessionStart)" == *"Notes that disagree"* ]] && fail "settled conflict no longer shown"
[[ "$(mcp "$(call my_prompts '{"query":"login validation","all_projects":true}')")" == *"fix the login validation"* ]] || fail "my_prompts"
[[ "$(curl -s 'localhost:37791/api/sessions?q=login%20validation')" == *'"match":"fix the login validation'* ]] || fail "viewer: sessions where you wrote it"
[[ "$(curl -s 'localhost:37791/api/home')" == *'"conflicts":[]'* ]] || fail "viewer: settled conflicts gone"
WH="$(mktemp -d)"; echo '{"autoViewer":false}' > "$WH/settings.json"
[[ "$(THREADKEEPER_HOME="$WH" node -e 'console.log(JSON.stringify({session_id:"w1",cwd:process.argv[1]}))' "$CF/src" | THREADKEEPER_HOME="$WH" $H SessionStart)" == *"threadkeeper is on."* ]] || fail "welcome on first session"
[[ "$(THREADKEEPER_HOME="$WH" node -e 'console.log(JSON.stringify({session_id:"w2",cwd:process.argv[1]}))' "$CF/src" | THREADKEEPER_HOME="$WH" $H SessionStart)" == *"threadkeeper is on."* ]] && fail "welcome only once"
[[ "$(node --no-warnings "$ROOT/src/cli.mjs" week)" == *"Memory cost and savings: ~"*"tokens saved by"* ]] || fail "weekly savings line"
# Token diet: tool definitions are sent every session, so Claude Code gets the short versions (Desktop the full ones).
TL='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
CODE_TL="$(mcp "$TL" | tail -1)"; DESK_TL="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$TL" | THREADKEEPER_CLIENT=desktop node --no-warnings "$ROOT/src/mcp.mjs" | tail -1)"
[[ ${#CODE_TL} -lt 3300 && "$CODE_TL" != *save_chat* && "$CODE_TL" != *'"project"'* && "$CODE_TL" == *my_prompts* ]] || fail "short tool list in Claude Code (${#CODE_TL} chars)"
[[ "$DESK_TL" == *save_chat* && "$DESK_TL" == *'"project"'* ]] || fail "full tool list in Desktop"
# Every release names its version in the README and the changelog.
V="$(node -p "require('$ROOT/package.json').version")"
[[ "$(node -p "require('$ROOT/.claude-plugin/plugin.json').version")" == "$V" ]] || fail "plugin.json version"
grep -q "^\*\*Version $V\*\*" "$ROOT/README.md" || fail "README must show version $V"
[[ "$(grep -m1 '^## [0-9]' "$ROOT/CHANGELOG.md")" == "## $V "* ]] || fail "CHANGELOG must start with $V"
echo "13. fuzz: redaction, search queries, de-duplication"
THREADKEEPER_HOME="$(mktemp -d)" node --no-warnings "$ROOT/test/fuzz.mjs" 1500 || fail "fuzz"

[[ -f "$THREADKEEPER_HOME/errors.log" ]] && fail "errors logged"
echo "PASS"
