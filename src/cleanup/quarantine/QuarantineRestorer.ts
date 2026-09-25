import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QuarantineItem, QuarantineManifest } from '../../types/quarantine.js';
import type {
  QuarantineRestorerOptions,
  RestoreItem,
  RestoreReport,
} from '../../types/verification.js';
import { hashPath } from '../../utils/hash.js';

export const QUARANTINE_RESTORER_VERSION = '1.0.0';

/**
 * Dedicated QuarantineRestorer for Digital Janitor.
 *
 * SAFETY INVARIANTS:
 * - RESTORE != DELETE
 * - Restores ONLY explicitly requested action IDs.
 * - NEVER overwrites existing destinations.
 * - Strict protected path, symlink, and quarantine boundary enforcement.
 * - Zero deletion, zero shell commands, zero Docker calls.
 */
export class QuarantineRestorer {
  async restore(
    manifest: QuarantineManifest,
    actionIds: string[],
    options: QuarantineRestorerOptions,
  ): Promise<RestoreReport> {
    const restoredAt = options?.now ?? new Date().toISOString();

    // 1. Boundary check: Reject CleanupPlan or non-manifest inputs
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid manifest: QuarantineManifest object is required.');
    }

    if ('findingsAnalyzed' in manifest || 'approvedActions' in manifest) {
      throw new Error(
        'Execution boundary violated: QuarantineRestorer consumes QuarantineManifest, not CleanupPlan.',
      );
    }

    if (!Array.isArray(actionIds)) {
      throw new Error('Invalid actionIds: Explicit actionIds array is required.');
    }

    if (!options?.quarantineRoot || typeof options.quarantineRoot !== 'string') {
      throw new Error('Invalid options: quarantineRoot is required.');
    }

    const normalizedQuarantineRoot = path.normalize(path.resolve(options.quarantineRoot));
    const homeDir = path.normalize(os.homedir());

    // Deduplicate requested action IDs deterministically
    const uniqueActionIds = Array.from(new Set(actionIds)).sort();
    const manifestItemMap = new Map<string, QuarantineItem>();

    for (const item of manifest.items ?? []) {
      if (item && item.actionId) {
        manifestItemMap.set(item.actionId, item);
      }
    }

    const items: RestoreItem[] = [];

    // 2. Process each requested action explicitly and independently
    for (const actionId of uniqueActionIds) {
      const item = manifestItemMap.get(actionId);

      if (!item) {
        items.push({
          actionId,
          quarantinePath: '',
          originalPath: '',
          status: 'failed',
          error: `Action '${actionId}' was not found in QuarantineManifest '${manifest.manifestId}'.`,
        });
        continue;
      }

      const result = await this.restoreItem(item, normalizedQuarantineRoot, homeDir);
      items.push(result);
    }

    const restoredCount = items.filter((i) => i.status === 'restored').length;
    const failedCount = items.filter((i) => i.status === 'failed').length;
    const skippedCount = items.filter((i) => i.status === 'skipped').length;

