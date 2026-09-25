import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  AnalyzerFinding,
  AnalyzerInput,
  AnalyzerOptions,
  AnalyzerResult,
  FindingCategory,
  FindingSource,
} from '../types/analyzer.js';
import {
  evaluateCacheRisk,
  evaluateDependencyInconsistencyRisk,
  evaluateDockerBuildCacheRisk,
  evaluateDockerContainerRisk,
  evaluateDockerImageRisk,
  evaluateDockerNetworkRisk,
  evaluateDockerVolumeRisk,
  evaluateGitRepositoryRisk,
} from './risk.js';

/**
 * Deterministic, read-only intelligence layer that normalizes raw scanner results
 * into structured findings with risk classifications and storage evaluations.
 *
 * Guarantees:
 * - 100% deterministic, side-effect free, and synchronous.
 * - Never performs cleanup, deletion, quarantine, modification, or shell execution.
 * - Does not double-count overlapping storage findings.
 * - Produces stable, reproducible finding IDs independent of execution timestamps.
 */
export class Analyzer {
  analyze(input: AnalyzerInput, options?: AnalyzerOptions): AnalyzerResult {
    const findings: AnalyzerFinding[] = [];
    const warnings: string[] = [];
    const detectedAt = options?.now ?? new Date().toISOString();

    // 1. Process Cache Scan Results
    if (input.cache) {
      if (input.cache.truncated) {
        warnings.push('Cache scan results were truncated due to limits.');
      }
      for (const entry of input.cache.caches) {
        const assessment = evaluateCacheRisk(entry.type, entry.relativePath);
        const title = `${entry.type.toUpperCase()} Cache (${entry.relativePath})`;
        const id = this.createFindingId('cache', assessment.category, entry.path, title);

        findings.push({
          id,
          source: 'cache',
          category: assessment.category,
          title,
          description: assessment.reason,
          path: entry.path,
          sizeBytes: entry.sizeBytes,
          risk: assessment.risk,
          confidence: assessment.confidence,
          recommendation: assessment.recommendation,
          evidence: [
            `Cache type: ${entry.type}`,
            `Relative path: ${entry.relativePath}`,
            `Entry count: ${entry.entryCount}`,
            `Size in bytes: ${entry.sizeBytes}`,
            `Detected by: ${entry.detectedBy}`,
          ],
          reversible: assessment.reversible,
          detectedAt,
        });
      }
    }

    // 2. Process Docker Scan Results
    if (input.docker) {
      if (input.docker.warnings && input.docker.warnings.length > 0) {
        warnings.push(...input.docker.warnings);
      }
      if (input.docker.truncated) {
        warnings.push('Docker scan results were truncated due to limits.');
      }

      if (input.docker.dockerAvailable) {
        // Containers
        for (const container of input.docker.containers) {
          const assessment = evaluateDockerContainerRisk(container.state, container.name);
          const isRunning = container.state.toLowerCase() === 'running';
          const title = `${isRunning ? 'Running' : 'Stopped'} Docker Container (${container.name})`;
          const id = this.createFindingId('docker', assessment.category, container.id, title);

          findings.push({
            id,
            source: 'docker',
            category: assessment.category,
            title,
            description: assessment.reason,
            resourceId: container.id,
            sizeBytes: container.sizeBytes,
            risk: assessment.risk,
            confidence: assessment.confidence,
            recommendation: assessment.recommendation,
            evidence: [
              `Container ID: ${container.id}`,
              `Image: ${container.image}`,
              `State: ${container.state}`,
              `Status: ${container.status}`,
              `Ports: ${container.ports || 'none'}`,
              `Mounts: ${container.mounts || 'none'}`,
              `Candidate for review: ${!isRunning ? 'yes (stopped container)' : 'no'}`,
            ],
            reversible: assessment.reversible,
            detectedAt,
          });
        }

        // Images
        for (const image of input.docker.images) {
          const assessment = evaluateDockerImageRisk(
            image.containersUsing,
            image.repository,
            image.tag,
          );
          const isUnreferenced = image.containersUsing === 0;
          const title = `${isUnreferenced ? 'Unreferenced' : 'In-Use'} Docker Image (${image.repository}:${image.tag})`;
          const id = this.createFindingId('docker', assessment.category, image.id, title);

          findings.push({
            id,
            source: 'docker',
            category: assessment.category,
            title,
            description: assessment.reason,
            resourceId: image.id,
            sizeBytes: image.sizeBytes,
            risk: assessment.risk,
            confidence: assessment.confidence,
            recommendation: assessment.recommendation,
            evidence: [
              `Image ID: ${image.id}`,
              `Repository: ${image.repository}`,
              `Tag: ${image.tag}`,
              `Containers referencing: ${image.containersUsing}`,
              `Size in bytes: ${image.sizeBytes}`,
              `Created at: ${image.createdAt}`,
              `Candidate for review: ${isUnreferenced ? 'yes (unreferenced image with 0 referencing containers)' : 'no'}`,
            ],
            reversible: assessment.reversible,
            detectedAt,
          });
        }

        // Volumes
        for (const volume of input.docker.volumes) {
          const assessment = evaluateDockerVolumeRisk(volume.containerCount, volume.name);
          const isUnattached = volume.containerCount === 0;
          const title = `${isUnattached ? 'Unattached' : 'In-Use'} Docker Volume (${volume.name})`;
          const id = this.createFindingId('docker', assessment.category, volume.name, title);

          findings.push({
            id,
            source: 'docker',
            category: assessment.category,
            title,
            description: assessment.reason,
            resourceId: volume.name,
            path: volume.mountpoint,
            risk: assessment.risk,
            confidence: assessment.confidence,
            recommendation: assessment.recommendation,
            evidence: [
              `Volume name: ${volume.name}`,
              `Driver: ${volume.driver}`,
              `Attached containers: ${volume.containerCount}`,
              `Scope: ${volume.scope || 'local'}`,
              `Mountpoint: ${volume.mountpoint || 'unknown'}`,
              `Candidate for review: ${isUnattached ? 'yes (unattached volume with 0 container references)' : 'no'}`,
            ],
            reversible: assessment.reversible,
            detectedAt,
          });
        }

        // Networks
        const systemNetworks = new Set(['bridge', 'host', 'none']);
        for (const network of input.docker.networks) {
          const isSystem = systemNetworks.has(network.name.toLowerCase());
          const assessment = evaluateDockerNetworkRisk(
            network.name,
            network.containerCount,
            isSystem,
          );
          const isUnattached = network.containerCount === 0;
          const title = `${isSystem ? 'System' : isUnattached ? 'Unattached' : 'In-Use'} Docker Network (${network.name})`;
          const id = this.createFindingId('docker', assessment.category, network.id, title);

          findings.push({
            id,
            source: 'docker',
            category: assessment.category,
            title,
            description: assessment.reason,
            resourceId: network.id,
            risk: assessment.risk,
            confidence: assessment.confidence,
            recommendation: assessment.recommendation,
            evidence: [
              `Network ID: ${network.id}`,
              `Name: ${network.name}`,
              `Driver: ${network.driver}`,
              `Scope: ${network.scope}`,
              `Attached containers: ${network.containerCount}`,
              `System network: ${isSystem}`,
              `Candidate for review: ${!isSystem && isUnattached ? 'yes (unattached network with 0 container references)' : 'no'}`,
            ],
            reversible: assessment.reversible,
            detectedAt,
          });
        }

        // Build Cache
        if (input.docker.buildCache && input.docker.buildCache.length > 0) {
          for (const cacheItem of input.docker.buildCache) {
            const assessment = evaluateDockerBuildCacheRisk(cacheItem.id);
            const title = `Docker Build Cache Entry (${cacheItem.id})`;
            const id = this.createFindingId('docker', assessment.category, cacheItem.id, title);

            findings.push({
              id,
              source: 'docker',
              category: assessment.category,
              title,
              description: assessment.reason,
              resourceId: cacheItem.id,
              sizeBytes: cacheItem.sizeBytes,
              risk: assessment.risk,
              confidence: assessment.confidence,
              recommendation: assessment.recommendation,
              evidence: [
                `Cache ID: ${cacheItem.id}`,
                `Type: ${cacheItem.type || 'unknown'}`,
                `Size in bytes: ${cacheItem.sizeBytes}`,
              ],
              reversible: assessment.reversible,
              detectedAt,
            });
          }
        } else if (input.docker.totalReclaimableBytes > 0) {
          const assessment = evaluateDockerBuildCacheRisk();
          const title = 'Docker Reclaimable Build & System Cache';
          const id = this.createFindingId(
            'docker',
            assessment.category,
            'docker-reclaimable-cache',
            title,
          );

          findings.push({
            id,
            source: 'docker',
            category: assessment.category,
            title,
            description: assessment.reason,
            resourceId: 'docker-reclaimable-cache',
            sizeBytes: input.docker.totalReclaimableBytes,
            risk: assessment.risk,
            confidence: assessment.confidence,
            recommendation: assessment.recommendation,
            evidence: [
              `Explicit reclaimable storage reported by Docker: ${input.docker.totalReclaimableBytes} bytes`,
            ],
            reversible: assessment.reversible,
            detectedAt,
          });
        }
      }
    }

    // 3. Process Git Scan Results
    if (input.git) {
      if (input.git.truncated) {
        warnings.push('Git scan results were truncated due to limits.');
      }
      if (input.git.isRepository) {
        const assessment = evaluateGitRepositoryRisk(input.git.gitDirectory);
        const title = `Git Repository Metadata (${input.git.branch ?? 'HEAD'})`;
        const id = this.createFindingId('git', assessment.category, input.git.gitDirectory, title);

        findings.push({
          id,
          source: 'git',
          category: assessment.category,
          title,
          description: assessment.reason,
          path: input.git.gitDirectory,
          sizeBytes: input.git.repositorySizeBytes,
          risk: assessment.risk,
          confidence: assessment.confidence,
          recommendation: assessment.recommendation,
          evidence: [
            `Root path: ${input.git.rootPath}`,
            `Git directory: ${input.git.gitDirectory}`,
            `Directory type: ${input.git.gitDirectoryType}`,
            `Active branch: ${input.git.branch ?? 'detached'}`,
            `HEAD commit: ${input.git.head ?? 'unknown'}`,
            `Loose objects: ${input.git.looseObjectCount ?? 0}`,
            `Pack files: ${input.git.packCount ?? 0}`,
            `Total metadata size: ${input.git.repositorySizeBytes ?? 0} bytes`,
          ],
          reversible: assessment.reversible,
          detectedAt,
        });
      }
    }

    // 4. Process Dependency Scan Results
    if (input.dependencies) {
      if (input.dependencies.truncated) {
        warnings.push('Dependency scan results were truncated due to limits.');
      }

      // Check for genuine inconsistencies only (false-positive prevention)
      if (
        input.dependencies.manifestFound &&
        !input.dependencies.nodeModulesPresent &&
        input.dependencies.totalDependencies > 0
      ) {
        const description =
          'Manifest specifies dependencies, but node_modules is not installed in the workspace root.';
        const assessment = evaluateDependencyInconsistencyRisk(description);
        const title = 'Missing node_modules Directory';
        const targetPath = path.join(input.dependencies.rootPath, 'node_modules');
        const id = this.createFindingId('dependencies', assessment.category, targetPath, title);

        findings.push({
          id,
          source: 'dependencies',
          category: assessment.category,
          title,
          description,
          path: targetPath,
          risk: assessment.risk,
          confidence: assessment.confidence,
          recommendation: assessment.recommendation,
          evidence: [
            `Manifest found: ${input.dependencies.manifestType}`,
            `Declared dependencies count: ${input.dependencies.totalDependencies}`,
            'node_modules directory present: false',
          ],
          reversible: false,
          detectedAt,
        });
      } else if (!input.dependencies.manifestFound && input.dependencies.nodeModulesPresent) {
        const description =
          'Found installed node_modules directory without a parent package.json manifest in the root directory.';
        const assessment = evaluateDependencyInconsistencyRisk(description);
        const title = 'Orphaned node_modules Directory';
        const targetPath = path.join(input.dependencies.rootPath, 'node_modules');
        const id = this.createFindingId('dependencies', assessment.category, targetPath, title);

        findings.push({
          id,
          source: 'dependencies',
          category: assessment.category,
          title,
          description,
          path: targetPath,
          risk: assessment.risk,
          confidence: assessment.confidence,
          recommendation: assessment.recommendation,
          evidence: [
            'Manifest found: false',
            'node_modules directory present: true',
            `Installed package count: ${input.dependencies.totalInstalledDependencies}`,
          ],
          reversible: false,
          detectedAt,
        });
      }
    }

    // 5. Process File Scan Results
    if (input.files) {
      if (input.files.truncated) {
        warnings.push('File scan results were truncated due to limits.');
      }
      for (const entry of input.files.entries) {
        // False-positive prevention: arbitrary files, even if large, are NOT waste.
        // Only classify known regenerable OS/editor metadata files (.DS_Store, Thumbs.db).
        const baseName = path.basename(entry.relativePath);
        if (baseName === '.DS_Store' || baseName === 'Thumbs.db') {
          const title = `OS Metadata File (${entry.relativePath})`;
          const id = this.createFindingId('files', 'stale', entry.path, title);

          findings.push({
            id,
            source: 'files',
            category: 'stale',
            title,
            description: 'Temporary OS desktop view or thumbnail cache file.',
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            risk: 'low',
            confidence: 0.95,
            recommendation: 'review',
            evidence: [
              `Path: ${entry.path}`,
              `Relative path: ${entry.relativePath}`,
              `File size in bytes: ${entry.sizeBytes}`,
              `Last modified: ${entry.modifiedAt}`,
            ],
            reversible: true,
            detectedAt,
          });
        }
      }
    }

    // 6. Deterministic Sort of Findings
    findings.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      const targetA = a.path ?? a.resourceId ?? '';
      const targetB = b.path ?? b.resourceId ?? '';
      if (targetA !== targetB) return targetA.localeCompare(targetB);
      if (a.title !== b.title) return a.title.localeCompare(b.title);
      return a.id.localeCompare(b.id);
    });

    // 7. Calculate Risk Counters and Source Summary
    let lowRiskCount = 0;
    let mediumRiskCount = 0;
    let highRiskCount = 0;
    let criticalRiskCount = 0;

    const sourceSummary: Record<FindingSource, number> = {
      files: 0,
      git: 0,
      dependencies: 0,
      cache: 0,
      docker: 0,
    };

    for (const f of findings) {
      sourceSummary[f.source] = (sourceSummary[f.source] ?? 0) + 1;
      switch (f.risk) {
        case 'low':
          lowRiskCount++;
          break;
        case 'medium':
          mediumRiskCount++;
          break;
        case 'high':
          highRiskCount++;
          break;
        case 'critical':
          criticalRiskCount++;
          break;
      }
    }

    // 8. Calculate totalBytes without double-counting overlapping findings
    const totalBytes = this.calculateNonOverlappingBytes(findings);

    return {
      findings,
      totalFindings: findings.length,
      totalBytes,
      lowRiskCount,
      mediumRiskCount,
      highRiskCount,
      criticalRiskCount,
      sourceSummary,
      warnings,
    };
  }

  /**
   * Deterministically calculates total storage bytes while preventing double-counting of nested/overlapping paths.
   */
  private calculateNonOverlappingBytes(findings: AnalyzerFinding[]): number {
    let totalBytes = 0;

    // Separate path-based findings with sizeBytes from non-path findings
    const pathFindings = findings.filter(
      (f): f is AnalyzerFinding & { path: string; sizeBytes: number } =>
        typeof f.path === 'string' && typeof f.sizeBytes === 'number' && f.sizeBytes > 0,
    );

    // Sort path findings by path depth/length ascending so parent directories precede child subdirectories
    pathFindings.sort((a, b) => {
      const depthA = a.path.split(path.sep).length;
      const depthB = b.path.split(path.sep).length;
      if (depthA !== depthB) return depthA - depthB;
      return a.path.length - b.path.length;
    });

    const acceptedParentPaths: string[] = [];

    for (const pf of pathFindings) {
      const normalized = path.normalize(pf.path);
      // Check if this path is already nested inside an accepted parent path
      const isNested = acceptedParentPaths.some((parent) => {
        if (normalized === parent) return true;
        const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
        return normalized.startsWith(prefix);
      });

      if (!isNested) {
        totalBytes += pf.sizeBytes;
        acceptedParentPaths.push(normalized);
      }
    }

    // Add sizeBytes of non-path findings (e.g. Docker images, containers, build cache)
    for (const f of findings) {
      if (!f.path && typeof f.sizeBytes === 'number' && f.sizeBytes > 0) {
        totalBytes += f.sizeBytes;
      }
    }

    return totalBytes;
  }

  /**
   * Generates a stable, reproducible finding ID using SHA-256.
   * Does NOT incorporate timestamps or random elements.
   */
  private createFindingId(
    source: FindingSource,
    category: FindingCategory,
    target: string,
    title: string,
  ): string {
    const raw = `${source}:${category}:${target}:${title}`;
    const hash = createHash('sha256').update(raw).digest('hex').substring(0, 16);
    return `fn-${hash}`;
  }
}
