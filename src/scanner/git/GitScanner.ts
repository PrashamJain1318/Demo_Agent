import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitScanOptions, GitScanResult } from '../../types/git.js';

/**
 * GitScanner provides safe, read-only inspection of Git repository metadata
 * and storage metrics entirely via Node.js filesystem APIs.
 *
 * Safety guarantees:
 * - Read-only: Never alters Git objects, commits, refs, index, or config.
 * - No process execution: Does not invoke `child_process`, shell, or the `git` binary.
 * - Path containment: Traversal is strictly constrained within the resolved root path and .git directory.
 * - Symlink protection: Root path cannot be a symlink; internal symlinks are ignored and never followed.
 * - Resource bounding: Git directory scanning is strictly bounded by `maxEntries` to prevent OOM/runaway loops.
 */
export class GitScanner {
  private readonly defaultMaxEntries = 10000;
  private readonly hex2Regex = /^[0-9a-f]{2}$/i;

  /**
   * Scans a Git repository and returns metadata and storage metrics.
   *
   * @param options Configuration with rootPath and optional maxEntries limit.
   * @returns Structured metadata and storage metrics.
   */
  async scan(options: GitScanOptions): Promise<GitScanResult> {
    if (!options || typeof options.rootPath !== 'string' || options.rootPath.trim() === '') {
      throw new Error('rootPath must be a non-empty string');
    }

    const maxEntries =
      options.maxEntries !== undefined ? options.maxEntries : this.defaultMaxEntries;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('maxEntries must be a positive integer (> 0)');
    }

