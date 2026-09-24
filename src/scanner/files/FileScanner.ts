import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileScanOptions, FileScanResult, FileEntry } from '../../types/scanner.js';

/**
 * FileScanner provides safe, read-only discovery of files and directories.
 *
 * Safety guarantees:
 * - Read-only: Never modifies, creates, renames, or deletes files.
 * - Path containment: Enforces that traversal stays strictly within the resolved root path.
 * - Symlink protection: Symlinks are ignored and never traversed, preventing directory escape and recursion loops.
 * - Resource limits: Strictly bounds recursion depth (`maxDepth`) and maximum collected entries (`maxResults`).
 */
export class FileScanner {
  private readonly defaultMaxDepth = 3;
  private readonly defaultMaxResults = 500;

  /**
   * Scans a directory recursively up to maxDepth and maxResults.
   *
   * @param options Configuration specifying rootPath, maxDepth, and maxResults.
   * @returns Structured result with discovered entries and truncation state.
   */
  async scan(options: FileScanOptions): Promise<FileScanResult> {
    if (!options || typeof options.rootPath !== 'string' || options.rootPath.trim() === '') {
      throw new Error('rootPath must be a non-empty string');
    }

    const maxDepth = options.maxDepth !== undefined ? options.maxDepth : this.defaultMaxDepth;
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new Error('maxDepth must be a non-negative integer (>= 0)');
    }

    const maxResults =
      options.maxResults !== undefined ? options.maxResults : this.defaultMaxResults;
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new Error('maxResults must be a positive integer (> 0)');
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

    if (maxDepth === 0) {
      return {
        rootPath: resolvedRoot,
        entries: [],
        totalEntries: 0,
        truncated: false,
      };
    }

    const entries: FileEntry[] = [];
    let truncated = false;

    // Breadth-first traversal queue
    const dirQueue: Array<{ dirPath: string; depth: number }> = [
      { dirPath: resolvedRoot, depth: 1 },
    ];

    while (dirQueue.length > 0 && !truncated) {
      const current = dirQueue.shift();
      if (!current) {
        break;
      }

      // Containment guard: ensure current directory does not escape root
      const relFromRoot = path.relative(resolvedRoot, current.dirPath);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        continue;
      }

      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fs.promises.readdir(current.dirPath, { withFileTypes: true });
      } catch {
        // If directory cannot be read (e.g., permissions), skip gracefully
        continue;
      }

      // Sort alphabetically for deterministic results
      dirEntries.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirEntries) {
        if (entries.length >= maxResults) {
          truncated = true;
          break;
        }

        // Symlink safety: Ignore symbolic links to avoid loops and escapes
        if (dirent.isSymbolicLink()) {
          continue;
        }

        const fullPath = path.join(current.dirPath, dirent.name);
        const relativePath = path.relative(resolvedRoot, fullPath);

        // Path containment check
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          continue;
        }

        if (dirent.isFile()) {
          let fileStat: fs.Stats;
          try {
            fileStat = await fs.promises.lstat(fullPath);
          } catch {
            continue;
          }

          const ext = path.extname(dirent.name);
          entries.push({
            path: fullPath,
            relativePath,
            type: 'file',
            sizeBytes: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
            ...(ext ? { extension: ext } : {}),
          });
        } else if (dirent.isDirectory()) {
          let dirStat: fs.Stats;
          try {
            dirStat = await fs.promises.lstat(fullPath);
          } catch {
            continue;
          }

          entries.push({
            path: fullPath,
            relativePath,
            type: 'directory',
            sizeBytes: 0,
            modifiedAt: dirStat.mtime.toISOString(),
          });

          // Enqueue child directory if beneath maxDepth
          if (current.depth < maxDepth) {
            dirQueue.push({ dirPath: fullPath, depth: current.depth + 1 });
          }
        }
      }
    }

    return {
      rootPath: resolvedRoot,
      entries,
      totalEntries: entries.length,
      truncated,
    };
  }
}
