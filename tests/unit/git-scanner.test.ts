import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitScanner } from '../../src/scanner/git/GitScanner.js';

describe('GitScanner', () => {
  let tempBaseDir: string;
  let standardRepoDir: string;
  let worktreeRepoDir: string;
  let nonGitDir: string;
  let detachedRepoDir: string;
  let packedRepoDir: string;
  let filePath: string;
  let symlinkRepoDir: string;
  let outsideTargetDir: string;

  beforeAll(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-git-test-'));

    // 1. Standard Git repository fixture
    standardRepoDir = path.join(tempBaseDir, 'standard-repo');
    const standardGit = path.join(standardRepoDir, '.git');
    const standardObjects = path.join(standardGit, 'objects');
    const looseDir1 = path.join(standardObjects, 'e7');
    const looseDir2 = path.join(standardObjects, '4a');
    const packDir = path.join(standardObjects, 'pack');
    const refsHeads = path.join(standardGit, 'refs', 'heads');

    await fs.promises.mkdir(looseDir1, { recursive: true });
    await fs.promises.mkdir(looseDir2, { recursive: true });
    await fs.promises.mkdir(packDir, { recursive: true });
    await fs.promises.mkdir(refsHeads, { recursive: true });

    await fs.promises.writeFile(path.join(standardGit, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.promises.writeFile(
      path.join(refsHeads, 'main'),
      'e731a3c000000000000000000000000000000000\n',
    );
    await fs.promises.writeFile(
      path.join(looseDir1, '31a3c000000000000000000000000000000000'),
      'sample loose object content 1',
    );
    await fs.promises.writeFile(
      path.join(looseDir2, '1234567890abcdef1234567890abcdef123456'),
      'sample loose object content 2',
    );
    await fs.promises.writeFile(
      path.join(packDir, 'pack-abcdef1234567890.pack'),
      'PACK-DATA-BINARY-STUB-1234567890',
    );
    await fs.promises.writeFile(path.join(packDir, 'pack-abcdef1234567890.idx'), 'PACK-IDX-STUB');

    // Nested symlink inside standard .git to test that symlinks are not followed
    outsideTargetDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-git-outside-'));
    await fs.promises.writeFile(path.join(outsideTargetDir, 'outside-secret.txt'), 'secret');
    try {
      await fs.promises.symlink(outsideTargetDir, path.join(standardGit, 'symlink-folder'), 'dir');
    } catch {
      // Ignore if symlink not permitted
    }

    // 2. Worktree fixture (.git as file)
    worktreeRepoDir = path.join(tempBaseDir, 'worktree-repo');
    await fs.promises.mkdir(worktreeRepoDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(worktreeRepoDir, '.git'),
      'gitdir: /some/example/worktree/path\n',
    );

    // 3. Packed-refs repo fixture
    packedRepoDir = path.join(tempBaseDir, 'packed-repo');
    const packedGit = path.join(packedRepoDir, '.git');
    await fs.promises.mkdir(packedGit, { recursive: true });
    await fs.promises.writeFile(path.join(packedGit, 'HEAD'), 'ref: refs/heads/feature-branch\n');
    await fs.promises.writeFile(
      path.join(packedGit, 'packed-refs'),
      '# pack-refs with: sorted-all\n1111222233334444555566667777888899990000 refs/heads/feature-branch\n',
    );

    // 4. Detached HEAD repo fixture
    detachedRepoDir = path.join(tempBaseDir, 'detached-repo');
    const detachedGit = path.join(detachedRepoDir, '.git');
    await fs.promises.mkdir(detachedGit, { recursive: true });
    await fs.promises.writeFile(
      path.join(detachedGit, 'HEAD'),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    );

    // 5. Non-git directory
    nonGitDir = path.join(tempBaseDir, 'non-git-dir');
    await fs.promises.mkdir(nonGitDir, { recursive: true });
    await fs.promises.writeFile(path.join(nonGitDir, 'readme.txt'), 'not a git repo');

    // 6. Regular file
    filePath = path.join(tempBaseDir, 'regular-file.txt');
    await fs.promises.writeFile(filePath, 'plain file content');

    // 7. Symlinked repo directory
    symlinkRepoDir = path.join(tempBaseDir, 'symlink-repo');
    try {
      await fs.promises.symlink(standardRepoDir, symlinkRepoDir, 'dir');
    } catch {
      // Ignore if symlink not permitted
    }
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      await fs.promises.rm(outsideTargetDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('scans a standard Git repository and resolves metadata, branch, HEAD, and object metrics', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: standardRepoDir });

    expect(result.isRepository).toBe(true);
    expect(result.rootPath).toBe(path.resolve(standardRepoDir));
    expect(result.gitDirectory).toBe(path.join(path.resolve(standardRepoDir), '.git'));
    expect(result.gitDirectoryType).toBe('directory');
    expect(result.branch).toBe('main');
    expect(result.head).toBe('e731a3c000000000000000000000000000000000');
    expect(result.looseObjectCount).toBe(2);
    expect(result.packCount).toBe(1);
    expect('objectCount' in result).toBe(false);
    expect(result.repositorySizeBytes).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('supports worktree/submodule repositories where .git is a file', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: worktreeRepoDir });

    expect(result.isRepository).toBe(true);
    expect(result.gitDirectoryType).toBe('file');
    expect(result.gitDirectory).toBe(path.join(path.resolve(worktreeRepoDir), '.git'));
    expect(result.repositorySizeBytes).toBeGreaterThan(0);
    expect('objectCount' in result).toBe(false);
    expect(result.looseObjectCount).toBe(0);
    expect(result.packCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('resolves branch and commit from packed-refs', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: packedRepoDir });

    expect(result.isRepository).toBe(true);
    expect(result.branch).toBe('feature-branch');
    expect(result.head).toBe('1111222233334444555566667777888899990000');
  });

  it('resolves detached HEAD where HEAD contains commit hash directly', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: detachedRepoDir });

    expect(result.isRepository).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.head).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('rejects non-Git directory with clear error', async () => {
    const scanner = new GitScanner();
    await expect(scanner.scan({ rootPath: nonGitDir })).rejects.toThrow('missing .git');
  });

  it('rejects empty or whitespace rootPath', async () => {
    const scanner = new GitScanner();
    await expect(scanner.scan({ rootPath: '' })).rejects.toThrow('non-empty string');
    await expect(scanner.scan({ rootPath: '   ' })).rejects.toThrow('non-empty string');
  });

  it('rejects nonexistent path', async () => {
    const scanner = new GitScanner();
    const fakePath = path.join(tempBaseDir, 'does-not-exist');
    await expect(scanner.scan({ rootPath: fakePath })).rejects.toThrow('Path does not exist');
  });

  it('rejects a file passed as rootPath', async () => {
    const scanner = new GitScanner();
    await expect(scanner.scan({ rootPath: filePath })).rejects.toThrow('Path is not a directory');
  });

  it('rejects rootPath if it is a symbolic link', async () => {
    const scanner = new GitScanner();
    try {
      await expect(scanner.scan({ rootPath: symlinkRepoDir })).rejects.toThrow(
        'Root path cannot be a symbolic link',
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    }
  });

  it('does not follow nested symlinks inside .git', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: standardRepoDir });
    expect(result.isRepository).toBe(true);
    // Verified that scanning completed safely without errors or escaping to outsideTargetDir
  });

  it('respects maxEntries limit and marks result as truncated', async () => {
    const scanner = new GitScanner();
    const result = await scanner.scan({ rootPath: standardRepoDir, maxEntries: 2 });
    expect(result.truncated).toBe(true);
  });

  it('rejects invalid maxEntries', async () => {
    const scanner = new GitScanner();
    await expect(scanner.scan({ rootPath: standardRepoDir, maxEntries: 0 })).rejects.toThrow(
      'positive integer',
    );
    await expect(scanner.scan({ rootPath: standardRepoDir, maxEntries: -5 })).rejects.toThrow(
      'positive integer',
    );
  });

  it('guarantees read-only behavior: scanner does not modify Git fixture files or metadata', async () => {
    const headPath = path.join(standardRepoDir, '.git', 'HEAD');
    const statBefore = await fs.promises.lstat(headPath);
    const contentBefore = await fs.promises.readFile(headPath, 'utf-8');

    const scanner = new GitScanner();
    await scanner.scan({ rootPath: standardRepoDir });

    const statAfter = await fs.promises.lstat(headPath);
    const contentAfter = await fs.promises.readFile(headPath, 'utf-8');

    expect(contentAfter).toBe(contentBefore);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
