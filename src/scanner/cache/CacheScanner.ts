import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CacheType, CacheEntry, CacheScanOptions, CacheScanResult } from '../../types/cache.js';

interface DetectedRule {
  type: CacheType;
  detectedBy: string;
}

/**
 * CacheScanner provides safe, read-only discovery of application and system cache directories.
 *
 * Safety guarantees:
 * - Read-only: Never creates, deletes, moves, or mutates any file or directory.
 * - Path containment: All discovered paths are strictly contained within rootPath.
 * - Symlink protection: Symlinks are ignored and never followed, preventing escape and cycles.
 * - Root symlink rejection: Symlink rootPath arguments are immediately rejected.
 * - Bounded traversal: Depth and result limits (maxDepth, maxResults) prevent unbounded recursion.
 * - Non-overlapping calculation: Nested cache sizes are not double-counted in total totals.
 */
export class CacheScanner {
  private readonly defaultMaxDepth = 6;
  private readonly defaultMaxResults = 100;

  /**
   * Scans rootPath recursively for known cache directories.
   *
   * @param options Configuration specifying rootPath, maxDepth, and maxResults.
   * @returns Structured result containing detected caches, metrics, and truncation state.
   */
  async scan(options: CacheScanOptions): Promise<CacheScanResult> {
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
        caches: [],
        totalCacheSizeBytes: 0,
        totalCacheEntries: 0,
        truncated: false,
      };
    }

    const caches: CacheEntry[] = [];
    let truncated = false;

    // Breadth-first traversal queue
    const dirQueue: Array<{ dirPath: string; depth: number }> = [
      { dirPath: resolvedRoot, depth: 0 },
    ];

    while (dirQueue.length > 0 && !truncated) {
      const current = dirQueue.shift();
      if (!current) {
        break;
      }

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(current.dirPath, { withFileTypes: true });
      } catch {
        // Unreadable directory (e.g. EACCES permission denied), skip descending
        continue;
      }

      // Sort entries deterministically
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        // Enforce symlink safety: never follow or inspect symbolic links
        if (dirent.isSymbolicLink()) {
          continue;
        }

        if (!dirent.isDirectory()) {
          continue;
        }

        const childPath = path.join(current.dirPath, dirent.name);

        // Path containment check: ensure no escape outside rootPath
        const rel = path.relative(resolvedRoot, childPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          continue;
        }

        const nextDepth = current.depth + 1;

        // Check if this directory matches any cache rule
        const detection = this.detectCache(childPath, resolvedRoot);
        if (detection) {
          const { sizeBytes, entryCount } = await this.calculateDirMetrics(childPath);

          caches.push({
            path: childPath,
            relativePath: rel,
            type: detection.type,
            sizeBytes,
            entryCount,
            detectedBy: detection.detectedBy,
          });

          if (caches.length >= maxResults) {
            truncated = true;
            break;
          }
        }

        // Descend if within depth limit
        if (nextDepth < maxDepth) {
          dirQueue.push({ dirPath: childPath, depth: nextDepth });
        }
      }
    }

    // Strategy to prevent double-counting nested caches:
    // Identify top-level non-overlapping cache roots. If cache A is an ancestor
    // directory of cache B, only cache A's metrics are summed for the totals.
    const nonOverlappingRoots = caches.filter((candidate) => {
      return !caches.some(
        (other) => other !== candidate && this.isSubpath(other.path, candidate.path),
      );
    });

    const totalCacheSizeBytes = nonOverlappingRoots.reduce((acc, c) => acc + c.sizeBytes, 0);
    const totalCacheEntries = nonOverlappingRoots.reduce((acc, c) => acc + c.entryCount, 0);

    return {
      rootPath: resolvedRoot,
      caches,
      totalCacheSizeBytes,
      totalCacheEntries,
      truncated,
    };
  }

  /**
   * Tests whether child is strictly located within parent.
   */
  private isSubpath(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * Checks if candidate directory represents a supported cache directory.
   */
  private detectCache(dirPath: string, rootPath: string): DetectedRule | null {
    const dirName = path.basename(dirPath);
    const parentDir = path.dirname(dirPath);
    const parentName = path.basename(parentDir);
    const relPath = path.relative(rootPath, dirPath);

    // 1. Next.js cache (.next/cache)
    if (dirName === 'cache' && parentName === '.next') {
      return { type: 'next', detectedBy: 'next-cache-dir' };
    }

    // 2. Vite cache (node_modules/.vite)
    if (dirName === '.vite' && parentName === 'node_modules') {
      return { type: 'vite', detectedBy: 'vite-cache-dir' };
    }

    // 3. Yarn cache (.yarn/cache)
    if (dirName === 'cache' && parentName === '.yarn') {
      return { type: 'yarn', detectedBy: 'yarn-cache-dir' };
    }

    // 4. Gradle caches (.gradle/caches)
    if (dirName === 'caches' && parentName === '.gradle') {
      return { type: 'gradle', detectedBy: 'gradle-caches-dir' };
    }

    // 5. Python __pycache__
    if (dirName === '__pycache__') {
      return { type: 'python', detectedBy: 'python-pycache' };
    }

    // 6. npm .npm cache
    if (dirName === '.npm') {
      return { type: 'npm', detectedBy: 'npm-cache-dir' };
    }

    // 7. pnpm .pnpm-store cache
    if (dirName === '.pnpm-store') {
      return { type: 'pnpm', detectedBy: 'pnpm-store-dir' };
    }

    // 8. macOS Library/Caches (only when rootPath represents a user home directory)
    const normalizedRel = relPath.split(path.sep).join('/');
    if (normalizedRel === 'Library/Caches' && this.isUserHome(rootPath)) {
      return { type: 'macos', detectedBy: 'macos-library-caches' };
    }

    // 9. Generic cache directories: explicit basename check
    if (dirName === 'cache' || dirName === 'caches' || dirName === '.cache') {
      return { type: 'generic', detectedBy: 'generic-cache-dir' };
    }

    return null;
  }

  /**
   * Determines if rootPath corresponds to a user home directory.
   */
  private isUserHome(dirPath: string): boolean {
    try {
      const home = os.homedir();
      if (path.resolve(dirPath) === path.resolve(home)) {
        return true;
      }
    } catch {
      // ignore
    }

    if (process.env.HOME && path.resolve(dirPath) === path.resolve(process.env.HOME)) {
      return true;
    }

    if (
      process.env.DIGITAL_JANITOR_TEST_HOME &&
      path.resolve(dirPath) === path.resolve(process.env.DIGITAL_JANITOR_TEST_HOME)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Recursively calculates the byte size and entry count of a cache directory.
   * Never follows symbolic links.
   */
  private async calculateDirMetrics(
    dirPath: string,
  ): Promise<{ sizeBytes: number; entryCount: number }> {
    let sizeBytes = 0;
    let entryCount = 0;

    const stack: string[] = [dirPath];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        // Skip unreadable subdirectories
        continue;
      }

      for (const dirent of dirents) {
        // Strictly skip symbolic links
        if (dirent.isSymbolicLink()) {
          continue;
        }

        entryCount++;
        const entryPath = path.join(current, dirent.name);

        if (dirent.isDirectory()) {
          stack.push(entryPath);
        } else if (dirent.isFile()) {
          try {
            const stat = await fs.promises.lstat(entryPath);
            sizeBytes += stat.size;
          } catch {
            // Skip unstatable files
          }
        }
      }
    }

    return { sizeBytes, entryCount };
  }
}
