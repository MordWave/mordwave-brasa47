import { registerAs } from '@nestjs/config';
import { parseClientIpHeader } from '../common/client-ip/client-ip.js';

// Express's `trust proxy` setting — controls how req.ip (and the
// X-Forwarded-For chain) is resolved. Configurable per environment rather
// than hardcoded for Railway's specific proxy topology, so the trusted hop
// count/policy can be retuned independently once this sits behind a
// different reverse proxy (AWS ALB/CloudFront) later, with no code change.
//
// TRUST_PROXY accepts:
//   unset / "false" -> false (never trust any forwarded header — the safe
//     default; req.ip is the raw socket address, which is wrong behind any
//     real proxy but never lets a client spoof its own IP)
//   "true"          -> true (trust every hop in the chain — only
//     appropriate when every hop is fully controlled; otherwise a client
//     can spoof X-Forwarded-For to fake its own IP). Supported for
//     completeness/local testing, but AVOID in production: prefer an
//     explicit hop count below, which is exact instead of "trust anything
//     upstream says" and doesn't silently over-trust if the proxy topology
//     ever gains an extra hop.
//   a non-negative integer, e.g. "1" -> that many hops (from the socket
//     inward) are trusted — the common case of exactly one reverse
//     proxy/load balancer in front of this app, and the recommended
//     production setting (e.g. "1" for Railway's own edge; re-tune when
//     this moves behind AWS ALB/CloudFront, which may add another hop)
export function resolveTrustProxy(value: string | undefined): boolean | number {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : false;
}

export default registerAs('security', () => ({
  trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),
  // CLIENT_IP_HEADER (e.g. "x-real-ip") — see common/client-ip/client-ip.ts.
  // Validated here so a malformed value stops the app at startup.
  clientIpHeader: parseClientIpHeader(process.env.CLIENT_IP_HEADER),
}));
