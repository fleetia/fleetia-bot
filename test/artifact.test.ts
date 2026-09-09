import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheControl, contentType, inspectArtifact } from '../src/artifact';

const directories: string[] = [];

async function artifact(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fleetia-artifact-'));
  directories.push(directory);
  await mkdir(join(directory, 'assets'));
  await mkdir(join(directory, 'data'));
  for (const [key, body] of Object.entries({
    'index.html': '<html>KBO</html>', 'sw.js': 'self.addEventListener("fetch", () => {});',
    'assets/index-CkwbtFWA.js': 'export const app = true;', 'assets/index-B7xAnsmG.css': 'body {}',
    'data/2025.json': '{}', 'manifest.webmanifest': '{}', 'favicon.svg': '<svg/>',
  })) {
    await writeFile(join(directory, key), body);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('KBO artifact inspection', () => {
  it('reads actual build filename patterns, fingerprints files and publishes HTML then SW last', async () => {
    const directory = await artifact();
    const files = await inspectArtifact(directory);
    expect(files.map((file) => file.key).slice(-2)).toEqual(['index.html', 'sw.js']);
    expect(files.find((file) => file.key === 'data/2025.json')).toMatchObject({
      size: 2, sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    });
    expect(files).toHaveLength(7);
  });

  it('caches only content-hashed assets indefinitely and revalidates mutable app files', () => {
    expect(cacheControl('assets/index-CkwbtFWA.js')).toContain('immutable');
    expect(cacheControl('assets/index-B7xAnsmG.css')).toContain('immutable');
    for (const key of ['index.html', 'sw.js', 'data/2025.json', 'manifest.webmanifest', 'assets/index.js']) {
      expect(cacheControl(key)).toBe('no-cache');
    }
    expect(contentType('assets/index-CkwbtFWA.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('manifest.webmanifest')).toBe('application/manifest+json');
  });

  it.each(['index.html', 'sw.js'])('rejects a build missing root %s', async (key) => {
    const directory = await artifact();
    await rm(join(directory, key));
    await expect(inspectArtifact(directory)).rejects.toThrow('index.html and sw.js');
  });

  it.each(['_control', '__fleetia.json', '.env', 'bad\\name.js'])('rejects reserved or unsafe artifact entry %s', async (key) => {
    const directory = await artifact();
    await writeFile(join(directory, key), 'private');
    await expect(inspectArtifact(directory)).rejects.toThrow('Unsupported artifact entry');
  });

  it('does not follow file or directory symlinks out of the artifact', async () => {
    const directory = await artifact();
    await symlink('../index.html', join(directory, 'assets', 'leak.html'));
    await expect(inspectArtifact(directory)).rejects.toThrow('symlink');
    await rm(join(directory, 'assets', 'leak.html'));
    await symlink('../data', join(directory, 'assets', 'linked-data'));
    await expect(inspectArtifact(directory)).rejects.toThrow('symlink');
  });

  it('rejects an artifact root which is itself a symlink', async () => {
    const directory = await artifact();
    const link = `${directory}-link`;
    directories.push(link);
    await symlink(directory, link);
    await expect(inspectArtifact(link)).rejects.toThrow();
  });
});
