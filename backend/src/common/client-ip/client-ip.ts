import { isIP } from 'node:net';
import type { Request } from 'express';

// Headers that carry a LIST of addresses (every proxy appends its own hop).
// Their meaning depends on how many proxies are in front of the app, which
// is exactly what Express' `trust proxy` (TRUST_PROXY) already models and
// validates — so they can't be used as a single "this is the client" header
// here: a client can just send its own `X-Forwarded-For: <anything>`.
const LIST_VALUED_HEADERS = new Set(['x-forwarded-for', 'forwarded']);

const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;

// Validates CLIENT_IP_HEADER. Returns the lowercase header name, or null when
// the variable is unset/empty (meaning: rely on `req.ip` alone). Throws on a
// malformed value so a typo fails loudly at startup instead of silently
// falling back to a different IP source than the operator intended.
export function parseClientIpHeader(value: string | undefined): string | null {
  const name = value?.trim().toLowerCase();
  if (!name) return null;
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid CLIENT_IP_HEADER "${value}": expected a plain header name such as "x-real-ip".`,
    );
  }
  if (LIST_VALUED_HEADERS.has(name)) {
    throw new Error(
      `Invalid CLIENT_IP_HEADER "${value}": list-valued headers are resolved through TRUST_PROXY, not CLIENT_IP_HEADER.`,
    );
  }
  return name;
}

// Single place that decides "which IP is this request from". Everything that
// needs a client address (audit log today, rate limiting later) must go
// through here so they can never disagree.
//
// Resolution order:
//   1. The single-valued header named by CLIENT_IP_HEADER (e.g. Railway's
//      `X-Real-IP`), but ONLY when its value is exactly one syntactically
//      valid IPv4/IPv6 address. Anything else (empty, a list, a hostname,
//      garbage) is ignored rather than trusted.
//   2. `req.ip`, which already honours Express' `trust proxy` (TRUST_PROXY).
//
// Trust note: when CLIENT_IP_HEADER is set the header is believed as-is, so
// it must only be set where the platform's edge overwrites that header on
// every request and the app is not reachable around the edge.
export function resolveClientIp(
  req: Pick<Request, 'headers' | 'ip'>,
  headerName: string | null = parseClientIpHeader(process.env.CLIENT_IP_HEADER),
): string | null {
  if (headerName) {
    const raw = req.headers[headerName];
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    if (candidate && isIP(candidate) !== 0) return candidate;
  }
  return req.ip ?? null;
}
