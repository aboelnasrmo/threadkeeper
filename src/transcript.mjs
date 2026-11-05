// Pull Claude's own replies out of a Claude Code transcript (JSONL) to give the summarizer the "why", not just the "what".
import fs from 'node:fs';
import { redact, clip } from './redact.mjs';

const MAX_READ = 8 * 1024 * 1024; // only read the tail of very long transcripts

export function assistantReplies(transcriptPath, { since, maxChars = 6000, perReply = 600 } = {}) {
  if (!transcriptPath) return [];
  let text;
  try {
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, MAX_READ);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    if (since && o.timestamp && o.timestamp < since) continue;
    const content = o.message?.content;
    const parts = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text) : typeof content === 'string' ? [content] : [];
    const t = parts.join('\n').trim();
    if (t) out.push(clip(redact(t), perReply));
  }
  // Keep the most recent replies within budget.
  const kept = [];
  let used = 0;
  for (let i = out.length - 1; i >= 0 && used < maxChars; i--) {
    kept.unshift(out[i]);
    used += out[i].length;
  }
  return kept;
}
