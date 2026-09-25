export type CacheType =
  'npm' | 'pnpm' | 'yarn' | 'python' | 'macos' | 'next' | 'vite' | 'gradle' | 'generic';

export interface CacheEntry {
  path: string;
  relativePath: string;
  type: CacheType;
  sizeBytes: number;
  entryCount: number;
  detectedBy: string;
}

export interface CacheScanOptions {
  rootPath: string;
  maxResults?: number;
  maxDepth?: number;
}

export interface CacheScanResult {
  rootPath: string;
  caches: CacheEntry[];
  totalCacheSizeBytes: number;
  totalCacheEntries: number;
  truncated: boolean;
}
