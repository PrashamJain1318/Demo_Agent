import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CacheScanner } from '../../src/scanner/cache/CacheScanner.js';

describe('CacheScanner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-scanner-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('1. returns empty list when scanning an empty directory', async () => {
    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.rootPath).toBe(path.resolve(tempDir));
    expect(result.caches).toEqual([]);
    expect(result.totalCacheSizeBytes).toBe(0);
    expect(result.totalCacheEntries).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('2. detects npm .npm cache directory', async () => {
    const npmDir = path.join(tempDir, '.npm');
    await fs.mkdir(npmDir, { recursive: true });
    await fs.writeFile(path.join(npmDir, 'anonymous-cli-metrics.json'), '{"metrics":1}');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('npm');
    expect(entry.detectedBy).toBe('npm-cache-dir');
    expect(entry.relativePath).toBe('.npm');
    expect(entry.sizeBytes).toBe('{"metrics":1}'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('3. detects pnpm .pnpm-store cache directory', async () => {
    const pnpmDir = path.join(tempDir, '.pnpm-store');
    await fs.mkdir(pnpmDir, { recursive: true });
    await fs.writeFile(path.join(pnpmDir, 'store.db'), 'pnpm-data');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('pnpm');
    expect(entry.detectedBy).toBe('pnpm-store-dir');
    expect(entry.relativePath).toBe('.pnpm-store');
    expect(entry.sizeBytes).toBe('pnpm-data'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('4. detects yarn .yarn/cache directory', async () => {
    const yarnDir = path.join(tempDir, '.yarn', 'cache');
    await fs.mkdir(yarnDir, { recursive: true });
    await fs.writeFile(path.join(yarnDir, 'pkg.zip'), 'zip-data');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('yarn');
    expect(entry.detectedBy).toBe('yarn-cache-dir');
    expect(entry.relativePath).toBe(path.join('.yarn', 'cache'));
    expect(entry.sizeBytes).toBe('zip-data'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('5. detects Python __pycache__ directory', async () => {
    const pycacheDir = path.join(tempDir, 'app', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    await fs.writeFile(path.join(pycacheDir, 'module.cpython-311.pyc'), 'compiled-bytecode');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('python');
    expect(entry.detectedBy).toBe('python-pycache');
    expect(entry.relativePath).toBe(path.join('app', '__pycache__'));
    expect(entry.sizeBytes).toBe('compiled-bytecode'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('6. detects Next.js .next/cache directory', async () => {
    const nextDir = path.join(tempDir, '.next', 'cache');
    await fs.mkdir(nextDir, { recursive: true });
    await fs.writeFile(path.join(nextDir, 'build.json'), '{"build":"ok"}');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('next');
    expect(entry.detectedBy).toBe('next-cache-dir');
    expect(entry.relativePath).toBe(path.join('.next', 'cache'));
    expect(entry.sizeBytes).toBe('{"build":"ok"}'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('7. detects Vite node_modules/.vite directory', async () => {
    const viteDir = path.join(tempDir, 'node_modules', '.vite');
    await fs.mkdir(viteDir, { recursive: true });
    await fs.writeFile(path.join(viteDir, 'deps.json'), 'vite-deps');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('vite');
    expect(entry.detectedBy).toBe('vite-cache-dir');
    expect(entry.relativePath).toBe(path.join('node_modules', '.vite'));
    expect(entry.sizeBytes).toBe('vite-deps'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('8. detects Gradle .gradle/caches directory', async () => {
    const gradleDir = path.join(tempDir, '.gradle', 'caches');
    await fs.mkdir(gradleDir, { recursive: true });
    await fs.writeFile(path.join(gradleDir, 'journal-1.lock'), 'locked');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    expect(entry.type).toBe('gradle');
    expect(entry.detectedBy).toBe('gradle-caches-dir');
    expect(entry.relativePath).toBe(path.join('.gradle', 'caches'));
    expect(entry.sizeBytes).toBe('locked'.length);
    expect(entry.entryCount).toBe(1);
  });

  it('9. detects generic cache directory named cache, caches, or .cache', async () => {
    await fs.mkdir(path.join(tempDir, 'cache'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'sub', 'caches'), { recursive: true });
    await fs.mkdir(path.join(tempDir, '.cache'), { recursive: true });
    // Non-matching directory with substring
    await fs.mkdir(path.join(tempDir, 'cache-backup'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'cache', 'a.txt'), 'data-a');
    await fs.writeFile(path.join(tempDir, 'sub', 'caches', 'b.txt'), 'data-b');
    await fs.writeFile(path.join(tempDir, '.cache', 'c.txt'), 'data-c');
    await fs.writeFile(path.join(tempDir, 'cache-backup', 'd.txt'), 'ignored');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    const relativePaths = result.caches.map((c) => c.relativePath).sort();
    expect(relativePaths).toEqual(['.cache', 'cache', path.join('sub', 'caches')].sort());
    for (const entry of result.caches) {
      expect(entry.type).toBe('generic');
      expect(entry.detectedBy).toBe('generic-cache-dir');
    }
  });

  it('10 & 11. accurately calculates size in bytes and counts entries recursively', async () => {
    const cacheDir = path.join(tempDir, 'cache');
    const subDir = path.join(cacheDir, 'sub');
    await fs.mkdir(subDir, { recursive: true });

    const file1 = 'Hello 1'; // 7 bytes
    const file2 = 'World 222'; // 9 bytes
    await fs.writeFile(path.join(cacheDir, 'file1.txt'), file1);
    await fs.writeFile(path.join(subDir, 'file2.txt'), file2);

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    const entry = result.caches[0];
    // 2 files + 1 subdirectory inside cache = 3 entries
    expect(entry.entryCount).toBe(3);
    expect(entry.sizeBytes).toBe(7 + 9);
    expect(result.totalCacheSizeBytes).toBe(16);
    expect(result.totalCacheEntries).toBe(3);
  });

  it('12. recursively calculates deeply nested directories within a cache', async () => {
    const deepDir = path.join(tempDir, '.npm', 'level1', 'level2', 'level3');
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, 'data.bin'), 'deep-data'); // 9 bytes

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(1);
    // level1, level2, level3, data.bin = 4 entries
    expect(result.caches[0].entryCount).toBe(4);
    expect(result.caches[0].sizeBytes).toBe(9);
  });

  it('13. skips symbolic links without following them', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-target-'));
    try {
      const secretFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(secretFile, '12345678901234567890'); // 20 bytes

      const cacheDir = path.join(tempDir, 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, 'regular.txt'), 'regular'); // 7 bytes

      // Symlink to outside file
      await fs.symlink(secretFile, path.join(cacheDir, 'symlink-file'));
      // Symlink to outside directory
      await fs.symlink(outsideDir, path.join(cacheDir, 'symlink-dir'));

      const scanner = new CacheScanner();
      const result = await scanner.scan({ rootPath: tempDir });

      expect(result.caches).toHaveLength(1);
      const entry = result.caches[0];
      // Only regular.txt was counted in size; symlinks skipped
      expect(entry.sizeBytes).toBe(7);
      expect(entry.entryCount).toBe(1);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('14. rejects rootPath that is a symbolic link', async () => {
    const symlinkRoot = path.join(tempDir, 'symlink-root');
    const realDir = path.join(tempDir, 'real-dir');
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, symlinkRoot);

    const scanner = new CacheScanner();
    await expect(scanner.scan({ rootPath: symlinkRoot })).rejects.toThrow(
      /Root path cannot be a symbolic link/,
    );
  });

  it('15. respects maxDepth enforcement', async () => {
    // Structure:
    // depth 1: d1
    // depth 2: d1/d2
    // depth 3: d1/d2/cache
    const deepCache = path.join(tempDir, 'd1', 'd2', 'cache');
    await fs.mkdir(deepCache, { recursive: true });
    await fs.writeFile(path.join(deepCache, 'data.txt'), 'test');

    const scanner = new CacheScanner();

    // maxDepth = 2 should not reach depth 3
    const shallowResult = await scanner.scan({ rootPath: tempDir, maxDepth: 2 });
    expect(shallowResult.caches).toHaveLength(0);

    // maxDepth = 3 should reach depth 3
    const reachedResult = await scanner.scan({ rootPath: tempDir, maxDepth: 3 });
    expect(reachedResult.caches).toHaveLength(1);
  });

  it('16 & 17. respects maxResults enforcement and sets truncated flag', async () => {
    await fs.mkdir(path.join(tempDir, 'cache1', 'cache'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'cache2', 'cache'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'cache3', 'cache'), { recursive: true });

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir, maxResults: 2 });

    expect(result.caches).toHaveLength(2);
    expect(result.truncated).toBe(true);

    const fullResult = await scanner.scan({ rootPath: tempDir, maxResults: 10 });
    expect(fullResult.caches).toHaveLength(3);
    expect(fullResult.truncated).toBe(false);
  });

  it('18. enforces path containment strictly', async () => {
    await fs.mkdir(path.join(tempDir, '.npm'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.npm', 'metric.json'), 'data');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    for (const c of result.caches) {
      expect(c.path.startsWith(path.resolve(tempDir))).toBe(true);
      expect(path.isAbsolute(c.path)).toBe(true);
      expect(c.relativePath.startsWith('..')).toBe(false);
    }
  });

  it('19. ensures no filesystem mutations occur during scanning', async () => {
    const npmDir = path.join(tempDir, '.npm');
    await fs.mkdir(npmDir, { recursive: true });
    const filePath = path.join(npmDir, 'package.bin');
    await fs.writeFile(filePath, 'binary-data');

    const statBefore = await fs.lstat(filePath);

    const scanner = new CacheScanner();
    await scanner.scan({ rootPath: tempDir });

    const statAfter = await fs.lstat(filePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mode).toBe(statBefore.mode);
  });

  it('20. detects multiple distinct cache types in one project', async () => {
    // npm
    await fs.mkdir(path.join(tempDir, '.npm'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.npm', 'a.txt'), 'npm');

    // next
    await fs.mkdir(path.join(tempDir, '.next', 'cache'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.next', 'cache', 'b.txt'), 'next');

    // python
    await fs.mkdir(path.join(tempDir, 'src', '__pycache__'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', '__pycache__', 'c.pyc'), 'py');

    // vite
    await fs.mkdir(path.join(tempDir, 'node_modules', '.vite'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'node_modules', '.vite', 'd.txt'), 'vite');

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    expect(result.caches).toHaveLength(4);
    const types = result.caches.map((c) => c.type).sort();
    expect(types).toEqual(['next', 'npm', 'python', 'vite']);
    expect(result.totalCacheSizeBytes).toBe(
      'npm'.length + 'next'.length + 'py'.length + 'vite'.length,
    );
    expect(result.totalCacheEntries).toBe(4);
  });

  it('21. prevents double-counting nested cache directories in totalCacheSizeBytes', async () => {
    // Outer generic cache directory
    const outerCache = path.join(tempDir, 'cache');
    // Inner nested Python cache directory inside outerCache
    const innerCache = path.join(outerCache, 'pkg', '__pycache__');

    await fs.mkdir(innerCache, { recursive: true });
    await fs.writeFile(path.join(outerCache, 'outer.txt'), '12345'); // 5 bytes
    await fs.writeFile(path.join(innerCache, 'inner.pyc'), '67890'); // 5 bytes

    const scanner = new CacheScanner();
    const result = await scanner.scan({ rootPath: tempDir });

    // Both caches are discovered and reported in caches array
    expect(result.caches).toHaveLength(2);
    const outer = result.caches.find((c) => c.relativePath === 'cache')!;
    const inner = result.caches.find(
      (c) => c.relativePath === path.join('cache', 'pkg', '__pycache__'),
    )!;

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();

    // inner size is 5 bytes
    expect(inner.sizeBytes).toBe(5);
    // outer includes inner: 5 + 5 = 10 bytes
    expect(outer.sizeBytes).toBe(10);

    // Total must NOT double-count: 10 bytes (not 10 + 5 = 15)
    expect(result.totalCacheSizeBytes).toBe(10);
    // Total entries must NOT double-count: outer has (outer.txt, pkg, __pycache__, inner.pyc) = 4
    expect(result.totalCacheEntries).toBe(outer.entryCount);
  });

  it('22. detects macOS Library/Caches when scanning simulated home directory', async () => {
    const mockHome = path.join(tempDir, 'mock-home');
    const macCache = path.join(mockHome, 'Library', 'Caches');
    await fs.mkdir(macCache, { recursive: true });
    await fs.writeFile(path.join(macCache, 'com.apple.test'), 'apple-cache');

    process.env.DIGITAL_JANITOR_TEST_HOME = mockHome;
    try {
      const scanner = new CacheScanner();
      const result = await scanner.scan({ rootPath: mockHome });

      expect(result.caches).toHaveLength(1);
      expect(result.caches[0].type).toBe('macos');
      expect(result.caches[0].detectedBy).toBe('macos-library-caches');
      expect(result.caches[0].sizeBytes).toBe('apple-cache'.length);
    } finally {
      delete process.env.DIGITAL_JANITOR_TEST_HOME;
    }
  });

  it('23. handles invalid rootPath arguments gracefully', async () => {
    const scanner = new CacheScanner();
    // @ts-expect-error Testing invalid input
    await expect(scanner.scan(null)).rejects.toThrow('rootPath must be a non-empty string');
    await expect(scanner.scan({ rootPath: '' })).rejects.toThrow(
      'rootPath must be a non-empty string',
    );
    await expect(scanner.scan({ rootPath: '   ' })).rejects.toThrow(
      'rootPath must be a non-empty string',
    );
    await expect(scanner.scan({ rootPath: path.join(tempDir, 'does-not-exist') })).rejects.toThrow(
      /Path does not exist/,
    );
  });

  it('24. handles file rootPath gracefully', async () => {
    const filePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(filePath, 'content');

    const scanner = new CacheScanner();
    await expect(scanner.scan({ rootPath: filePath })).rejects.toThrow(/Path is not a directory/);
  });
});
