import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DependencyDeclaration,
  DependencyScanOptions,
  DependencyScanResult,
  DependencyType,
  InstalledDependency,
  LockfileType,
} from '../../types/dependencies.js';

/**
 * DependencyScanner provides safe, read-only discovery of Node.js project
 * dependency declarations and installed package metadata.
 *
 * Safety guarantees:
 * - Read-only: Never modifies package manifests, lockfiles, or node_modules.
 * - Zero execution: Never invokes npm/yarn/pnpm, child processes, or shell scripts.
 * - Untrusted JSON safety: Robustly parses package.json without eval or execution.
 * - Symlink safety: Root path, node_modules, and package symlinks are rejected or skipped.
 * - Strict limits: Limits discovered records to `maxDependencies` to avoid memory exhaustion.
 */
export class DependencyScanner {
  private readonly defaultMaxDependencies = 1000;
  private readonly defaultMaxInstalledDependencies = 1000;

  /**
   * Scans a project directory for dependency manifests and installed packages.
   *
   * @param options Configuration specifying rootPath, maxDependencies, and maxInstalledDependencies.
   * @returns Structured dependency declarations and installed package metadata.
   */
  async scan(options: DependencyScanOptions): Promise<DependencyScanResult> {
    if (!options || typeof options.rootPath !== 'string' || options.rootPath.trim() === '') {
      throw new Error('rootPath must be a non-empty string');
    }

    const maxDependencies =
      options.maxDependencies !== undefined ? options.maxDependencies : this.defaultMaxDependencies;
    if (!Number.isInteger(maxDependencies) || maxDependencies <= 0) {
      throw new Error('maxDependencies must be a positive integer (> 0)');
    }

    const maxInstalledDependencies =
      options.maxInstalledDependencies !== undefined
        ? options.maxInstalledDependencies
        : this.defaultMaxInstalledDependencies;
    if (!Number.isInteger(maxInstalledDependencies) || maxInstalledDependencies <= 0) {
      throw new Error('maxInstalledDependencies must be a positive integer (> 0)');
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

    // Detect lockfiles (presence check only, without parsing contents)
    const lockfileDetected = await this.detectLockfile(resolvedRoot);

    // Detect node_modules presence
    const nodeModulesPath = path.join(resolvedRoot, 'node_modules');
    const nodeModulesPresent = await this.isRealDirectory(nodeModulesPath);

    // Detect package.json
    const packageJsonPath = path.join(resolvedRoot, 'package.json');
    let packageJsonStat: fs.Stats;
    try {
      packageJsonStat = await fs.promises.lstat(packageJsonPath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return {
          rootPath: resolvedRoot,
          manifestFound: false,
          manifestType: null,
          dependencies: [],
          installedDependencies: [],
          totalDependencies: 0,
          totalInstalledDependencies: 0,
          nodeModulesPresent,
          lockfileDetected,
          truncated: false,
        };
      }
      throw new Error(`Cannot access package.json: ${nodeErr.message || String(err)}`);
    }

    if (packageJsonStat.isSymbolicLink()) {
      throw new Error(`package.json cannot be a symbolic link: ${packageJsonPath}`);
    }

    if (!packageJsonStat.isFile()) {
      throw new Error(`package.json is not a regular file: ${packageJsonPath}`);
    }

    // Read and safely parse package.json
    let parsedJson: unknown;
    try {
      const rawContent = await fs.promises.readFile(packageJsonPath, 'utf-8');
      parsedJson = JSON.parse(rawContent);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse package.json: ${message}`);
    }

    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error('package.json must contain a valid JSON object');
    }

    const dependencies: DependencyDeclaration[] = [];
    let declaredTruncated = false;

    // Extract declared dependencies across all supported sections
    const sections: Array<{ key: string; type: DependencyType }> = [
      { key: 'dependencies', type: 'production' },
      { key: 'devDependencies', type: 'development' },
      { key: 'optionalDependencies', type: 'optional' },
      { key: 'peerDependencies', type: 'peer' },
    ];

    const packageRecord = parsedJson as Record<string, unknown>;

    for (const section of sections) {
      const sectionObj = packageRecord[section.key];
      if (sectionObj && typeof sectionObj === 'object' && !Array.isArray(sectionObj)) {
        for (const [name, version] of Object.entries(sectionObj)) {
          if (dependencies.length >= maxDependencies) {
            declaredTruncated = true;
            break;
          }
          if (typeof name === 'string' && typeof version === 'string') {
            dependencies.push({
              name,
              requestedVersion: version,
              dependencyType: section.type,
            });
          }
        }
      }
      if (declaredTruncated) {
        break;
      }
    }

    // Inspect installed packages in node_modules independently with maxInstalledDependencies
    const installedDependencies: InstalledDependency[] = [];
    let installedTruncated = false;
    if (nodeModulesPresent) {
      const installedResult = await this.scanNodeModules(
        resolvedRoot,
        nodeModulesPath,
        maxInstalledDependencies,
      );
      installedDependencies.push(...installedResult.items);
      if (installedResult.truncated) {
        installedTruncated = true;
      }
    }

    const truncated = declaredTruncated || installedTruncated;

    return {
      rootPath: resolvedRoot,
      manifestFound: true,
      manifestType: 'package.json',
      dependencies,
      installedDependencies,
      totalDependencies: dependencies.length,
      totalInstalledDependencies: installedDependencies.length,
      nodeModulesPresent,
      lockfileDetected,
      truncated,
    };
  }

  /**
   * Checks whether a path exists, is a real directory, and is NOT a symlink.
   */
  private async isRealDirectory(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.lstat(targetPath);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Detects the presence of known lockfiles without reading or parsing their contents.
   */
  private async detectLockfile(rootPath: string): Promise<LockfileType | null> {
    const lockfiles: LockfileType[] = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

    for (const lockfile of lockfiles) {
      try {
        const filePath = path.join(rootPath, lockfile);
        const stat = await fs.promises.lstat(filePath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          return lockfile;
        }
      } catch {
        // Not present
      }
    }

    return null;
  }

  /**
   * Safely inspects immediate and scoped packages in node_modules without deep recursion.
   */
  private async scanNodeModules(
    rootPath: string,
    nodeModulesPath: string,
    remainingLimit: number,
  ): Promise<{ items: InstalledDependency[]; truncated: boolean }> {
    const items: InstalledDependency[] = [];
    let truncated = false;

    if (remainingLimit <= 0) {
      return { items, truncated: true };
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(nodeModulesPath, { withFileTypes: true });
    } catch {
      return { items, truncated: false };
    }

    // Sort alphabetically for deterministic ordering
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (items.length >= remainingLimit) {
        truncated = true;
        break;
      }

      // Ignore symlinks and hidden folders (e.g. .bin)
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(nodeModulesPath, entry.name);

      // Verify path containment
      const relFromRoot = path.relative(rootPath, entryPath);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        continue;
      }

      // Handle scoped package directory (e.g. @modelcontextprotocol/server)
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        let scopedEntries: fs.Dirent[];
        try {
          scopedEntries = await fs.promises.readdir(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }

        scopedEntries.sort((a, b) => a.name.localeCompare(b.name));

        for (const scopedEntry of scopedEntries) {
          if (items.length >= remainingLimit) {
            truncated = true;
            break;
          }

          if (scopedEntry.isSymbolicLink()) {
            continue;
          }

          const scopedPkgPath = path.join(entryPath, scopedEntry.name);
          const pkgInfo = await this.readInstalledPackageInfo(scopedPkgPath);
          if (pkgInfo) {
            items.push(pkgInfo);
          }
        }
      } else if (entry.isDirectory()) {
        const pkgInfo = await this.readInstalledPackageInfo(entryPath);
        if (pkgInfo) {
          items.push(pkgInfo);
        }
      }
    }

    return { items, truncated };
  }

  /**
   * Reads metadata (name and version) from a package's package.json without following symlinks.
   */
  private async readInstalledPackageInfo(pkgDirPath: string): Promise<InstalledDependency | null> {
    const pkgJsonPath = path.join(pkgDirPath, 'package.json');
    try {
      const stat = await fs.promises.lstat(pkgJsonPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return null;
      }

      const raw = await fs.promises.readFile(pkgJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const name = typeof parsed.name === 'string' ? parsed.name : path.basename(pkgDirPath);
      const version = typeof parsed.version === 'string' ? parsed.version : 'unknown';

      return {
        name,
        version,
        path: pkgDirPath,
      };
    } catch {
      return null;
    }
  }
}
