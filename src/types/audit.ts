import type { FileScanResult } from './scanner.js';
import type { GitScanResult } from './git.js';
import type { DependencyScanResult } from './dependencies.js';
import type { CacheScanResult } from './cache.js';
import type { DockerScanOptions, DockerScanResult } from './docker.js';
import type { AnalyzerFinding, FindingCategory, RiskLevel } from './analyzer.js';

export type AuditScannerType = 'files' | 'git' | 'dependencies' | 'cache' | 'docker';

export interface AuditWarning {
  scanner: AuditScannerType | 'analyzer' | 'core';
  category: string;
  message: string;
}

export interface AuditSummary {
  filesScanned: number;
  gitRepositoriesDetected: number;
  dependencyManifestsDetected: number;
  cachesDetected: number;
  dockerResourcesInspected: number;
  totalFindings: number;
  totalReclaimableBytes: number;
  findingsByRisk: Record<RiskLevel, number>;
  findingsByCategory: Record<FindingCategory, number>;
}

export interface UnifiedAuditScannerResults {
  files?: FileScanResult;
  git?: GitScanResult;
  dependencies?: DependencyScanResult;
  cache?: CacheScanResult;
  docker?: DockerScanResult;
}

export interface UnifiedAuditResult {
  auditId: string;
  rootPath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  scannersRun: AuditScannerType[];
  scannerResults: UnifiedAuditScannerResults;
  findings: AnalyzerFinding[];
  warnings: AuditWarning[];
  summary: AuditSummary;
}

export interface UnifiedAuditOptions {
  includeScanners?: AuditScannerType[];
  files?: {
    maxDepth?: number;
    maxResults?: number;
  };
  git?: {
    maxEntries?: number;
  };
  dependencies?: {
    maxDependencies?: number;
    maxInstalledDependencies?: number;
  };
  cache?: {
    maxDepth?: number;
    maxResults?: number;
  };
  docker?: DockerScanOptions;
  now?: string;
}
