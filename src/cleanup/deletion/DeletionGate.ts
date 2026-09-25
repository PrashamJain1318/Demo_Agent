import * as os from 'node:os';
import * as path from 'node:path';
import type { QuarantineManifest } from '../../types/quarantine.js';
import type { VerificationReport } from '../../types/verification.js';
import type {
  DeletionGateOptions,
  DeletionRequest,
  ValidatedDeletionItem,
  ValidatedDeletionPayload,
} from '../../types/deletion.js';

export const DELETION_GATE_VERSION = '1.0.0';

/**
 * Pure, deterministic final deletion approval gate for Digital Janitor.
 *
 * SAFETY INVARIANTS:
 * - NO APPROVAL -> NO PERMANENT DELETE
 * - PURE & SIDE-EFFECT FREE: Zero filesystem mutations, zero command execution.
 * - Consumes ONLY QuarantineManifest + VerificationReport + DeletionRequest.
 * - Requires explicit final approval for specific action IDs.
 * - Requires latest verification status to be 'intact'.
 * - Rejects any modified, missing, inaccessible, or stale verification items.
 */
export class DeletionGate {
  evaluate(
    manifest: QuarantineManifest,
    verification: VerificationReport,
    request: DeletionRequest,
    options?: DeletionGateOptions,
  ): ValidatedDeletionPayload {
    const validatedAt = options?.now ?? new Date().toISOString();

    // 1. Boundary Checks
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid manifest: QuarantineManifest is required.');
    }
    if ('findingsAnalyzed' in manifest || 'approvedActions' in manifest) {
      throw new Error(
        'Execution boundary violated: DeletionGate cannot consume CleanupPlan or ApprovedExecutionPayload.',
      );
    }
    if (!verification || typeof verification !== 'object') {
      throw new Error('Invalid verification: VerificationReport is required.');
    }
    if (!request || typeof request !== 'object') {
      throw new Error('Invalid request: DeletionRequest is required.');
    }

    const uniqueActionIds = Array.from(new Set(request.actionIds ?? [])).sort();
    const rejectionReasons: Record<string, string> = {};
    const approvedActionIds: string[] = [];
    const rejectedActionIds: string[] = [];
    const eligibleItems: ValidatedDeletionItem[] = [];

    // 2. Manifest ID Matching
    if (!request.manifestId || request.manifestId !== manifest.manifestId) {
      const reason = `Manifest ID mismatch: request specifies '${request.manifestId}', but manifest is '${manifest.manifestId}'.`;
      for (const id of uniqueActionIds) {
        rejectionReasons[id] = reason;
        rejectedActionIds.push(id);
      }
      return {
        manifestId: request.manifestId ?? 'unknown',
        decision: 'rejected',
        approvedActionIds: [],
        rejectedActionIds,
        eligibleItems: [],
        rejectionReasons,
        validatedAt,
        requestedBy: request.requestedBy,
      };
    }

    if (verification.manifestId !== request.manifestId) {
      const reason = `Verification manifest ID mismatch: verification report is for '${verification.manifestId}', but request is for '${request.manifestId}'.`;
      for (const id of uniqueActionIds) {
        rejectionReasons[id] = reason;
        rejectedActionIds.push(id);
      }
      return {
        manifestId: request.manifestId,
        decision: 'rejected',
        approvedActionIds: [],
        rejectedActionIds,
        eligibleItems: [],
        rejectionReasons,
        validatedAt,
        requestedBy: request.requestedBy,
      };
    }

    // 3. Explicit Approval Decision Check
    if (request.decision !== 'approved') {
      const reason = request.reason || 'Deletion request was explicitly rejected by operator.';
      for (const id of uniqueActionIds) {
        rejectionReasons[id] = reason;
        rejectedActionIds.push(id);
      }
      return {
        manifestId: request.manifestId,
        decision: 'rejected',
        approvedActionIds: [],
        rejectedActionIds,
        eligibleItems: [],
        rejectionReasons,
        validatedAt,
        requestedBy: request.requestedBy,
      };
    }

    // 4. Index manifest and verification items
    const manifestMap = new Map((manifest.items ?? []).map((i) => [i.actionId, i]));
    const verificationMap = new Map((verification.items ?? []).map((i) => [i.actionId, i]));
    const homeDir = path.normalize(os.homedir());
    const normQuarantineRoot = options?.quarantineRoot
      ? path.normalize(path.resolve(options.quarantineRoot))
      : undefined;

