import type { FindingCategory, RiskLevel } from './analyzer.js';

export type CleanupActionType =
  | 'remove-file'
  | 'remove-directory'
  | 'docker-remove-container'
  | 'docker-remove-image'
  | 'docker-remove-volume'
  | 'docker-remove-network'
  | 'docker-prune-build-cache';

export interface CleanupAction {
  id: string;
  type: CleanupActionType;
  target: string;
  sourceFindingId: string;
  title: string;
  reason: string;
  risk: RiskLevel;
  estimatedBytes?: number;
  reversible: boolean;
  requiresApproval: boolean;
  prerequisites: string[];
  warnings: string[];
}

export interface BlockedCleanupItem {
  findingId: string;
  reason: string;
  risk: RiskLevel;
  category: FindingCategory;
  target?: string;
}

export interface CleanupPlan {
  id: string;
  createdAt: string;
  findingsAnalyzed: number;
  actions: CleanupAction[];
  totalEstimatedBytes: number;
  requiresHumanApproval: boolean;
  warnings: string[];
  blockedActions: BlockedCleanupItem[];
}

export interface CleanupPlannerOptions {
  includeLowRisk?: boolean;
  includeMediumRisk?: boolean;
  includeHighRisk?: boolean;
  includeCriticalRisk?: boolean;
  /** Optional reference timestamp (ISO string) for deterministic createdAt field */
  now?: string;
}
