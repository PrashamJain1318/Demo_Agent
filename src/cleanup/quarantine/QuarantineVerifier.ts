import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QuarantineItem, QuarantineManifest } from '../../types/quarantine.js';
import type {
  QuarantineVerifierOptions,
  VerificationItem,
  VerificationReport,
  VerificationReportStatus,
} from '../../types/verification.js';
import { hashPath } from '../../utils/hash.js';

export const QUARANTINE_VERIFIER_VERSION = '1.0.0';

/**
 * Dedicated QuarantineVerifier for Digital Janitor.
 *
 * SAFETY INVARIANTS:
 * - VERIFY != DELETE
 * - Read-only: Zero filesystem writes, zero moves, zero renames, zero deletions.
 * - Consumes QuarantineManifest, strictly rejecting CleanupPlan.
 */
export class QuarantineVerifier {
  async verify(
    manifest: QuarantineManifest,
    options?: QuarantineVerifierOptions,
  ): Promise<VerificationReport> {
    const verifiedAt = options?.now ?? new Date().toISOString();

    // 1. Boundary check: Reject CleanupPlan or non-manifest objects
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid manifest: QuarantineManifest object is required.');
    }

    if ('findingsAnalyzed' in manifest || 'approvedActions' in manifest) {
      throw new Error(
        'Execution boundary violated: QuarantineVerifier consumes QuarantineManifest, not CleanupPlan or ApprovedExecutionPayload.',
      );
    }

    // 2. Validate manifest structure and integrity
    const validationErrors = this.validateManifest(manifest, options?.quarantineRoot);
    if (validationErrors.length > 0) {
      const rawItems = Array.isArray(manifest.items) ? manifest.items : [];
      const invalidItems: VerificationItem[] = rawItems.map((item) => ({
        actionId: item?.actionId ?? 'unknown',
        quarantinePath: item?.quarantinePath ?? '',
        originalPath: item?.sourcePath ?? '',
        status: 'invalid',
        error: validationErrors.join('; '),
      }));

      return {
        manifestId: manifest.manifestId ?? 'invalid-manifest',
        verifiedAt,
        status: 'invalid-manifest',
        items: invalidItems,
        intactCount: 0,
        missingCount: 0,
        modifiedCount: 0,
        inaccessibleCount: 0,
        invalidCount: invalidItems.length || 1,
      };
    }

    // 3. Verify each quarantined item
    const items: VerificationItem[] = [];

    for (const item of manifest.items) {
      const verificationItem = await this.verifyItem(item, options?.quarantineRoot);
      items.push(verificationItem);
    }

    const intactCount = items.filter((i) => i.status === 'intact').length;
    const missingCount = items.filter((i) => i.status === 'missing').length;
    const modifiedCount = items.filter((i) => i.status === 'modified').length;
    const inaccessibleCount = items.filter((i) => i.status === 'inaccessible').length;
    const invalidCount = items.filter((i) => i.status === 'invalid').length;

    let overallStatus: VerificationReportStatus = 'verified';
    if (missingCount > 0 || modifiedCount > 0 || inaccessibleCount > 0 || invalidCount > 0) {
      overallStatus = 'issues-found';
    }

