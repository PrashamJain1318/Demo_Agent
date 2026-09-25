import type { FileScanResult } from './scanner.js';
import type { GitScanResult } from './git.js';
import type { DependencyScanResult } from './dependencies.js';
import type { CacheScanResult } from './cache.js';
import type { DockerScanResult } from './docker.js';

export type FindingSource = 'files' | 'git' | 'dependencies' | 'cache' | 'docker';

export type FindingCategory =
  | 'cache'
  | 'duplicate'
  | 'stale'
  | 'unused'
  | 'build-artifact'
  | 'dependency'
  | 'docker'
  | 'repository'
  | 'unknown';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type Recommendation = 'review' | 'retain' | 'investigate';

export interface AnalyzerFinding {
  id: string;
  source: FindingSource;
  category: FindingCategory;
  title: string;
  description: string;
  path?: string;
  resourceId?: string;
  sizeBytes?: number;
  risk: RiskLevel;
  /**
   * Represents confidence in the category classification and evidence detection
   * (e.g. certainty that a resource has 0 references), NOT probability of disposability or safe deletion.
   */
  confidence: number;
  /**
   * Conservative recommendation ('review', 'retain', 'investigate'). Never recommends deletion.
   */
  recommendation: Recommendation;
  evidence: string[];
  reversible: boolean;
  detectedAt: string;
}

export interface AnalyzerResult {
  findings: AnalyzerFinding[];
  totalFindings: number;
  totalBytes: number;
  lowRiskCount: number;
  mediumRiskCount: number;
  highRiskCount: number;
  criticalRiskCount: number;
  sourceSummary: Record<FindingSource, number>;
  warnings: string[];
}

export interface AnalyzerInput {
  files?: FileScanResult;
  git?: GitScanResult;
  dependencies?: DependencyScanResult;
  cache?: CacheScanResult;
  docker?: DockerScanResult;
}

export interface AnalyzerOptions {
  /** Optional reference timestamp (ISO string) for deterministic detectedAt fields */
  now?: string;
}
