import type { CleanupAction } from './cleanup.js';

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalRequest {
  planId: string;
  actionIds: string[];
  decision?: ApprovalDecision;
  requestedAt: string;
  requestedBy?: string;
  reason?: string;
}

export interface ApprovalResult {
  planId: string;
  decision: ApprovalDecision;
  approvedActionIds: string[];
  rejectedActionIds: string[];
  blockedActionIds: string[];
  approvedAt: string;
  approvedBy?: string;
  reason?: string;
  rejectionReasons?: Record<string, string>;
}

export interface ApprovalGateOptions {
  allowHighRisk?: boolean;
  allowCriticalRisk?: boolean;
  /** Optional reference timestamp (ISO string) for deterministic approvedAt */
  now?: string;
}

/**
 * Architectural execution boundary:
 * Future execution layers must consume an ApprovedExecutionPayload produced from
 * a valid ApprovalResult, rather than an unapproved CleanupPlan.
 *
 * SAFETY INVARIANT: NO APPROVAL -> NO QUARANTINE -> NO DELETE
 */
export interface ApprovedExecutionPayload {
  planId: string;
  approvedAt: string;
  approvedBy?: string;
  approvedActions: CleanupAction[];
}
