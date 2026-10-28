// The public origin a shared link points at (https://web.example.test) is never taken from a request header: the web server hands it
// over as a query value, and it is only believed when it is one of the frontend origins this API already trusts for CORS
// (FRONTEND_URL, comma-separated, the same default as main.ts).
const DEFAULT_FRONTEND_URL = 'http://localhost:5173';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// "https://host" for a bare http(s) origin, or null: no credentials, path, query or fragment, and http only for localhost.
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const isLocal = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null;
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '') return null;
  return url.origin;
}

export function allowedFrontendOrigins(frontendUrl: string | undefined = process.env.FRONTEND_URL): string[] {
  return (frontendUrl ?? DEFAULT_FRONTEND_URL)
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter((origin): origin is string => origin !== null);
}

// The requested origin, normalised, when it is an allowed frontend origin; null otherwise.
export function allowedOrigin(requested: unknown, allowed: readonly string[]): string | null {
  const origin = normalizeOrigin(requested);
  return origin !== null && allowed.includes(origin) ? origin : null;
}
