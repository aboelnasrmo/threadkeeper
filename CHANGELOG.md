# Changelog

Every release, newest first. The version is also shown at the top of the README and by `cli.mjs doctor`.

## 0.17.0 (2026-11-05)
Saving tokens in the project work itself, not only in what threadkeeper adds.
- **Noise-file guard**: the first full read of a lockfile, minified or generated file, build output, or any file over 80 KB is stopped with a hint (Grep it, or read a slice). Reading again goes through. Settings: `noiseGuard`, `bigReadBytes`.
- **Repeat-search guard**: the same Grep or Glob again, with nothing edited or run since and no compaction, is stopped once (its results are still above). Running it again goes through. Setting: `searchGuard`.
- **Where tokens go**: `tokens [folder] [days]` and a new card on each project's viewer overview list the biggest file reads, files re-read in one session, the CLAUDE.md files loaded into every session, and compactions, with concrete tips (trim CLAUDE.md, block noisy files in `permissions.deny`, split big files that keep coming back).
- Savings counted by guards are taken back when Claude reads again anyway, so the "saved" number stays honest.

## 0.16.0 (2026-11-05)
Token diet: what threadkeeper itself adds to every Claude Code session is about 40% smaller.
- Tool definitions (sent every session): about 1,540 → 710 tokens. Claude Code gets short descriptions without the Desktop-only tools and arguments; Claude Desktop keeps the full versions.
- Session start: notes from older local sessions no longer spill into "Other recent notes" (that section is only for synced and imported notes); shorter header, footer and note lines. A realistic project went from about 1,030 → 780 tokens.
- The memory skill's description (always loaded) is 40% shorter; recall headers and the re-read message are shorter.
- Re-read guard also stops re-reading a large slice of a file already read in full and unchanged.

## 0.15.0 (2026-11-05)
- **Notes that disagree**: when a session goes against an earlier note and it isn't clear which is right, both are flagged instead of one being dropped silently. Rules you pinned are never retired silently anymore (by summaries or the brief). Claude sees open disagreements at session start and settles them with you (`settle_conflict`); the viewer's overview has Keep older / Keep newer / Both are fine.
- **Search your own past prompts**: new `my_prompts` tool ("what did I say about X last week"), and the viewer's Sessions tab search finds the sessions where you wrote something.
- **Welcome**: a new user's first session shows one line on what threadkeeper does and where the viewer is.
- **Weekly savings line**: "This week" (and `week`) starts with tokens added, tokens saved, summary calls and the share of recalled notes Claude used.

## 0.14.0 (2026-11-05)
- **Off the record**: say "off the record" and that session is kept out of memory (what was captured so far is deleted; nothing is saved or synced). "Back on the record" undoes it. **Pause** everything for 1, 4 or 24 hours or until you resume, from the viewer or with `pause` / `resume`. A session can also be made private afterwards in the viewer.
- **Learns what Claude uses**: every recalled note is checked at session end (opened, mentioned by `#id`, or its files worked on). Notes shown 4 times and never used stop loading by themselves for 30 days; they stay searchable. The viewer and `usage` show the share of recalled notes used.
- **Team memory**: `share --link` (or "Share with team" in the viewer) writes the brief's essentials, decisions and gotchas to `.claude/team-memory.md`, imported from `CLAUDE.md`, so teammates' Claude knows them. Refreshed daily.
- Viewer: select several notes to pin, mark outdated, mark done or forget at once; "Search by meaning too" when words find little; export a project as one Markdown file.
- Tests on every OS: `test/smoke.mjs` (Node only) runs on macOS, Windows and Linux with Node 22 and 24 in GitHub Actions; badge in the README.
- Public releases are tagged, with release notes on GitHub.

## 0.13.1 (2026-11-05)
- Viewer: token use per project. Each project's overview shows tokens added, tokens saved and summary-model calls for the last 7 days, and the all-projects overview has a "Tokens by project" table.
- A viewer left running from a very old version (before 0.4.4) is now stopped and replaced at the next session start (macOS and Linux), instead of showing an empty page until a reboot.

## 0.13.0 (2026-11-05)
- Viewer overview page: totals, tokens added and saved, a 30-day activity chart, note types, latest notes, open todos and the project brief.
- Notes are colour-coded by type; a "needs a check" filter shows notes whose files changed a lot.
- Light / dark / automatic theme switch; keyboard shortcuts (`j`/`k`, `1`–`4`, `p`, `e`, `d`, `h`, `?`).
- Session replay: counts of prompts, tool calls, edits and failures; long runs of tool calls fold away; filters for your prompts or failures.
- Copy a note or a file path in one click; small confirmations after each action.
- The live refresh no longer redraws unchanged parts, so focus and scroll stay put.
- Works on a phone-sized window (one panel at a time).
- README: credits to claude-mem, which inspired this project.

## 0.12.2 (2026-11-05)
- Windows: summaries work when Claude Code was installed with npm (`claude.cmd`); `claude.exe` is used when present.
- Windows and macOS: one folder is one project, whatever the letter case or drive-letter case (`c:\` vs `C:\`).
- Sync: project names match regardless of case (`My-App` and `my-app` share notes).
- `restore` stops the viewer first (it failed on Windows); the viewer opens the browser on Windows and Linux too.
- `ignoreProjects` matches on Windows; `~user` paths are no longer read as your home folder.
- README: "Why use it" and "Troubleshooting by OS".

## 0.12.1 (2026-11-05)
- The data folder and database are readable by your user account only (0700 / 0600).
- Tests build their fake secrets at run time, so secret scanners don't raise false alarms.

## 0.12.0 (2026-11-05)
- Preferences that apply in every project: "always…/never…" about how you like to work is saved once and loads everywhere (and for helper agents). `remember` takes `everywhere`.
- Encrypted sync: `encrypt` seals each machine's sync file with AES-256-GCM; the key stays on your machines.

## 0.11.0 (2026-11-05)
- Helper agents (Explore, Plan, …) start with the brief and your rules.
- Notes about heavily rewritten files are labelled "check" (daily, from git).
- Claude Desktop reads the brief and saves chats (`save_chat`).
- Nightly backups (7 kept), `backup` / `restore`; weekly report (`week`, viewer "This week" tab).

## 0.10.0 (2026-11-05)
- Settled investigation chains ("suspect X", "ruled out", "fixed by Y") merge into one note with the final answer.
- Faster tag backfill for big imported histories; file notes are shorter, gotchas and decisions first.

## 0.9.0 (2026-11-05)
- Notes go to the repo the work was about, not the folder Claude ran in.
- Prompt recall is stricter and uses about half the tokens.
- Unsummarized sessions in other projects are caught up from any session start; month-old todos load as a count.

## 0.8.0 (2026-11-05)
- Search by meaning (tags added by the summary model, no vector database), newer notes rank higher.
- Status line at session start, bundled memory skill, git commits feed the brief, `export`.

## 0.7.0 (2026-11-05)
- Re-read guard: an unchanged file already read in full isn't read again.
- Only the brief's Essentials load at start (about 750 tokens).

## 0.6.0 (2026-11-05)
- Leaner context on resume and after compaction; notes are never shown twice; compressed summarizer input.
- Standing rules pin themselves; daily housekeeping; usage meter.

## 0.5.1 (2026-11-05)
- About half the tokens at session start without losing context.

## 0.5.0 (2026-11-05)
- Project brief, outdated notes, checkpoints in long sessions, recovery of missed sessions, smarter search, health notices.

## 0.4.x (2026-11-05)
- First release: hooks capture sessions, Haiku summarizes them, recall at session start, search tools, viewer, sync between machines, Claude Desktop, Windows support.
