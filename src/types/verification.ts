export type VerificationStatus = 'intact' | 'missing' | 'modified' | 'inaccessible' | 'invalid';

export interface VerificationItem {
  actionId: string;
  quarantinePath: string;
  originalPath: string;
  status: VerificationStatus;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  expectedHash?: string;
  actualHash?: string;
  error?: string;
}

export type VerificationReportStatus = 'verified' | 'issues-found' | 'invalid-manifest';

export interface VerificationReport {
  manifestId: string;
  verifiedAt: string;
  status: VerificationReportStatus;
  items: VerificationItem[];
  intactCount: number;
  missingCount: number;
  modifiedCount: number;
  inaccessibleCount: number;
  invalidCount: number;
}

export type RestoreStatus = 'restored' | 'failed' | 'skipped';

export interface RestoreItem {
  actionId: string;
  quarantinePath: string;
  originalPath: string;
  status: RestoreStatus;
  error?: string;
}

export interface RestoreReport {
  manifestId: string;
  restoredAt: string;
  items: RestoreItem[];
  restoredCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface QuarantineVerifierOptions {
  quarantineRoot?: string;
  /** Optional reference timestamp (ISO string) for deterministic verifiedAt */
  now?: string;
}

export interface QuarantineRestorerOptions {
  quarantineRoot: string;
  /** Optional reference timestamp (ISO string) for deterministic restoredAt */
  now?: string;
}
