import type { CleanupActionType } from './cleanup.js';

export type QuarantineStatus = 'quarantined' | 'failed' | 'skipped';

export interface QuarantineItem {
  actionId: string;
  sourcePath: string;
  quarantinePath: string;
  actionType: CleanupActionType;
  status: QuarantineStatus;
  originalSizeBytes?: number;
  originalSha256?: string;
  error?: string;
}

export interface QuarantineManifest {
  manifestId: string;
  createdAt: string;
  items: QuarantineItem[];
  successfulCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface QuarantineExecutorOptions {
  quarantineRoot: string;
  dryRun?: boolean;
  /** Optional reference timestamp (ISO string) for deterministic createdAt field */
  now?: string;
}
