// Strip private blocks and obvious secrets before anything is stored.

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/gi,
];

const KV_SECRET = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)(?!(?:\d+|true|false|null|none|undefined)\b)[^\s"'`,;]{4,}\3/gi;

const SENSITIVE_FILE = /(^|[\/\\])(\.env(\..*)?|.*\.pem|.*\.key|id_rsa|id_ed25519|credentials(\.json)?|\.npmrc|\.netrc)$/i;

export function isSensitivePath(p) {
  return typeof p === 'string' && SENSITIVE_FILE.test(p);
}

export function redact(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(/<private>[\s\S]*?<\/private>/gi, '[private]');
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, g1) => (typeof g1 === 'string' && /bearer/i.test(g1) ? `${g1}[redacted]` : '[redacted]'));
  }
  s = s.replace(KV_SECRET, (_m, k, sep) => `${k}${sep}[redacted]`);
  return s;
}

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
