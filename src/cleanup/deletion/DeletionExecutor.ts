import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DeletionExecutorOptions,
  DeletionItem,
  DeletionReport,
  ValidatedDeletionItem,
  ValidatedDeletionPayload,
} from '../../types/deletion.js';
import { hashPath } from '../../utils/hash.js';

export const DELETION_EXECUTOR_VERSION = '1.0.0';

/**
 * Dedicated DeletionExecutor for Digital Janitor.
 *
 * SAFETY INVARIANTS:
 * - Consumes ONLY ValidatedDeletionPayload from DeletionGate.
 * - Enforces last-moment integrity check (re-hashes target immediately before deletion).
 * - Deletes ONLY within quarantineRoot; never deletes outside quarantine.
 * - Protects system roots, user home, .git, and quarantineRoot itself.
 * - Never deletes symbolic links.
 * - Zero shell execution, zero sub-process execution, zero Docker mutation.
 * - Only Node fs.promises.unlink (files) and fs.promises.rm (directories) on verified paths.
 */
export class DeletionExecutor {
  async execute(
    payload: ValidatedDeletionPayload,
    options: DeletionExecutorOptions,
  ): Promise<DeletionReport> {
    const deletedAt = options?.now ?? new Date().toISOString();

    // 1. Boundary Enforcement
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid payload: ValidatedDeletionPayload is required.');
    }
    if (
      'findingsAnalyzed' in payload ||
      'actions' in payload ||
      !('eligibleItems' in payload) ||
      !('decision' in payload)
    ) {
      throw new Error(
        'Execution boundary violated: DeletionExecutor consumes ValidatedDeletionPayload from DeletionGate, not CleanupPlan or raw manifests.',
      );
    }

    if (payload.decision !== 'approved') {
      throw new Error(
        `Execution boundary violated: Cannot execute deletion for payload with decision '${payload.decision}'.`,
      );
    }

    if (!options?.quarantineRoot || typeof options.quarantineRoot !== 'string') {
      throw new Error('Invalid options: quarantineRoot is required.');
    }

    const normalizedQuarantineRoot = path.normalize(path.resolve(options.quarantineRoot));
    const homeDir = path.normalize(os.homedir());
    const dryRun = options.dryRun ?? false;

    const items: DeletionItem[] = [];

    // 2. Execute deletion independently for each eligible item
    for (const item of payload.eligibleItems) {
      const result = await this.deleteItem(item, normalizedQuarantineRoot, homeDir, dryRun);
      items.push(result);
    }

    const deletedCount = items.filter((i) => i.status === 'deleted').length;
    const failedCount = items.filter((i) => i.status === 'failed').length;
    const skippedCount = items.filter((i) => i.status === 'skipped').length;

    return {
      manifestId: payload.manifestId,
      deletedAt,
      items,
      deletedCount,
      failedCount,
      skippedCount,
    };
  }

  private async deleteItem(
    item: ValidatedDeletionItem,
    normalizedQuarantineRoot: string,
    homeDir: string,
    dryRun: boolean,
  ): Promise<DeletionItem> {
    const base: DeletionItem = {
      actionId: item.actionId,
      quarantinePath: item.quarantinePath,
      status: 'failed',
    };

    if (!item.quarantinePath || typeof item.quarantinePath !== 'string') {
      return {
        ...base,
        error: 'Invalid quarantinePath in deletion item.',
      };
    }

    // 0. Action Type check
    if (item.actionType !== 'remove-file' && item.actionType !== 'remove-directory') {
      return {
        ...base,
        error: `Unsupported action type '${item.actionType}' for deletion.`,
      };
    }

    const normPath = path.normalize(path.resolve(item.quarantinePath));

    // 1. Boundary & Path Traversal Guards
    if (
      normPath === normalizedQuarantineRoot ||
      normalizedQuarantineRoot.startsWith(normPath + path.sep)
    ) {
      return {
        ...base,
        error: `Safety violation: Target '${normPath}' conflicts with quarantineRoot itself.`,
      };
    }

    if (!normPath.startsWith(normalizedQuarantineRoot + path.sep)) {
      return {
        ...base,
        error: `Safety violation: Target '${normPath}' escapes quarantineRoot '${normalizedQuarantineRoot}'.`,
      };
    }

    // 2. Protected Path Check
    const protectedError = this.checkProtectedPath(normPath, homeDir);
    if (protectedError) {
      return {
        ...base,
        error: protectedError,
      };
    }

    // 3. Inspect target via lstat
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(normPath);
    } catch (err: unknown) {
      return {
        ...base,
        error: `Target does not exist or is inaccessible: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Symlink safety guard: NEVER delete symlinks
    if (stat.isSymbolicLink()) {
      return {
        ...base,
        error: `Safety violation: Target '${normPath}' is a symbolic link. Symlinks cannot be deleted.`,
      };
    }

    // Type validation
    if (item.actionType === 'remove-file' && !stat.isFile()) {
      return {
        ...base,
        error: `Target '${normPath}' is not a regular file as expected by actionType '${item.actionType}'.`,
      };
    }

    if (item.actionType === 'remove-directory' && !stat.isDirectory()) {
      return {
        ...base,
        error: `Target '${normPath}' is not a directory as expected by actionType '${item.actionType}'.`,
      };
    }

    // 4. Mandatory Race-Safety / Last-Moment Integrity Check
    try {
      const currentHash = await hashPath(normPath);
      if (item.verifiedSha256 && currentHash !== item.verifiedSha256) {
        return {
          ...base,
          error: `Race-safety integrity check failed: Content was modified after verification. Expected hash '${item.verifiedSha256}' but found '${currentHash}'. Deletion aborted.`,
        };
      }
    } catch (err: unknown) {
      return {
        ...base,
        error: `Last-moment integrity check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 5. Dry-Run Handling
    if (dryRun) {
      return {
        ...base,
        status: 'skipped',
        error: 'Dry run: permanent deletion skipped.',
      };
    }

    // 6. Permanent Deletion Execution
    try {
      if (item.actionType === 'remove-file') {
        await fs.promises.unlink(normPath);
      } else if (item.actionType === 'remove-directory') {
        await fs.promises.rm(normPath, { recursive: true, force: true });
      } else {
        return {
          ...base,
          error: `Unsupported action type '${item.actionType}' for deletion.`,
        };
      }

      return {
        ...base,
        status: 'deleted',
      };
    } catch (err: unknown) {
      return {
        ...base,
        error: `Permanent deletion failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
