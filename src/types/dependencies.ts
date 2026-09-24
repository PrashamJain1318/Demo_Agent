export type DependencyType = 'production' | 'development' | 'optional' | 'peer';

export interface DependencyDeclaration {
  name: string;
  requestedVersion: string;
  dependencyType: DependencyType;
}

export interface InstalledDependency {
  name: string;
  version: string;
  path: string;
}

export interface DependencyScanOptions {
  rootPath: string;
  /** Maximum number of declared dependencies (dependencies, devDependencies, etc.) to return. Default: 1000 */
  maxDependencies?: number;
  /** Maximum number of installed node_modules packages to discover. Default: 1000 */
  maxInstalledDependencies?: number;
}

export type LockfileType = 'package-lock.json' | 'yarn.lock' | 'pnpm-lock.yaml';

export interface DependencyScanResult {
  rootPath: string;
  manifestFound: boolean;
  manifestType: 'package.json' | null;
  /** Returned declared dependencies (bounded by maxDependencies) */
  dependencies: DependencyDeclaration[];
  /** Returned installed packages from node_modules (bounded by maxInstalledDependencies) */
  installedDependencies: InstalledDependency[];
  /** Count of returned declared dependencies */
  totalDependencies: number;
  /** Count of returned installed dependencies */
  totalInstalledDependencies: number;
  nodeModulesPresent: boolean;
  lockfileDetected?: LockfileType | null;
  /** True if either declared dependency discovery or installed package discovery was truncated */
  truncated: boolean;
}