    return {
      manifestId: manifest.manifestId,
      restoredAt,
      items,
      restoredCount,
      failedCount,
      skippedCount,
    };
  }

  private async restoreItem(
    item: QuarantineItem,
    normalizedQuarantineRoot: string,
    homeDir: string,
  ): Promise<RestoreItem> {
    const base: RestoreItem = {
      actionId: item.actionId,
      quarantinePath: item.quarantinePath,
      originalPath: item.sourcePath,
      status: 'failed',
    };

    // 1. Status Check: Must be quarantined
    if (item.status !== 'quarantined') {
      return {
        ...base,
        status: 'skipped',
        error: `Item was not successfully quarantined (manifest status was '${item.status}').`,
      };
    }

    // 2. Validate quarantinePath boundary
    const normQuar = path.normalize(path.resolve(item.quarantinePath));
    if (!normQuar.startsWith(normalizedQuarantineRoot + path.sep)) {
      return {
        ...base,
        status: 'failed',
        error: `Quarantine path '${normQuar}' escapes quarantineRoot '${normalizedQuarantineRoot}'.`,
      };
    }

    // 3. Inspect quarantine source with lstat
    let quarStat: fs.Stats;
    try {
      quarStat = await fs.promises.lstat(normQuar);
    } catch (err: unknown) {
      return {
        ...base,
        status: 'failed',
        error: `Quarantined item does not exist at '${normQuar}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Reject if quarantine source is a symlink
    if (quarStat.isSymbolicLink()) {
      return {
        ...base,
        status: 'failed',
        error: `Quarantined item at '${normQuar}' is an unexpected symbolic link.`,
      };
    }

    // 4. Validate originalPath (destination)
    if (!item.sourcePath || typeof item.sourcePath !== 'string') {
      return {
        ...base,
        status: 'failed',
        error: 'Invalid sourcePath in manifest.',
      };
    }

    const normDest = path.normalize(path.resolve(item.sourcePath));

    // Must not be inside quarantine root
    if (
      normDest === normalizedQuarantineRoot ||
      normDest.startsWith(normalizedQuarantineRoot + path.sep)
    ) {
      return {
        ...base,
        status: 'failed',
        error: `Safety violation: Original path '${normDest}' is inside quarantineRoot '${normalizedQuarantineRoot}'.`,
      };
    }

    // Must not be protected path
    const protectionError = this.checkProtectedPath(normDest, homeDir);
    if (protectionError) {
      return {
        ...base,
        status: 'failed',
        error: protectionError,
      };
    }

    // 5. Destination collision check: NEVER OVERWRITE
    try {
      const destStat = await fs.promises.lstat(normDest);
      if (destStat) {
        return {
          ...base,
          status: 'failed',
          error: `Destination path '${normDest}' already exists. Overwrite during restore is strictly forbidden.`,
        };
      }
    } catch {
      // Expected: destination does not exist
    }

    // 6. Safe restore move
    const destParentDir = path.dirname(normDest);
    try {
      await fs.promises.mkdir(destParentDir, { recursive: true });
      await fs.promises.rename(normQuar, normDest);
    } catch (err: unknown) {
      return {
        ...base,
        status: 'failed',
        error: `Failed to move quarantined item back to original path: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 7. Post-restore verification
    try {
      const restoredStat = await fs.promises.lstat(normDest);

      if (item.originalSha256) {
        const actualHash = await hashPath(normDest);
        if (actualHash !== item.originalSha256) {
          return {
            ...base,
            status: 'failed',
            error: `Post-restore verification failed: expected hash '${item.originalSha256}' but found '${actualHash}'.`,
          };
        }
      }

      if (
        restoredStat.isFile() &&
        item.originalSizeBytes !== undefined &&
        restoredStat.size !== item.originalSizeBytes
      ) {
        return {
          ...base,
          status: 'failed',
          error: `Post-restore verification failed: expected size ${item.originalSizeBytes} bytes but found ${restoredStat.size} bytes.`,
        };
      }
    } catch (err: unknown) {
      return {
        ...base,
        status: 'failed',
        error: `Post-restore verification inspection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      ...base,
      status: 'restored',
    };
  }

  private checkProtectedPath(targetPath: string, homeDir: string): string | null {
    if (targetPath === '/' || targetPath === path.parse(targetPath).root) {
      return `Protected path: Root directory '${targetPath}' cannot be target of restore.`;
    }

    if (targetPath === homeDir) {
      return `Protected path: User home directory '${targetPath}' cannot be target of restore.`;
    }

    const userProtectedDirs = ['desktop', 'documents', 'downloads', 'library'];
    const relativeToHome = path.relative(homeDir, targetPath);
    if (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
      const parts = relativeToHome.split(path.sep);
      if (parts.length === 1 && userProtectedDirs.includes(parts[0].toLowerCase())) {
        return `Protected path: User '${parts[0]}' folder cannot be target of restore.`;
      }
    }

    const tmpDir = path.normalize(os.tmpdir());
    const isInsideTmp = targetPath === tmpDir || targetPath.startsWith(tmpDir + path.sep);

    if (!isInsideTmp) {
      const systemRoots = ['/bin', '/sbin', '/usr', '/etc', '/System', '/Library', '/opt'];
      for (const sysRoot of systemRoots) {
        if (targetPath === sysRoot || targetPath.startsWith(sysRoot + path.sep)) {
          return `Protected path: System path '${targetPath}' cannot be target of restore.`;
        }
      }
      if (
        targetPath === '/var' ||
        (targetPath.startsWith('/var' + path.sep) &&
          !targetPath.startsWith('/var/folders' + path.sep))
      ) {
        return `Protected path: System path '${targetPath}' cannot be target of restore.`;
      }
    }

    const base = path.basename(targetPath);
    if (base === '.git' || targetPath.endsWith(path.sep + '.git')) {
      return `Protected path: Git repository metadata '${targetPath}' cannot be target of restore.`;
    }

    if (base === 'node_modules') {
      return `Protected path: The root 'node_modules' directory cannot be target of restore.`;
    }

    return null;
  }
}
