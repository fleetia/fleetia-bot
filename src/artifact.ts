import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export type ArtifactFile = { key: string; path: string; size: number; sha256: string };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm',
};

export function contentType(key: string): string {
  return MIME[extname(key)] ?? 'application/octet-stream';
}

export function cacheControl(key: string): string {
  if (/^assets\/.+-[a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?|png|webp|svg)$/.test(key)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

export function uploadOrder(files: ArtifactFile[]): ArtifactFile[] {
  const rank = (file: ArtifactFile): number => file.key === 'sw.js' ? 2 : file.key.endsWith('.html') ? 1 : 0;
  return [...files].sort((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key));
}

export async function inspectArtifact(directory: string): Promise<ArtifactFile[]> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Artifact root must be a regular directory');
  }
  const files: ArtifactFile[] = [];
  let total = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_control') || entry.name === '__fleetia.json') {
        throw new Error(`Unsupported artifact entry: ${entry.name}`);
      }
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(directory, key);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error('Artifact symlinks are not allowed');
      }
      if (stat.isDirectory()) {
        await walk(key);
      } else if (stat.isFile()) {
        total += stat.size;
        if (total > 250 * 1024 * 1024 || files.length >= 10_000) {
          throw new Error('Artifact exceeds preview size limits');
        }
        files.push({ key, path, size: stat.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
      } else {
        throw new Error('Artifact contains a non-regular file');
      }
    }
  }
  await walk('');
  if (!files.some((file) => file.key === 'index.html') || !files.some((file) => file.key === 'sw.js')) {
    throw new Error('KBO artifact must contain index.html and sw.js at its root');
  }
  return uploadOrder(files);
}