    return {
      manifestId: manifest.manifestId,
      verifiedAt,
      status: overallStatus,
      items,
      intactCount,
      missingCount,
      modifiedCount,
      inaccessibleCount,
      invalidCount,
    };
  }

  private validateManifest(manifest: QuarantineManifest, quarantineRoot?: string): string[] {
    const errors: string[] = [];

    if (!manifest.manifestId || typeof manifest.manifestId !== 'string') {
      errors.push('Manifest ID is missing or invalid.');
    }

    if (!Array.isArray(manifest.items)) {
      errors.push('Manifest items must be an array.');
      return errors;
    }

    const seenActionIds = new Set<string>();

    for (const [idx, item] of manifest.items.entries()) {
      if (!item || typeof item !== 'object') {
        errors.push(`Manifest item at index ${idx} is not an object.`);
        continue;
      }

      if (!item.actionId || typeof item.actionId !== 'string') {
        errors.push(`Item at index ${idx} has missing or invalid actionId.`);
      } else if (seenActionIds.has(item.actionId)) {
        errors.push(`Duplicate actionId '${item.actionId}' found in manifest.`);
      } else {
        seenActionIds.add(item.actionId);
      }

      if (!item.sourcePath || typeof item.sourcePath !== 'string') {
        errors.push(`Item '${item.actionId}' has missing or invalid sourcePath.`);
      }

      if (!item.quarantinePath || typeof item.quarantinePath !== 'string') {
        errors.push(`Item '${item.actionId}' has missing or invalid quarantinePath.`);
      } else {
        // Path traversal checks
        if (item.quarantinePath.includes('\0') || item.quarantinePath.includes('..')) {
          errors.push(
            `Item '${item.actionId}' quarantinePath contains illegal traversal characters.`,
          );
        }

        if (quarantineRoot) {
          const normRoot = path.normalize(path.resolve(quarantineRoot));
          const normDest = path.normalize(path.resolve(item.quarantinePath));
          if (!normDest.startsWith(normRoot + path.sep)) {
            errors.push(`Item '${item.actionId}' quarantinePath escapes quarantineRoot.`);
          }
        }
      }

      if (item.sourcePath && item.quarantinePath && item.sourcePath === item.quarantinePath) {
        errors.push(`Item '${item.actionId}' sourcePath cannot equal quarantinePath.`);
      }

      const validStatuses = ['quarantined', 'failed', 'skipped'];
      if (!validStatuses.includes(item.status)) {
        errors.push(`Item '${item.actionId}' has invalid status '${item.status}'.`);
      }

      const validTypes = ['remove-file', 'remove-directory'];
      if (!validTypes.includes(item.actionType)) {
        errors.push(`Item '${item.actionId}' has unsupported actionType '${item.actionType}'.`);
      }
    }

    return errors;
  }

  private async verifyItem(
    item: QuarantineItem,
    quarantineRoot?: string,
  ): Promise<VerificationItem> {
    const baseItem: VerificationItem = {
      actionId: item.actionId,
      quarantinePath: item.quarantinePath,
      originalPath: item.sourcePath,
      status: 'invalid',
      expectedSizeBytes: item.originalSizeBytes,
      expectedHash: item.originalSha256,
    };

    if (item.status !== 'quarantined') {
      return {
        ...baseItem,
        status: 'invalid',
        error: `Item was not successfully quarantined in manifest (status was '${item.status}').`,
      };
    }

    // Validate root boundary
    if (quarantineRoot) {
      const normRoot = path.normalize(path.resolve(quarantineRoot));
      const normDest = path.normalize(path.resolve(item.quarantinePath));
      if (!normDest.startsWith(normRoot + path.sep)) {
        return {
          ...baseItem,
          status: 'invalid',
          error: `Quarantine path '${normDest}' escapes expected quarantineRoot '${normRoot}'.`,
        };
      }
    }

    // Inspect with lstat
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(item.quarantinePath);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        return {
          ...baseItem,
          status: 'missing',
          error: `Quarantined item not found at '${item.quarantinePath}'.`,
        };
      }
      return {
        ...baseItem,
        status: 'inaccessible',
        error: `Cannot access quarantined item: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Reject symbolic links at quarantine root
    if (stat.isSymbolicLink()) {
      return {
        ...baseItem,
        status: 'invalid',
        error: `Quarantined item at '${item.quarantinePath}' is an unexpected symbolic link.`,
      };
    }

    // Calculate actual size & hash
    let actualHash: string;
    let actualSize: number | undefined;

    try {
      actualHash = await hashPath(item.quarantinePath);
      actualSize = stat.isFile() ? stat.size : item.originalSizeBytes;
    } catch (err: unknown) {
      return {
        ...baseItem,
        status: 'inaccessible',
        error: `Failed to inspect quarantined content: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    baseItem.actualHash = actualHash;
    baseItem.actualSizeBytes = actualSize;

    // Compare with expected metadata
    if (item.originalSha256 && actualHash !== item.originalSha256) {
      return {
        ...baseItem,
        status: 'modified',
        error: `Quarantined content modified (hash mismatch): expected hash '${item.originalSha256}' but found '${actualHash}'.`,
      };
    }

    if (
      stat.isFile() &&
      item.originalSizeBytes !== undefined &&
      actualSize !== item.originalSizeBytes
    ) {
      return {
        ...baseItem,
        status: 'modified',
        error: `Quarantined file size modified: expected ${item.originalSizeBytes} bytes but found ${actualSize} bytes.`,
      };
    }

    return {
      ...baseItem,
      status: 'intact',
    };
  }
}
