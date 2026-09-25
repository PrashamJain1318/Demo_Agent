import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileScanner } from '../scanner/files/FileScanner.js';
import { GitScanner } from '../scanner/git/GitScanner.js';
import { DependencyScanner } from '../scanner/dependencies/DependencyScanner.js';
import { CacheScanner } from '../scanner/cache/CacheScanner.js';
import { DockerScanner } from '../scanner/docker/DockerScanner.js';
import { Analyzer } from '../analyzer/Analyzer.js';
import type { FindingCategory } from '../types/analyzer.js';
import type {
  AuditScannerType,
  AuditSummary,
  AuditWarning,
  UnifiedAuditOptions,
  UnifiedAuditResult,
  UnifiedAuditScannerResults,
} from '../types/audit.js';

export const UNIFIED_AUDIT_VERSION = '1.0.0';

export interface UnifiedAuditServices {
  fileScanner?: FileScanner;
  gitScanner?: GitScanner;
  dependencyScanner?: DependencyScanner;
  cacheScanner?: CacheScanner;
  dockerScanner?: DockerScanner;
  analyzer?: Analyzer;
}

const ALL_SCANNERS: AuditScannerType[] = ['files', 'git', 'dependencies', 'cache', 'docker'];

/**
 * UnifiedAudit coordinates Digital Janitor's existing read-only scanners
 * and analyzer to produce a single, structured, deterministic audit report.
 *
 * SAFETY INVARIANTS:
 * - Non-destructive: Does not invoke approval gates, deletion gates, quarantine, or deletion executors.
 * - Deterministic: Produces reproducible audit IDs based on logical input, independent of timestamps.
 */
export class UnifiedAudit {
  private readonly fileScanner: FileScanner;
  private readonly gitScanner: GitScanner;
  private readonly dependencyScanner: DependencyScanner;
  private readonly cacheScanner: CacheScanner;
  private readonly dockerScanner: DockerScanner;
  private readonly analyzer: Analyzer;

  constructor(services?: UnifiedAuditServices) {
    this.fileScanner = services?.fileScanner ?? new FileScanner();
    this.gitScanner = services?.gitScanner ?? new GitScanner();
    this.dependencyScanner = services?.dependencyScanner ?? new DependencyScanner();
    this.cacheScanner = services?.cacheScanner ?? new CacheScanner();
    this.dockerScanner = services?.dockerScanner ?? new DockerScanner();
    this.analyzer = services?.analyzer ?? new Analyzer();
  }

