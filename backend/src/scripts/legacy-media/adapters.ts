import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FetchedBytes, HttpProbe, Manifest, ManifestStore, ProbeResponse, SourceStore } from './types.js';

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 10 * 1024 * 1024;

async function readBounded(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('response too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('response too large');
  return bytes;
}

// Supabase public object URL (no credentials involved). Redirects are not
// followed: a public object is served directly.
export class HttpSourceStore implements SourceStore {
  async download(url: string): Promise<FetchedBytes> {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, contentType: res.headers.get('content-type'), bytes: res.status === 200 ? await readBounded(res) : Buffer.alloc(0) };
  }
}

export class FetchHttpProbe implements HttpProbe {
  private async request(url: string, method: 'GET' | 'HEAD', follow: boolean): Promise<ProbeResponse> {
    const res = await fetch(url, { method, redirect: follow ? 'follow' : 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const bytes = method === 'GET' && res.status === 200 ? await readBounded(res) : Buffer.alloc(0);
    return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type'), bytes };
  }
  get(url: string, options: { followRedirects: boolean }): Promise<ProbeResponse> {
    return this.request(url, 'GET', options.followRedirects);
  }
  head(url: string): Promise<ProbeResponse> {
    return this.request(url, 'HEAD', false);
  }
}

// JSON manifest on local disk, written atomically (temp file + rename) after
// every state change, owner-only permissions. Holds ids, storage paths/keys,
// hashes, sizes and statuses — never a secret or a URL.
export class FileManifestStore implements ManifestStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(manifest: Manifest): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }
}
