import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { AnalyzerFinding, AnalyzerResult } from '../../types/analyzer.js';
import type {
  BlockedCleanupItem,
  CleanupAction,
  CleanupPlan,
  CleanupPlannerOptions,
} from '../../types/cleanup.js';

export const PLANNER_VERSION = '1.0.0';

/**
 * Deterministic, read-only planner that converts Analyzer findings into structured
 * proposed cleanup actions requiring explicit human approval.
 *
 * Guarantees:
 * - Pure, deterministic, side-effect free transformation (AnalyzerResult → CleanupPlan).
 * - Zero deletion, movement, quarantine, shell execution, or Docker execution.
 * - Every plan and action strictly enforces `requiresApproval: true`.
 * - High-risk findings and Docker volumes are excluded/blocked by default.
 * - Eliminates duplicate/overlapping actions on nested directory paths.
 * - Stable, reproducible action and plan IDs independent of execution timestamps.
 */
export class CleanupPlanner {
  plan(analyzerResult: AnalyzerResult, options?: CleanupPlannerOptions): CleanupPlan {
    const includeLowRisk = options?.includeLowRisk ?? true;
    const includeMediumRisk = options?.includeMediumRisk ?? true;
    const includeHighRisk = options?.includeHighRisk ?? false;
    const includeCriticalRisk = options?.includeCriticalRisk ?? false;
    const createdAt = options?.now ?? new Date().toISOString();

    const candidateActions: CleanupAction[] = [];
    const blockedActions: BlockedCleanupItem[] = [];
    const warnings: string[] = [...(analyzerResult.warnings ?? [])];

    for (const finding of analyzerResult.findings) {
      // 1. Git Repository Findings
      if (finding.source === 'git' || finding.category === 'repository') {
        blockedActions.push({
          findingId: finding.id,
          reason: 'Git repository metadata is protected and is not eligible for cleanup planning.',
          risk: finding.risk,
          category: finding.category,
          target: finding.path,
        });
        continue;
      }

      // 2. Dependency Findings
      if (finding.source === 'dependencies' || finding.category === 'dependency') {
        blockedActions.push({
          findingId: finding.id,
          reason: 'Dependency findings are not eligible for automated removal actions.',
          risk: finding.risk,
          category: finding.category,
          target: finding.path ?? finding.resourceId,
        });
        continue;
      }

      // 3. Docker Findings
      if (finding.source === 'docker' || finding.category === 'docker') {
        this.evaluateDockerFinding(
          finding,
          { includeLowRisk, includeMediumRisk, includeHighRisk, includeCriticalRisk },
          candidateActions,
          blockedActions,
        );
        continue;
      }

      // 4. Cache & Build-Artifact Findings
      if (
        finding.source === 'cache' ||
        finding.category === 'cache' ||
        finding.category === 'build-artifact'
      ) {
        this.evaluateCacheFinding(
          finding,
          { includeLowRisk, includeMediumRisk, includeHighRisk, includeCriticalRisk },
          candidateActions,
          blockedActions,
        );
        continue;
      }

      // 5. Files Findings
      if (finding.source === 'files') {
        this.evaluateFileFinding(
          finding,
          { includeLowRisk, includeMediumRisk, includeHighRisk, includeCriticalRisk },
          candidateActions,
          blockedActions,
        );
        continue;
      }

      // Fallback for unclassified findings
      blockedActions.push({
        findingId: finding.id,
        reason: 'Finding category is unclassified and not eligible for automated cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target: finding.path ?? finding.resourceId,
      });
    }

    // 6. Overlapping Action Deduplication (Paths)
    const { deduplicatedActions, overlapBlocked } =
      this.deduplicateOverlappingActions(candidateActions);
    blockedActions.push(...overlapBlocked);

    // 7. Deterministic Sorting
    deduplicatedActions.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      if (a.target !== b.target) return a.target.localeCompare(b.target);
      if (a.sourceFindingId !== b.sourceFindingId)
        return a.sourceFindingId.localeCompare(b.sourceFindingId);
      return a.id.localeCompare(b.id);
    });

    blockedActions.sort((a, b) => {
      if (a.findingId !== b.findingId) return a.findingId.localeCompare(b.findingId);
      return a.reason.localeCompare(b.reason);
    });

    // 8. Total Estimated Storage Calculation (Deduplicated Actions Only)
    const totalEstimatedBytes = deduplicatedActions.reduce(
      (sum, action) => sum + (action.estimatedBytes ?? 0),
      0,
    );

    // 9. Deterministic Plan ID Generation
    const sortedFindingIds = analyzerResult.findings.map((f) => f.id).sort();
    const sortedActionIds = deduplicatedActions.map((a) => a.id).sort();
    const planRaw = `${PLANNER_VERSION}:${sortedFindingIds.join(',')}:${sortedActionIds.join(',')}`;
    const planHash = createHash('sha256').update(planRaw).digest('hex').substring(0, 16);
    const planId = `plan-${planHash}`;

    return {
      id: planId,
      createdAt,
      findingsAnalyzed: analyzerResult.totalFindings,
      actions: deduplicatedActions,
      totalEstimatedBytes,
      requiresHumanApproval: true,
      warnings,
      blockedActions,
    };
  }

  private evaluateDockerFinding(
    finding: AnalyzerFinding,
    riskFilters: {
      includeLowRisk: boolean;
      includeMediumRisk: boolean;
      includeHighRisk: boolean;
      includeCriticalRisk: boolean;
    },
    actions: CleanupAction[],
    blocked: BlockedCleanupItem[],
  ): void {
    const title = finding.title;
    const target = finding.resourceId ?? finding.path ?? '';

    // CRITICAL SAFETY RULE: Docker Volumes are NEVER directly planned for removal in Step 9
    if (title.includes('Docker Volume')) {
      blocked.push({
        findingId: finding.id,
        reason:
          'Unattached Docker volumes may contain persistent data and require explicit investigation before any cleanup action.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Retained or In-Use Docker Resources
    if (finding.recommendation === 'retain') {
      let reason = 'Retained Docker resources are not eligible for cleanup planning.';
      if (title.startsWith('Running Docker Container')) {
        reason = 'Running Docker containers are not eligible for automatic cleanup planning.';
      } else if (title.startsWith('In-Use Docker Image')) {
        reason = 'Referenced or in-use Docker images are not eligible for cleanup planning.';
      } else if (
        title.startsWith('System Docker Network') ||
        ['bridge', 'host', 'none'].includes(target.toLowerCase())
      ) {
        reason = 'Default Docker system networks cannot be removed.';
      } else if (title.startsWith('In-Use Docker Network')) {
        reason = 'Attached or in-use Docker networks are not eligible for cleanup planning.';
      }

      blocked.push({
        findingId: finding.id,
        reason,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Explicit In-Use / System checks
    if (title.startsWith('Running Docker Container')) {
      blocked.push({
        findingId: finding.id,
        reason: 'Running Docker containers are not eligible for automatic cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    if (title.startsWith('In-Use Docker Image')) {
      blocked.push({
        findingId: finding.id,
        reason: 'Referenced or in-use Docker images are not eligible for cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    if (
      title.startsWith('System Docker Network') ||
      ['bridge', 'host', 'none'].includes(target.toLowerCase())
    ) {
      blocked.push({
        findingId: finding.id,
        reason: 'Default Docker system networks cannot be removed.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    if (title.startsWith('In-Use Docker Network')) {
      blocked.push({
        findingId: finding.id,
        reason: 'Attached or in-use Docker networks are not eligible for cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Check risk filtering before planning any action
    if (!this.isRiskAllowed(finding.risk, riskFilters)) {
      blocked.push({
        findingId: finding.id,
        reason: `Finding excluded because its risk level is ${finding.risk} and the planner does not include ${finding.risk}-risk actions by default.`,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Stopped Containers
    if (title.startsWith('Stopped Docker Container')) {
      const actionId = this.createActionId('docker-remove-container', target, finding.id);
      actions.push({
        id: actionId,
        type: 'docker-remove-container',
        target,
        sourceFindingId: finding.id,
        title: `Remove Stopped Docker Container (${target})`,
        reason: `Proposed removal of stopped container '${target}'.`,
        risk: finding.risk,
        estimatedBytes: finding.sizeBytes,
        reversible: false,
        requiresApproval: true,
        prerequisites: ['Explicit operator approval required before container removal'],
        warnings: [
          'Docker container removal is irreversible; container state and local modifications not stored in a volume will be permanently lost.',
        ],
      });
      return;
    }

    // Unreferenced Images
    if (title.startsWith('Unreferenced Docker Image')) {
      const actionId = this.createActionId('docker-remove-image', target, finding.id);
      actions.push({
        id: actionId,
        type: 'docker-remove-image',
        target,
        sourceFindingId: finding.id,
        title: `Remove Unreferenced Docker Image (${target})`,
        reason: `Proposed removal of unreferenced container image '${target}'.`,
        risk: finding.risk,
        estimatedBytes: finding.sizeBytes,
        reversible: false,
        requiresApproval: true,
        prerequisites: ['Explicit operator approval required before image removal'],
        warnings: [
          'Docker image removal is irreversible; image must be redownloaded or rebuilt from Dockerfile if needed in the future.',
        ],
      });
      return;
    }

    // Unattached Networks
    if (title.startsWith('Unattached Docker Network')) {
      const actionId = this.createActionId('docker-remove-network', target, finding.id);
      actions.push({
        id: actionId,
        type: 'docker-remove-network',
        target,
        sourceFindingId: finding.id,
        title: `Remove Unattached Docker Network (${target})`,
        reason: `Proposed removal of unattached custom network '${target}'.`,
        risk: finding.risk,
        reversible: false,
        requiresApproval: true,
        prerequisites: ['Explicit operator approval required before network removal'],
        warnings: [
          'Docker network removal is irreversible; inactive compose stacks referencing this network must recreate it.',
        ],
      });
      return;
    }

    // Build Cache
    if (title.includes('Build Cache') || title.includes('Build & System Cache')) {
      const actionId = this.createActionId('docker-prune-build-cache', target, finding.id);
      actions.push({
        id: actionId,
        type: 'docker-prune-build-cache',
        target,
        sourceFindingId: finding.id,
        title: 'Prune Docker Build Cache',
        reason: 'Proposed pruning of Docker build cache layers.',
        risk: finding.risk,
        estimatedBytes: finding.sizeBytes,
        reversible: false,
        requiresApproval: true,
        prerequisites: ['Explicit operator approval required before build cache pruning'],
        warnings: [
          'Docker build cache pruning is irreversible; cached layers will be reconstructed during subsequent build operations.',
        ],
      });
      return;
    }

    blocked.push({
      findingId: finding.id,
      reason: 'Docker resource finding is not eligible for automated cleanup planning.',
      risk: finding.risk,
      category: finding.category,
      target,
    });
  }

  private evaluateCacheFinding(
    finding: AnalyzerFinding,
    riskFilters: {
      includeLowRisk: boolean;
      includeMediumRisk: boolean;
      includeHighRisk: boolean;
      includeCriticalRisk: boolean;
    },
    actions: CleanupAction[],
    blocked: BlockedCleanupItem[],
  ): void {
    const target = finding.path ?? '';

    // Generic caches require investigation and are never automatically planned
    if (
      finding.recommendation === 'investigate' ||
      finding.title.includes('GENERIC') ||
      finding.description.includes('Generic cache')
    ) {
      blocked.push({
        findingId: finding.id,
        reason: 'Generic cache requires investigation before cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Validate against protected system root paths
    if (this.isProtectedPath(target)) {
      blocked.push({
        findingId: finding.id,
        reason: `Target path '${target}' is a protected directory and cannot be planned for removal.`,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Check risk filtering
    if (!this.isRiskAllowed(finding.risk, riskFilters)) {
      blocked.push({
        findingId: finding.id,
        reason: `Finding excluded because its risk level is ${finding.risk} and the planner does not include ${finding.risk}-risk actions by default.`,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    // Known regenerable caches (.next/cache, node_modules/.vite, __pycache__, .npm, etc.)
    const actionId = this.createActionId('remove-directory', target, finding.id);
    actions.push({
      id: actionId,
      type: 'remove-directory',
      target,
      sourceFindingId: finding.id,
      title: `Remove Cache Directory (${path.basename(target)})`,
      reason: `Proposed cleanup of regenerable cache directory '${target}'.`,
      risk: finding.risk,
      estimatedBytes: finding.sizeBytes,
      reversible: true,
      requiresApproval: true,
      prerequisites: ['Explicit operator approval required before quarantine/removal'],
      warnings: ['Directory will be quarantined before permanent deletion.'],
    });
  }

  private evaluateFileFinding(
    finding: AnalyzerFinding,
    riskFilters: {
      includeLowRisk: boolean;
      includeMediumRisk: boolean;
      includeHighRisk: boolean;
      includeCriticalRisk: boolean;
    },
    actions: CleanupAction[],
    blocked: BlockedCleanupItem[],
  ): void {
    const target = finding.path ?? '';
    const baseName = path.basename(target);

    // Only allow known regenerable metadata files (.DS_Store, Thumbs.db)
    if (baseName !== '.DS_Store' && baseName !== 'Thumbs.db') {
      blocked.push({
        findingId: finding.id,
        reason: 'Arbitrary files are not eligible for automated cleanup planning.',
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    if (this.isProtectedPath(target)) {
      blocked.push({
        findingId: finding.id,
        reason: `Target path '${target}' is protected and cannot be planned for removal.`,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    if (!this.isRiskAllowed(finding.risk, riskFilters)) {
      blocked.push({
        findingId: finding.id,
        reason: `Finding excluded because its risk level is ${finding.risk} and the planner does not include ${finding.risk}-risk actions by default.`,
        risk: finding.risk,
        category: finding.category,
        target,
      });
      return;
    }

    const actionId = this.createActionId('remove-file', target, finding.id);
    actions.push({
      id: actionId,
      type: 'remove-file',
      target,
      sourceFindingId: finding.id,
      title: `Remove OS Metadata File (${baseName})`,
      reason: `Proposed removal of temporary desktop metadata file '${target}'.`,
      risk: finding.risk,
      estimatedBytes: finding.sizeBytes,
      reversible: true,
      requiresApproval: true,
      prerequisites: ['Explicit operator approval required before removal'],
      warnings: [],
    });
  }

  /**
   * Filters out candidate filesystem actions whose target paths are nested within
   * another accepted directory cleanup action.
   */
  private deduplicateOverlappingActions(actions: CleanupAction[]): {
    deduplicatedActions: CleanupAction[];
    overlapBlocked: BlockedCleanupItem[];
  } {
    const fsActions = actions.filter(
      (a) => a.type === 'remove-directory' || a.type === 'remove-file',
    );
    const nonFsActions = actions.filter(
      (a) => a.type !== 'remove-directory' && a.type !== 'remove-file',
    );

    // Sort by path depth / length ascending so parent directory actions precede child actions
    fsActions.sort((a, b) => {
      const depthA = a.target.split(path.sep).length;
      const depthB = b.target.split(path.sep).length;
      if (depthA !== depthB) return depthA - depthB;
      return a.target.length - b.target.length;
    });

    const acceptedFsActions: CleanupAction[] = [];
    const overlapBlocked: BlockedCleanupItem[] = [];

    for (const action of fsActions) {
      const normalizedTarget = path.normalize(action.target);
      const parentAction = acceptedFsActions.find((accepted) => {
        if (accepted.type !== 'remove-directory') return false;
        const normalizedParent = path.normalize(accepted.target);
        if (normalizedTarget === normalizedParent) return true;
        const parentPrefix = normalizedParent.endsWith(path.sep)
          ? normalizedParent
          : normalizedParent + path.sep;
        return normalizedTarget.startsWith(parentPrefix);
      });

      if (parentAction) {
        overlapBlocked.push({
          findingId: action.sourceFindingId,
          reason: `Target path is nested within parent cleanup action: ${parentAction.target}`,
          risk: action.risk,
          category: 'cache',
          target: action.target,
        });
      } else {
        acceptedFsActions.push(action);
      }
    }

    return {
      deduplicatedActions: [...acceptedFsActions, ...nonFsActions],
      overlapBlocked,
    };
  }

  private isProtectedPath(targetPath: string): boolean {
    if (!targetPath) return true;
    const normalized = path.normalize(targetPath);

    // Root directory check
    if (normalized === '/' || normalized === path.parse(normalized).root) {
      return true;
    }

    const base = path.basename(normalized);

    // Entire parent roots that must never be removed
    if (base === '.git' || base === 'node_modules') {
      return true;
    }

    // Critical system folders
    const protectedDirNames = new Set([
      'desktop',
      'documents',
      'downloads',
      'library',
      'bin',
      'usr',
      'etc',
      'system',
    ]);
    if (protectedDirNames.has(base.toLowerCase()) && normalized.split(path.sep).length <= 4) {
      return true;
    }

    return false;
  }

  private isRiskAllowed(
    risk: string,
    filters: {
      includeLowRisk: boolean;
      includeMediumRisk: boolean;
      includeHighRisk: boolean;
      includeCriticalRisk: boolean;
    },
  ): boolean {
    switch (risk) {
      case 'low':
        return filters.includeLowRisk;
      case 'medium':
        return filters.includeMediumRisk;
      case 'high':
        return filters.includeHighRisk;
      case 'critical':
        return filters.includeCriticalRisk;
      default:
        return false;
    }
  }

  private createActionId(type: string, target: string, sourceFindingId: string): string {
    const raw = `${type}:${target}:${sourceFindingId}`;
    const hash = createHash('sha256').update(raw).digest('hex').substring(0, 16);
    return `action-${hash}`;
  }
}
