import type { CleanupActionType } from './cleanup.js';

export type DeletionDecision = 'approved' | 'rejected';

export interface DeletionRequest {
  manifestId: string;
  actionIds: string[];
  decision: DeletionDecision;
  requestedAt: string;
  requestedBy?: string;
  reason?: string;
}

export type DeletionStatus = 'deleted' | 'failed' | 'skipped';

export interface DeletionItem {
  actionId: string;
  quarantinePath: string;
  status: DeletionStatus;
  error?: string;
}

export interface DeletionReport {
  manifestId: string;
  deletedAt: string;
  items: DeletionItem[];
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface DeletionGateOptions {
  requireLatestVerification?: boolean;
  quarantineRoot?: string;
  now?: string;
}

export interface ValidatedDeletionItem {
  actionId: string;
  quarantinePath: string;
  originalPath: string;
  actionType: CleanupActionType;
  verifiedSha256?: string;
  verifiedSizeBytes?: number;
}

/**
 * Architectural execution boundary for permanent deletion.
 * DeletionExecutor must consume ONLY a ValidatedDeletionPayload produced by DeletionGate,
 * strictly preventing direct consumption of CleanupPlan, unapproved manifests, or raw paths.
 */
export interface ValidatedDeletionPayload {
  manifestId: string;
  decision: DeletionDecision;
  approvedActionIds: string[];
  rejectedActionIds: string[];
  eligibleItems: ValidatedDeletionItem[];
  rejectionReasons: Record<string, string>;
  validatedAt: string;
  requestedBy?: string;
}

export interface DeletionExecutorOptions {
  quarantineRoot: string;
  dryRun?: boolean;
  now?: string;
}