    const resolvedRoot = path.resolve(options.rootPath);

    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.lstat(resolvedRoot);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        throw new Error(`Path does not exist: ${resolvedRoot}`);
      }
      throw new Error(`Cannot access path: ${resolvedRoot} (${nodeErr.message || String(err)})`);
    }

    if (rootStat.isSymbolicLink()) {
      throw new Error(`Root path cannot be a symbolic link: ${resolvedRoot}`);
    }

    if (!rootStat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedRoot}`);
    }

    const gitPath = path.join(resolvedRoot, '.git');
    let gitStat: fs.Stats;
    try {
      gitStat = await fs.promises.lstat(gitPath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        throw new Error(`Path is not a Git repository (missing .git): ${resolvedRoot}`);
      }
      throw new Error(`Cannot access .git at ${gitPath}: ${nodeErr.message || String(err)}`);
    }

    if (gitStat.isSymbolicLink()) {
      throw new Error(`.git cannot be a symbolic link: ${gitPath}`);
    }

    // Support worktrees and submodules where .git is a file referencing a gitdir
    if (gitStat.isFile()) {
      const content = await fs.promises.readFile(gitPath, 'utf-8');
      if (!content.trim().startsWith('gitdir:')) {
        throw new Error(
          `Path is not a valid Git repository (.git file missing gitdir reference): ${resolvedRoot}`,
        );
      }

      return {
        rootPath: resolvedRoot,
        isRepository: true,
        gitDirectory: gitPath,
        gitDirectoryType: 'file',
        repositorySizeBytes: gitStat.size,
        packCount: 0,
        looseObjectCount: 0,
        truncated: false,
      };
    }

    if (!gitStat.isDirectory()) {
      throw new Error(`Path is not a Git repository (.git is invalid type): ${resolvedRoot}`);
    }

    // Standard .git directory inspection
    const { branch, head } = await this.resolveBranchAndHead(gitPath);

    const storage = await this.inspectObjectStorage(gitPath, maxEntries);

    return {
      rootPath: resolvedRoot,
      isRepository: true,
      gitDirectory: gitPath,
      gitDirectoryType: 'directory',
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      repositorySizeBytes: storage.repositorySizeBytes,
      packCount: storage.packCount,
      looseObjectCount: storage.looseObjectCount,
      truncated: storage.truncated,
    };
  }

  /**
   * Resolves current branch name and HEAD commit hash from .git files.
   */
  private async resolveBranchAndHead(gitPath: string): Promise<{ branch?: string; head?: string }> {
    const headFile = path.join(gitPath, 'HEAD');
    let headContent = '';
    try {
      headContent = (await fs.promises.readFile(headFile, 'utf-8')).trim();
    } catch {
      return {};
    }

    if (!headContent) {
      return {};
    }

    // Detached HEAD pointing directly to commit hash
    if (!headContent.startsWith('ref:')) {
      return { head: headContent };
    }

    const ref = headContent.slice(4).trim();
    let branch: string | undefined;
    if (ref.startsWith('refs/heads/')) {
      branch = ref.slice('refs/heads/'.length);
    } else {
      branch = ref;
    }

    // Try resolving commit from loose ref file
    const refPath = path.resolve(gitPath, ref);
    const relFromGit = path.relative(gitPath, refPath);
    if (!relFromGit.startsWith('..') && !path.isAbsolute(relFromGit)) {
      try {
        const refContent = (await fs.promises.readFile(refPath, 'utf-8')).trim();
        if (refContent) {
          return { branch, head: refContent };
        }
      } catch {
        // Ref file might be packed in packed-refs
      }
    }

    // Try resolving commit from packed-refs
    const packedRefsFile = path.join(gitPath, 'packed-refs');
    try {
      const packedContent = await fs.promises.readFile(packedRefsFile, 'utf-8');
      const lines = packedContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {
          continue;
        }
        const [hash, refName] = trimmed.split(/\s+/);
        if (refName === ref && hash) {
          return { branch, head: hash };
        }
      }
    } catch {
      // packed-refs does not exist or unreadable
    }

    return { branch };
  }

  /**
   * Calculates Git directory size and counts loose objects and pack files.
   */
  private async inspectObjectStorage(
    gitPath: string,
    maxEntries: number,
  ): Promise<{
    repositorySizeBytes: number;
    looseObjectCount: number;
    packCount: number;
    truncated: boolean;
  }> {
    let repositorySizeBytes = 0;
    let looseObjectCount = 0;
    let packCount = 0;
    let visitedEntries = 0;
    let truncated = false;

    const dirQueue: string[] = [gitPath];
    const objectsDir = path.join(gitPath, 'objects');

    while (dirQueue.length > 0 && !truncated) {
      const currentDir = dirQueue.shift();
      if (!currentDir) {
        break;
      }

      const relFromGit = path.relative(gitPath, currentDir);
      if (relFromGit.startsWith('..') || path.isAbsolute(relFromGit)) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const dirent of entries) {
        visitedEntries++;
        if (visitedEntries > maxEntries) {
          truncated = true;
          break;
        }

        // Never follow symbolic links
        if (dirent.isSymbolicLink()) {
          continue;
        }

        const fullPath = path.join(currentDir, dirent.name);
        const relPath = path.relative(gitPath, fullPath);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
          continue;
        }

        if (dirent.isFile()) {
          let fileStat: fs.Stats;
          try {
            fileStat = await fs.promises.lstat(fullPath);
          } catch {
            continue;
          }

          repositorySizeBytes += fileStat.size;

          // Check if file is inside .git/objects/
          const relFromObjects = path.relative(objectsDir, fullPath);
          const parts = relFromObjects.split(path.sep);

          // Loose object pattern: objects/<2-hex-chars>/<rest>
          if (parts.length === 2 && this.hex2Regex.test(parts[0])) {
            looseObjectCount++;
          } else if (parts.length === 2 && parts[0] === 'pack' && dirent.name.endsWith('.pack')) {
            packCount++;
          }
        } else if (dirent.isDirectory()) {
          dirQueue.push(fullPath);
        }
      }
    }

    return {
      repositorySizeBytes,
      looseObjectCount,
      packCount,
      truncated,
    };
  }
}
