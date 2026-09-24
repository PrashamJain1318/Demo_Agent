import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileScanner } from '../../src/scanner/files/FileScanner.js';

describe('FileScanner', () => {
  let tempDir: string;
  let subDir: string;
  let nestedDir: string;
  let fileA: string;
  let fileB: string;
  let fileC: string;
  let symlinkDir: string;

  beforeAll(async () => {
    // Create temporary test fixtures
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-scanner-test-'));
    subDir = path.join(tempDir, 'subdir');
    nestedDir = path.join(subDir, 'nested');

    await fs.promises.mkdir(nestedDir, { recursive: true });

    fileA = path.join(tempDir, 'alpha.txt');
    fileB = path.join(subDir, 'beta.json');
    fileC = path.join(nestedDir, 'gamma.log');

    await fs.promises.writeFile(fileA, 'alpha content 123');
    await fs.promises.writeFile(fileB, JSON.stringify({ key: 'value' }));
    await fs.promises.writeFile(fileC, 'log line 1\nlog line 2');

    // Create a directory outside tempDir and symlink to it
    const externalTargetDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dj-external-target-'),
    );
    await fs.promises.writeFile(
      path.join(externalTargetDir, 'outside.txt'),
      'outside secret content',
    );

    symlinkDir = path.join(tempDir, 'symlinked-folder');
    try {
      await fs.promises.symlink(externalTargetDir, symlinkDir, 'dir');
    } catch {
      // On platforms where directory symlinks may require elevated privileges, ignore
    }
  });

  afterAll(async () => {
    // Clean up temporary test fixtures
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('scans a directory and discovers files and directories with correct metadata', async () => {
    const scanner = new FileScanner();
    const result = await scanner.scan({ rootPath: tempDir, maxDepth: 3 });

    expect(result).toBeDefined();
    expect(result.rootPath).toBe(path.resolve(tempDir));
    expect(result.truncated).toBe(false);

    // 2. discovers files
    const fileEntries = result.entries.filter((e) => e.type === 'file');
    expect(fileEntries.length).toBeGreaterThanOrEqual(3);

    // 3. discovers directories
    const dirEntries = result.entries.filter((e) => e.type === 'directory');
    expect(dirEntries.length).toBeGreaterThanOrEqual(2);

    // 4. returns file size
    const alphaEntry = result.entries.find((e) => e.relativePath === 'alpha.txt');
    expect(alphaEntry).toBeDefined();
    expect(alphaEntry?.type).toBe('file');
    expect(alphaEntry?.sizeBytes).toBe('alpha content 123'.length);

    // 5. returns modification timestamp
    expect(alphaEntry?.modifiedAt).toBeDefined();
    expect(new Date(alphaEntry!.modifiedAt).getTime()).not.toBeNaN();

    // 6. returns extension
    expect(alphaEntry?.extension).toBe('.txt');

    const betaEntry = result.entries.find((e) => e.relativePath === 'subdir/beta.json');
    expect(betaEntry).toBeDefined();
    expect(betaEntry?.extension).toBe('.json');
  });

  it('respects maxDepth', async () => {
    const scanner = new FileScanner();

    // Depth 0: no children scanned
    const depth0Result = await scanner.scan({ rootPath: tempDir, maxDepth: 0 });
    expect(depth0Result.entries).toHaveLength(0);
    expect(depth0Result.truncated).toBe(false);

    // Depth 1: only immediate children of root (alpha.txt and subdir)
    const depth1Result = await scanner.scan({ rootPath: tempDir, maxDepth: 1 });
    const pathsDepth1 = depth1Result.entries.map((e) => e.relativePath);
    expect(pathsDepth1).toContain('alpha.txt');
    expect(pathsDepth1).toContain('subdir');
    expect(pathsDepth1).not.toContain('subdir/beta.json');
    expect(pathsDepth1).not.toContain('subdir/nested/gamma.log');

    // Depth 2: includes subdir/beta.json and subdir/nested, but not nested files
    const depth2Result = await scanner.scan({ rootPath: tempDir, maxDepth: 2 });
    const pathsDepth2 = depth2Result.entries.map((e) => e.relativePath);
    expect(pathsDepth2).toContain('subdir/beta.json');
    expect(pathsDepth2).toContain('subdir/nested');
    expect(pathsDepth2).not.toContain('subdir/nested/gamma.log');

    // Depth 3: includes nested/gamma.log
    const depth3Result = await scanner.scan({ rootPath: tempDir, maxDepth: 3 });
    const pathsDepth3 = depth3Result.entries.map((e) => e.relativePath);
    expect(pathsDepth3).toContain('subdir/nested/gamma.log');
  });

  it('respects maxResults and marks result as truncated', async () => {
    const scanner = new FileScanner();
    const result = await scanner.scan({ rootPath: tempDir, maxResults: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.totalEntries).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects empty rootPath', async () => {
    const scanner = new FileScanner();
    await expect(scanner.scan({ rootPath: '' })).rejects.toThrow('non-empty string');
    await expect(scanner.scan({ rootPath: '   ' })).rejects.toThrow('non-empty string');
  });

  it('rejects nonexistent path', async () => {
    const scanner = new FileScanner();
    const fakePath = path.join(tempDir, 'does-not-exist-at-all');
    await expect(scanner.scan({ rootPath: fakePath })).rejects.toThrow('Path does not exist');
  });

  it('rejects a file passed as rootPath', async () => {
    const scanner = new FileScanner();
    await expect(scanner.scan({ rootPath: fileA })).rejects.toThrow('Path is not a directory');
  });

  it('rejects invalid maxDepth and maxResults', async () => {
    const scanner = new FileScanner();
    await expect(scanner.scan({ rootPath: tempDir, maxDepth: -1 })).rejects.toThrow(
      'non-negative integer',
    );
    await expect(scanner.scan({ rootPath: tempDir, maxResults: 0 })).rejects.toThrow(
      'positive integer',
    );
    await expect(scanner.scan({ rootPath: tempDir, maxResults: -10 })).rejects.toThrow(
      'positive integer',
    );
  });

  it('rejects rootPath if it is a symbolic link', async () => {
    const scanner = new FileScanner();
    const testSymlinkPath = path.join(tempDir, 'root-symlink-test');
    try {
      await fs.promises.symlink(subDir, testSymlinkPath, 'dir');
      await expect(scanner.scan({ rootPath: testSymlinkPath })).rejects.toThrow(
        'Root path cannot be a symbolic link',
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    }
  });

  it('does not follow directory symlinks', async () => {
    const scanner = new FileScanner();
    const result = await scanner.scan({ rootPath: tempDir, maxDepth: 3 });

    const relativePaths = result.entries.map((e) => e.relativePath);
    // Should NOT contain any contents from inside the symlinked directory
    expect(relativePaths).not.toContain('symlinked-folder/outside.txt');
  });

  it('guarantees read-only behavior: scanner does not modify fixture files or metadata', async () => {
    const statBefore = await fs.promises.stat(fileA);
    const contentBefore = await fs.promises.readFile(fileA, 'utf-8');

    const scanner = new FileScanner();
    await scanner.scan({ rootPath: tempDir, maxDepth: 3 });

    const statAfter = await fs.promises.stat(fileA);
    const contentAfter = await fs.promises.readFile(fileA, 'utf-8');

    expect(contentAfter).toBe(contentBefore);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
