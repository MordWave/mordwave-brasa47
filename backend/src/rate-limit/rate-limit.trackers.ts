import { normalizeIp } from '@nestjs/throttler';
import type { Request } from 'express';
import { resolveClientIp } from '../common/client-ip/client-ip.js';

// Mirrors CreateOrderDto / SessionStatusQueryDto's @MaxLength(128): anything
// longer can't be a real token, so it's not worth a counter of its own.
const MAX_SESSION_TOKEN_LENGTH = 128;

// Trackers identify WHO a counter belongs to. They only ever read data that
// exists before authentication (resolved IP, body) or that a guard already
// verified (req.user, set by JwtAuthGuard). They never decode a JWT
// themselves.

// The one IP source (CLIENT_IP_HEADER / TRUST_PROXY, via resolveClientIp).
// IPv6 is collapsed to its /64 and IPv4-mapped IPv6 to plain IPv4 so a
// client can't dodge a counter by rotating addresses inside its own subnet.
export function ipTracker(req: Pick<Request, 'headers' | 'ip'>): string {
  const ip = resolveClientIp(req);
  return `ip:${ip ? normalizeIp(ip) : 'unknown'}`;
}

// Authenticated user id. Falls back to the IP tracker when there is no user
// (never the case after JwtAuthGuard, but a route misconfigured without it
// must still be limited rather than unlimited).
export function userTracker(req: Pick<Request, 'headers' | 'ip'> & { user?: { id?: unknown } }): string {
  const id = req.user?.id;
  return typeof id === 'string' && id.length > 0 ? `user:${id}` : ipTracker(req);
}

// Per table session. The token is client-supplied and not yet validated at
// this point (the endpoint's own validation decides whether the request is
// valid), so an absent / non-string / empty / oversized value falls back to
// the IP tracker.
export function sessionTracker(
  req: Pick<Request, 'headers' | 'ip'> & { body?: unknown },
): string {
  const body = req.body as { sessionToken?: unknown } | undefined;
  const token = body?.sessionToken;
  if (typeof token === 'string' && token.length > 0 && token.length <= MAX_SESSION_TOKEN_LENGTH) {
    return `session:${token}`;
  }
  return ipTracker(req);
}
