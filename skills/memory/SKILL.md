---
name: memory
description: Use threadkeeper (memory of past sessions in this project) before digging into a bug, error, config or area not touched this session, and when the user says "remember", "last time", "we already" or "why did we".
---

# Using threadkeeper

Your session already starts with the project brief's essentials, open todos, pinned rules and the latest session. Everything else is one cheap call away. Prefer these over re-reading code or re-running experiments.

1. **Before investigating**, `search` with 2-4 specific words (an error string, file name, component). Results are short lines with `#id`s; costs ~50 tokens per hit.
2. **Only then** `get` the 1-3 ids that matter. Use `timeline` on one id to see what happened around it.
3. **Before larger work** in this project, read the full `brief` once.
4. **When a note is wrong** (you just proved otherwise), `remember` the corrected fact, then `mark_outdated` the old id with `replaced_by`.
5. **When the user states a standing rule** ("always…", "never…"), `remember` it with `pin: true`.
6. **When work is finished** that matches an open todo, `resolve_todo` it.

Don't paste memory results back to the user unless asked; use them. Notes can be stale: verify against the code before acting on anything risky.
