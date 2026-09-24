export type GitDirectoryType = 'directory' | 'file';

export interface GitScanOptions {
  rootPath: string;
  maxEntries?: number;
}

export interface GitScanResult {
  rootPath: string;
  isRepository: boolean;
  gitDirectory: string;
  gitDirectoryType: GitDirectoryType;
  branch?: string;
  head?: string;
  repositorySizeBytes?: number;
  packCount?: number;
  looseObjectCount?: number;
  truncated: boolean;
}