  /**
   * Executes a unified read-only audit across specified rootPath.
   */
  async audit(rootPath: string, options?: UnifiedAuditOptions): Promise<UnifiedAuditResult> {
    const startedAt = options?.now ?? new Date().toISOString();
    const startTimeMs = Date.now();

    // 1. Root Path Validation
    if (!rootPath || typeof rootPath !== 'string' || rootPath.trim() === '') {
      throw new Error('rootPath must be a non-empty string');
    }

    const resolvedRoot = path.resolve(rootPath.trim());

    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.lstat(resolvedRoot);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        throw new Error(`Path does not exist: ${resolvedRoot}`);
      }
      throw new Error(`Cannot access path: ${resolvedRoot} (${nodeErr.message || String(err)})`);
    }

    if (rootStat.isSymbolicLink()) {
      throw new Error(`Root path cannot be a symbolic link: ${resolvedRoot}`);
    }

    if (!rootStat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedRoot}`);
    }

    // 2. Determine scanners to execute
    const rawScanners = options?.includeScanners ?? ALL_SCANNERS;
    const scannersRun: AuditScannerType[] = [];
    for (const s of rawScanners) {
      if (ALL_SCANNERS.includes(s) && !scannersRun.includes(s)) {
        scannersRun.push(s);
      }
    }

    const scannerResults: UnifiedAuditScannerResults = {};
    const warnings: AuditWarning[] = [];

    // 3. Run Selected Scanners
    for (const scanner of scannersRun) {
      switch (scanner) {
        case 'files': {
          try {
            const result = await this.fileScanner.scan({
              rootPath: resolvedRoot,
              maxDepth: options?.files?.maxDepth,
              maxResults: options?.files?.maxResults,
            });
            scannerResults.files = result;
            if (result.truncated) {
              warnings.push({
                scanner: 'files',
                category: 'truncation',
                message: 'File scan entries truncated due to maxResults limit.',
              });
            }
          } catch (err: unknown) {
            warnings.push({
              scanner: 'files',
              category: 'scanner_error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'git': {
          try {
            const result = await this.gitScanner.scan({
              rootPath: resolvedRoot,
              maxEntries: options?.git?.maxEntries,
            });
            scannerResults.git = result;
            if (result.truncated) {
              warnings.push({
                scanner: 'git',
                category: 'truncation',
                message: 'Git scan entries truncated due to maxEntries limit.',
              });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const category = msg.toLowerCase().includes('not a git repository')
              ? 'not_a_repository'
              : 'scanner_error';
            warnings.push({
              scanner: 'git',
              category,
              message: msg,
            });
          }
          break;
        }

        case 'dependencies': {
          try {
            const result = await this.dependencyScanner.scan({
              rootPath: resolvedRoot,
              maxDependencies: options?.dependencies?.maxDependencies,
              maxInstalledDependencies: options?.dependencies?.maxInstalledDependencies,
            });
            scannerResults.dependencies = result;
            if (result.truncated) {
              warnings.push({
                scanner: 'dependencies',
                category: 'truncation',
                message: 'Dependency scan results truncated due to configured limits.',
              });
            }
          } catch (err: unknown) {
            warnings.push({
              scanner: 'dependencies',
              category: 'scanner_error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'cache': {
          try {
            const result = await this.cacheScanner.scan({
              rootPath: resolvedRoot,
              maxDepth: options?.cache?.maxDepth,
              maxResults: options?.cache?.maxResults,
            });
            scannerResults.cache = result;
            if (result.truncated) {
              warnings.push({
                scanner: 'cache',
                category: 'truncation',
                message: 'Cache scan results truncated due to maxResults limit.',
              });
            }
          } catch (err: unknown) {
            warnings.push({
              scanner: 'cache',
              category: 'scanner_error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'docker': {
          try {
            const result = await this.dockerScanner.scan(options?.docker);
            scannerResults.docker = result;
            if (result.truncated) {
              warnings.push({
                scanner: 'docker',
                category: 'truncation',
                message: 'Docker inventory truncated due to configured limits.',
              });
            }
            if (result.warnings) {
              for (const w of result.warnings) {
                warnings.push({
                  scanner: 'docker',
                  category: 'docker_warning',
                  message: w,
                });
              }
            }
          } catch (err: unknown) {
            warnings.push({
              scanner: 'docker',
              category: 'scanner_error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
      }
    }

    // 4. Pass Collected Results to Existing Analyzer
    const analyzerResult = this.analyzer.analyze(
      {
        files: scannerResults.files,
        git: scannerResults.git,
        dependencies: scannerResults.dependencies,
        cache: scannerResults.cache,
        docker: scannerResults.docker,
      },
      { now: options?.now },
    );

    if (analyzerResult.warnings) {
      for (const w of analyzerResult.warnings) {
        warnings.push({
          scanner: 'analyzer',
          category: 'analyzer_warning',
          message: w,
        });
      }
    }

    // 5. Build Aggregated Counts & Summary
    const findingsByCategory: Record<FindingCategory, number> = {
      cache: 0,
      duplicate: 0,
      stale: 0,
      unused: 0,
      'build-artifact': 0,
      dependency: 0,
      docker: 0,
      repository: 0,
      unknown: 0,
    };

    for (const finding of analyzerResult.findings) {
      findingsByCategory[finding.category] = (findingsByCategory[finding.category] ?? 0) + 1;
    }

    let dockerResourcesCount = 0;
    if (scannerResults.docker && scannerResults.docker.dockerAvailable) {
      dockerResourcesCount =
        scannerResults.docker.containers.length +
        scannerResults.docker.images.length +
        scannerResults.docker.volumes.length +
        scannerResults.docker.networks.length +
        scannerResults.docker.buildCache.length;
    }

    const summary: AuditSummary = {
      filesScanned: scannerResults.files?.totalEntries ?? 0,
      gitRepositoriesDetected: scannerResults.git?.isRepository ? 1 : 0,
      dependencyManifestsDetected: scannerResults.dependencies?.manifestFound ? 1 : 0,
      cachesDetected:
        scannerResults.cache?.totalCacheEntries ?? scannerResults.cache?.caches.length ?? 0,
      dockerResourcesInspected: dockerResourcesCount,
      totalFindings: analyzerResult.totalFindings,
      totalReclaimableBytes: analyzerResult.totalBytes,
      findingsByRisk: {
        low: analyzerResult.lowRiskCount,
        medium: analyzerResult.mediumRiskCount,
        high: analyzerResult.highRiskCount,
        critical: analyzerResult.criticalRiskCount,
      },
      findingsByCategory,
    };

    // 6. Deterministic Audit ID Generation
    const sortedFindingIds = analyzerResult.findings.map((f) => f.id).sort();
    const sortedScanners = [...scannersRun].sort();
    const hashInput = [
      UNIFIED_AUDIT_VERSION,
      resolvedRoot,
      sortedScanners.join(','),
      sortedFindingIds.join(','),
      summary.filesScanned,
      summary.totalFindings,
      summary.totalReclaimableBytes,
    ].join('|');

    const auditHash = createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
    const auditId = `audit-${auditHash}`;

    const completedAt = options?.now ?? new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startTimeMs);

    return {
      auditId,
      rootPath: resolvedRoot,
      startedAt,
      completedAt,
      durationMs,
      scannersRun,
      scannerResults,
      findings: analyzerResult.findings,
      warnings,
      summary,
    };
  }
}
