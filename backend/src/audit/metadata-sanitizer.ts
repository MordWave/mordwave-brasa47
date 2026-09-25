// Applied unconditionally inside AuditService.record() — never left as a
// convention callers must remember. Guards against three distinct risks in
// arbitrary metadata (a raw request body/DTO, in most call sites):
//   1. secrets: any key whose name matches SENSITIVE_KEY_PATTERN is dropped
//      entirely (not even a placeholder — never hints at a secret's shape).
//   2. runaway size: a single long string (e.g. a base64-encoded image
//      someone accidentally passed as "metadata") is truncated well before
//      it could dominate the ~16 KB budget; as a last resort, if the
//      sanitized result is still over budget, it's replaced with a small
//      marker rather than silently dropped or thrown.
//   3. excessive depth: a pathological/circular-ish nested object is capped
//      rather than walked forever.
const SENSITIVE_KEY_PATTERN = /password|secret|token|jwt|authorization|api[-_]?key/i;
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 50;
const MAX_METADATA_BYTES = 16 * 1024;

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;
}

function stripSensitive(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[max depth exceeded]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value !== 'object') return value; // number, boolean

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => stripSensitive(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    result[key] = stripSensitive(val, depth + 1);
  }
  return result;
}

// Never throws — worst case for a malformed/oversized input is an empty or
// marker object, never a failed audit write over a metadata problem alone.
export function sanitizeMetadata(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined || typeof input !== 'object') {
    return {};
  }

  let cleaned: Record<string, unknown>;
  try {
    cleaned = stripSensitive(input, 0) as Record<string, unknown>;
  } catch {
    return {};
  }

  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _unserializable: true };
  }

  if (Buffer.byteLength(json, 'utf8') <= MAX_METADATA_BYTES) {
    return cleaned;
  }

  return {
    _truncated: true,
    _originalSizeBytes: Buffer.byteLength(json, 'utf8'),
  };
}
