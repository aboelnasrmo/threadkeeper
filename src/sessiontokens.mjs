// Real token use, from Claude Code's own session log (the transcript): every reply records how many tokens the
// model was sent (the whole conversation so far, mostly from cache) and wrote. threadkeeper never estimates these.
import fs from 'node:fs';

const MAX_SCAN = 256 * 1024 * 1024;

function usageOf(line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let m;
  try { m = JSON.parse(line); } catch { return null; }
  if (m.type !== 'assistant' || m.isSidechain || !m.message?.usage) return null;
  const u = m.message.usage;
  const cacheRead = u.cache_read_input_tokens || 0;
  const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cacheRead;
  return { id: m.message.id || m.requestId || m.uuid, ctx, cacheRead, out: u.output_tokens || 0 };
}

/** Totals for one session: tokens sent to the model (all turns), the part read from cache, written, peak context. */
export function transcriptTokens(file) {
  const r = { turns: 0, input: 0, cached: 0, output: 0, peak: 0, compactions: 0 };
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SCAN) return null;
    const seen = new Set();
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let rest = '', pos = 0, n;
    const take = (line) => {
      if (line.includes('"compact_boundary"')) { r.compactions++; return; }
      const u = usageOf(line);
      if (!u || seen.has(u.id)) return;
      seen.add(u.id);
      r.turns++; r.input += u.ctx; r.cached += u.cacheRead; r.output += u.out;
      if (u.ctx > r.peak) r.peak = u.ctx;
    };
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      pos += n;
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = lines.pop();
      for (const l of lines) take(l);
    }
    if (rest) take(rest);
    fs.closeSync(fd);
  } catch { return null; }
  return r.turns ? r : null;
}

/** How big the conversation is right now: the context of the latest reply (or what is left after a compaction). */
export function currentContext(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.includes('"compact_boundary"')) {
        try { return JSON.parse(l).compactMetadata?.postTokens || 0; } catch { return 0; }
      }
      const u = usageOf(l);
      if (u) return u.ctx;
    }
  } catch {}
  return 0;
}
