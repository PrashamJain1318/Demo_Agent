export type EntryType = 'file' | 'directory';

export interface FileEntry {
  path: string;
  relativePath: string;
  type: EntryType;
  sizeBytes: number;
  modifiedAt: string;
  extension?: string;
}

export interface FileScanOptions {
  rootPath: string;
  maxDepth?: number;
  maxResults?: number;
}

export interface FileScanResult {
  rootPath: string;
  entries: FileEntry[];
  totalEntries: number;
  truncated: boolean;
}