    // 5. Evaluate each requested action ID independently
    for (const actionId of uniqueActionIds) {
      const manifestItem = manifestMap.get(actionId);

      // Check existence in manifest
      if (!manifestItem) {
        rejectionReasons[actionId] =
          `Action '${actionId}' does not exist in QuarantineManifest '${manifest.manifestId}'.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Check quarantine status
      if (manifestItem.status !== 'quarantined') {
        rejectionReasons[actionId] =
          `Action '${actionId}' is not quarantined (status: '${manifestItem.status}').`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Check action type: only filesystem actions are supported
      if (
        manifestItem.actionType !== 'remove-file' &&
        manifestItem.actionType !== 'remove-directory'
      ) {
        rejectionReasons[actionId] =
          `Action '${actionId}' has unsupported type '${manifestItem.actionType}' for filesystem deletion.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Check existence in verification report
      const verificationItem = verificationMap.get(actionId);
      if (!verificationItem) {
        rejectionReasons[actionId] =
          `Action '${actionId}' has no corresponding verification item in VerificationReport.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Check verification status: MUST be intact
      if (verificationItem.status !== 'intact') {
        rejectionReasons[actionId] =
          `Action '${actionId}' verification status is '${verificationItem.status}' (expected 'intact'): ${verificationItem.error ?? 'unverified'}`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Quarantine path consistency check
      const normManifestQuar = path.normalize(path.resolve(manifestItem.quarantinePath));
      const normVerifyQuar = path.normalize(path.resolve(verificationItem.quarantinePath));
      if (normManifestQuar !== normVerifyQuar) {
        rejectionReasons[actionId] =
          `Quarantine path mismatch for action '${actionId}': manifest has '${normManifestQuar}', verification has '${normVerifyQuar}'.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Stale verification check: Compare hashes
      if (
        manifestItem.originalSha256 &&
        verificationItem.actualHash &&
        manifestItem.originalSha256 !== verificationItem.actualHash
      ) {
        rejectionReasons[actionId] =
          `Stale verification: Manifest originalSha256 '${manifestItem.originalSha256}' does not match verified hash '${verificationItem.actualHash}'.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Path safety checks
      if (normManifestQuar.includes('\0') || normManifestQuar.includes('..')) {
        rejectionReasons[actionId] =
          `Action '${actionId}' quarantinePath contains illegal traversal characters.`;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Quarantine root boundary
      if (normQuarantineRoot) {
        if (!normManifestQuar.startsWith(normQuarantineRoot + path.sep)) {
          rejectionReasons[actionId] =
            `Action '${actionId}' quarantinePath escapes quarantineRoot.`;
          rejectedActionIds.push(actionId);
          continue;
        }
        if (normManifestQuar === normQuarantineRoot) {
          rejectionReasons[actionId] = `Safety violation: Cannot delete quarantineRoot itself.`;
          rejectedActionIds.push(actionId);
          continue;
        }
      }

      // Protected system path check
      const protectedError = this.checkProtectedPath(normManifestQuar, homeDir);
      if (protectedError) {
        rejectionReasons[actionId] = protectedError;
        rejectedActionIds.push(actionId);
        continue;
      }

      // Passed all checks!
      approvedActionIds.push(actionId);
      eligibleItems.push({
        actionId,
        quarantinePath: normManifestQuar,
        originalPath: manifestItem.sourcePath,
        actionType: manifestItem.actionType,
        verifiedSha256: verificationItem.actualHash ?? manifestItem.originalSha256,
        verifiedSizeBytes: verificationItem.actualSizeBytes ?? manifestItem.originalSizeBytes,
      });
    }

    const finalDecision = approvedActionIds.length > 0 ? 'approved' : 'rejected';

    return {
      manifestId: request.manifestId,
      decision: finalDecision,
      approvedActionIds,
      rejectedActionIds,
      eligibleItems,
      rejectionReasons,
      validatedAt,
      requestedBy: request.requestedBy,
    };
  }

  private checkProtectedPath(targetPath: string, homeDir: string): string | null {
    if (targetPath === '/' || targetPath === path.parse(targetPath).root) {
      return `Protected path: Root directory '${targetPath}' cannot be deleted.`;
    }

    if (targetPath === homeDir) {
      return `Protected path: User home directory '${targetPath}' cannot be deleted.`;
    }

    const userProtectedDirs = ['desktop', 'documents', 'downloads', 'library'];
    const relativeToHome = path.relative(homeDir, targetPath);
    if (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
      const parts = relativeToHome.split(path.sep);
      if (parts.length === 1 && userProtectedDirs.includes(parts[0].toLowerCase())) {
        return `Protected path: User '${parts[0]}' folder cannot be deleted.`;
      }
    }

    const tmpDir = path.normalize(os.tmpdir());
    const isInsideTmp = targetPath === tmpDir || targetPath.startsWith(tmpDir + path.sep);

    if (!isInsideTmp) {
      const systemRoots = ['/bin', '/sbin', '/usr', '/etc', '/System', '/Library', '/opt'];
      for (const sysRoot of systemRoots) {
        if (targetPath === sysRoot || targetPath.startsWith(sysRoot + path.sep)) {
          return `Protected path: System path '${targetPath}' cannot be deleted.`;
        }
      }
      if (
        targetPath === '/var' ||
        (targetPath.startsWith('/var' + path.sep) &&
          !targetPath.startsWith('/var/folders' + path.sep))
      ) {
        return `Protected path: System path '${targetPath}' cannot be deleted.`;
      }
    }

    const base = path.basename(targetPath);
    if (base === '.git' || targetPath.endsWith(path.sep + '.git')) {
      return `Protected path: Git repository metadata '${targetPath}' cannot be deleted.`;
    }

    if (base === 'node_modules') {
      return `Protected path: The root 'node_modules' directory cannot be deleted.`;
    }

    return null;
  }
}
