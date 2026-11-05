// Off the record: one session ("don't remember this session") or everything for a while (`pause`, viewer button).
// Memory still loads and search still works; only capture and summaries stop. Nothing is synced from a private session.
import { openDb, now } from './db.mjs';

const setState = (d, key, value) => value == null
  ? d.prepare('DELETE FROM sync_state WHERE key = ?').run(key)
  : d.prepare('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const getState = (d, key) => d.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;

// Said near the start of a prompt (or as a short prompt of its own), so talk *about* the phrase doesn't trigger it.
const OFF = /^\W{0,3}(?:please\s+)?(?:(?:don'?t|do not|stop)\s+(?:remember|record|save|recording|saving|remembering)(?:\s+(?:this|anything|any of this))?(?:\s+(?:session|chat|conversation))?|off the record|private (?:session|mode))\b/i;
const ON = /^\W{0,3}(?:please\s+)?(?:back on the record|(?:start|resume|continue)\s+(?:remembering|recording|saving)|remember this (?:session|chat) again|end private (?:session|mode))\b/i;

/** 'off' | 'on' | null for a prompt. */
export function privacyCommand(prompt) {
  const p = String(prompt || '').trim();
  if (ON.test(p)) return 'on';
  if (OFF.test(p)) return 'off';
  return null;
}

export const isPrivate = (sessionId, d = openDb()) => !!getState(d, 'private:' + sessionId);

/** Mark a session private and drop what was captured or written from it so far. */
export function makePrivate(sessionId, d = openDb()) {
  setState(d, 'private:' + sessionId, now());
  d.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  d.prepare("DELETE FROM memories WHERE session_id = ? AND source = 'auto' AND pinned = 0").run(sessionId);
  d.prepare('UPDATE sessions SET prompts = 0, tool_calls = 0, edits = 0, summarized = -1, summarized_upto = 0 WHERE id = ?').run(sessionId);
}

export function makePublic(sessionId, d = openDb()) {
  setState(d, 'private:' + sessionId, null);
  d.prepare('UPDATE sessions SET summarized = 0 WHERE id = ?').run(sessionId);
}

/** ISO time memory is paused until, or null. 'forever' pauses until `resume`. */
export function pausedUntil(d = openDb()) {
  const v = getState(d, 'paused_until');
  if (!v) return null;
  if (v !== 'forever' && Date.parse(v) <= Date.now()) { setState(d, 'paused_until', null); return null; }
  return v;
}

export function pause(hours, d = openDb()) {
  const v = hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : 'forever';
  setState(d, 'paused_until', v);
  return v;
}

export const resume = (d = openDb()) => setState(d, 'paused_until', null);

/** Capture is off for this session right now. */
export const offRecord = (sessionId, d = openDb()) => !!pausedUntil(d) || isPrivate(sessionId, d);

export const pausedText = (v) => v === 'forever' ? 'until you resume it' : `until ${new Date(v).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
