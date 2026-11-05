# Changelog

Every release, newest first. The version is also shown at the top of the README and by `cli.mjs doctor`.

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
