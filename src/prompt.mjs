// What the user actually asked, without the wrapper text some apps put around a prompt.
// Claude project threads (and Remote Control) deliver each message inside <wake …>/<relay …> envelopes with ids,
// times and system notes; Claude Code slash commands arrive as <command-name> tags. Stored as-is, the first few
// hundred characters were all wrapper, so recall, summaries and the "your requests" list after a compaction
// showed XML instead of "publish 1cb3905a".

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|#34);/g, (_, k) => ENT[k]);
const squash = (s) => decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Blocks that never carry the user's words.
const DROP = /<(system-reminder|system-note|session-context|local-command-stdout|local-command-stderr|local-command-caveat)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;

function inner(text, tag, attrTest) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  for (const m of text.matchAll(re)) if (!attrTest || attrTest(m[1])) out.push(m[2]);
  return out;
}

/** The user's own words from a raw prompt. Plain prompts come back unchanged (trimmed). */
export function promptText(raw) {
  let t = String(raw ?? '');
  if (!t.includes('<')) return t.trim();
  t = t.replace(DROP, '');

  // Claude Code slash command: "/name args".
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/i.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/i.exec(t)?.[1]?.trim();
    return squash(`${cmd[1]}${args ? ' ' + args : ''}`);
  }

  const parts = [];
  if (/<wake\b/i.test(t)) {
    // Messages people wrote; the one that woke the session (trigger="true") first.
    const human = (a) => /from="human"/i.test(a) || /trust="(principal|peer)"/i.test(a);
    const msgs = inner(t, 'message', (a) => human(a) && /trigger="true"/i.test(a));
    parts.push(...(msgs.length ? msgs : inner(t, 'message', human)));
  }
  if (/<relay\b|<coordinator-relay\b/i.test(t)) {
    for (const c of inner(t, 'cited')) parts.push(c);
    for (const n of inner(t, 'note')) parts.push(`(relayed) ${n}`);
  }
  if (parts.length) return squash(parts.map((p) => p.replace(DROP, '').trim()).filter(Boolean).join('\n'));

  // Anything else: drop wrapper blocks that are only envelopes, keep the rest.
  const left = squash(t.replace(/<\/?(wake|project|thread|relay|coordinator-relay)\b[^>]*>/gi, ''));
  return left || String(raw).trim();
}
