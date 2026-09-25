import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApprovedExecutionPayload } from '../../types/approval.js';
import type { CleanupAction } from '../../types/cleanup.js';
import type {
  QuarantineExecutorOptions,
  QuarantineItem,
  QuarantineManifest,
} from '../../types/quarantine.js';

export const QUARANTINE_EXECUTOR_VERSION = '1.0.0';

/**
 * Dedicated QuarantineExecutor for Digital Janitor.
 *
 * SAFETY INVARIANTS:
 * - UNAPPROVED ACTION -> NO QUARANTINE -> NO FILESYSTEM MUTATION
 * - QUARANTINE != DELETE (permanent deletion is strictly forbidden in this step)
 * - Consumes ONLY ApprovedExecutionPayload, NEVER CleanupPlan directly.
 * - Zero Docker mutation, zero shell execution, zero child processes.
 * - Zero deletion, zero permanent removal, zero file destruction.
 */
export class QuarantineExecutor {
  async execute(
    payload: ApprovedExecutionPayload,
    options: QuarantineExecutorOptions,
  ): Promise<QuarantineManifest> {
    // 1. Boundary Enforcement: Payload validation
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid payload: ApprovedExecutionPayload is required.');
    }

    if (
      'findingsAnalyzed' in payload ||
      'totalEstimatedBytes' in payload ||
      !('approvedActions' in payload)
    ) {
      throw new Error(
        'Execution boundary violated: QuarantineExecutor cannot consume CleanupPlan directly. It must receive an ApprovedExecutionPayload from ApprovalGate.',
      );
    }

    if (!Array.isArray(payload.approvedActions)) {
      throw new Error('Invalid payload: approvedActions must be an array.');
    }

    // 2. Quarantine Root Validation
    if (!options?.quarantineRoot || typeof options.quarantineRoot !== 'string') {
      throw new Error('Invalid quarantine root: quarantineRoot must be a non-empty string path.');
    }

    const normalizedQuarantineRoot = path.normalize(path.resolve(options.quarantineRoot));

    // Reject filesystem root as quarantine root
    if (
      normalizedQuarantineRoot === '/' ||
      normalizedQuarantineRoot === path.parse(normalizedQuarantineRoot).root
    ) {
      throw new Error('Safety violation: Filesystem root cannot be used as quarantine root.');
    }

    // Reject user home directory as quarantine root
    const homeDir = path.normalize(os.homedir());
    if (normalizedQuarantineRoot === homeDir) {
      throw new Error('Safety violation: User home directory cannot be used as quarantine root.');
    }

    const createdAt = options.now ?? new Date().toISOString();
    const dryRun = options.dryRun ?? false;

    // 3. Deduplicate actions by actionId and sort deterministically
    const seenActionIds = new Set<string>();
    const uniqueApprovedActions: CleanupAction[] = [];
    for (const action of payload.approvedActions) {
      if (!action || !action.id) continue;
      if (seenActionIds.has(action.id)) continue;
      seenActionIds.add(action.id);
      uniqueApprovedActions.push(action);
    }
    uniqueApprovedActions.sort((a, b) => a.id.localeCompare(b.id));

    // 4. Derive deterministic manifest ID (independent of createdAt timestamp)
    const hashInput = [
      normalizedQuarantineRoot,
      ...uniqueApprovedActions.map((a) => `${a.id}:${a.type}:${a.target}`),
    ].join('|');
    const manifestHash = createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
    const manifestId = `quarantine-${manifestHash}`;

    const items: QuarantineItem[] = [];

    // 5. Process each approved action independently
    for (const action of uniqueApprovedActions) {
      const item = await this.processAction(
        action,
        manifestId,
        normalizedQuarantineRoot,
        homeDir,
        dryRun,
      );
      items.push(item);
    }

    const successfulCount = items.filter((i) => i.status === 'quarantined').length;
    const failedCount = items.filter((i) => i.status === 'failed').length;
    const skippedCount = items.filter((i) => i.status === 'skipped').length;

    return {
      manifestId,
      createdAt,
      items,
      successfulCount,
      failedCount,
      skippedCount,
    };
  }

  private async processAction(
    action: CleanupAction,
    manifestId: string,
    normalizedQuarantineRoot: string,
    homeDir: string,
    dryRun: boolean,
  ): Promise<QuarantineItem> {
    // 5.1 Docker Action Safety Rejection
    if (
      action.type.startsWith('docker-') ||
      (action.type !== 'remove-file' && action.type !== 'remove-directory')
    ) {
      return {
        actionId: action.id,
        sourcePath: action.target,
        quarantinePath: '',
        actionType: action.type,
        status: 'skipped',
        error: `Docker or unsupported action type '${action.type}' cannot be quarantined. QuarantineExecutor only handles filesystem actions.`,
      };
    }

    // 5.2 Source Path Validation
    if (!action.target || typeof action.target !== 'string') {
      return {
        actionId: action.id,
        sourcePath: action.target ?? '',
        quarantinePath: '',
        actionType: action.type,
        status: 'failed',
        error: 'Invalid action target: source path must be a non-empty string.',
      };
    }

    const normalizedSource = path.normalize(path.resolve(action.target));

    // 5.3 Quarantine Root Self-Protection Check
    if (
      normalizedSource === normalizedQuarantineRoot ||
      normalizedSource.startsWith(normalizedQuarantineRoot + path.sep) ||
      normalizedQuarantineRoot.startsWith(normalizedSource + path.sep)
    ) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: '',
        actionType: action.type,
        status: 'failed',
        error: `Safety violation: Source path '${normalizedSource}' conflicts with quarantineRoot '${normalizedQuarantineRoot}'.`,
      };
    }

    // 5.4 Protected System & Root Paths
    const protectionError = this.checkProtectedPath(normalizedSource, homeDir);
    if (protectionError) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: '',
        actionType: action.type,
        status: 'failed',
        error: protectionError,
      };
    }

    // 5.5 Quarantine Destination Construction & Path Traversal Guard
    const baseName = path.basename(normalizedSource);
    if (!baseName || baseName === '.' || baseName === '..') {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: '',
        actionType: action.type,
        status: 'failed',
        error: `Invalid basename '${baseName}' for source path '${normalizedSource}'.`,
      };
    }

    // Sanitize action.id to prevent path traversal in quarantine path
    if (
      action.id.includes('..') ||
      action.id.includes('/') ||
      action.id.includes('\\') ||
      action.id.includes('\0')
    ) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: '',
        actionType: action.type,
        status: 'failed',
        error: `Action ID '${action.id}' contains illegal path characters.`,
      };
    }

    const quarantineItemDir = path.join(normalizedQuarantineRoot, manifestId, 'items', action.id);
    const quarantinePath = path.join(quarantineItemDir, baseName);
    const normalizedDest = path.normalize(path.resolve(quarantinePath));

    if (!normalizedDest.startsWith(normalizedQuarantineRoot + path.sep)) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'failed',
        error: `Safety violation: Quarantine destination '${normalizedDest}' escapes quarantineRoot '${normalizedQuarantineRoot}'.`,
      };
    }

    // 5.6 Source Inspection via lstat
    let sourceStat: fs.Stats;
    try {
      sourceStat = await fs.promises.lstat(normalizedSource);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'failed',
        error: `Source path does not exist or cannot be accessed: ${errorMsg}`,
      };
    }

    // 5.7 Symlink Safety Guard (do not follow or move symlink targets)
    if (sourceStat.isSymbolicLink()) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'skipped',
        error: `Source path '${normalizedSource}' is a symbolic link. Symlinks are not followed for quarantine safety.`,
      };
    }

    // 5.8 Destination Collision Check
    try {
      await fs.promises.lstat(normalizedDest);
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'failed',
        error: `Quarantine destination already exists: '${normalizedDest}'. Overwrite is strictly forbidden.`,
      };
    } catch {
      // Expected: destination does not exist
    }

    // 5.9 Dry-Run Enforcement
    if (dryRun) {
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'skipped',
        originalSizeBytes:
          action.estimatedBytes ?? (sourceStat.isFile() ? sourceStat.size : undefined),
        error: 'Dry run: filesystem mutation skipped.',
      };
    }

    // 5.10 Safe Move Operation
    try {
      await fs.promises.mkdir(quarantineItemDir, { recursive: true });
      await fs.promises.rename(normalizedSource, normalizedDest);

      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'quarantined',
        originalSizeBytes:
          action.estimatedBytes ?? (sourceStat.isFile() ? sourceStat.size : undefined),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        actionId: action.id,
        sourcePath: normalizedSource,
        quarantinePath: normalizedDest,
        actionType: action.type,
        status: 'failed',
        error: `Filesystem quarantine move failed: ${errorMsg}`,
      };
    }
  }

  private checkProtectedPath(sourcePath: string, homeDir: string): string | null {
    // Root directory check
    if (sourcePath === '/' || sourcePath === path.parse(sourcePath).root) {
      return `Protected path: Root directory '${sourcePath}' cannot be quarantined.`;
    }

    // User home directory check
    if (sourcePath === homeDir) {
      return `Protected path: User home directory '${sourcePath}' cannot be quarantined.`;
    }

    // Standard user directories directly under home
    const userProtectedDirs = ['desktop', 'documents', 'downloads', 'library'];
    const relativeToHome = path.relative(homeDir, sourcePath);
    if (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
      const parts = relativeToHome.split(path.sep);
      if (parts.length === 1 && userProtectedDirs.includes(parts[0].toLowerCase())) {
        return `Protected path: User '${parts[0]}' folder cannot be quarantined.`;
      }
    }

    // System roots (exclude os.tmpdir so test and disposable fixtures can operate)
    const tmpDir = path.normalize(os.tmpdir());
    const isInsideTmp = sourcePath === tmpDir || sourcePath.startsWith(tmpDir + path.sep);

    if (!isInsideTmp) {
      const systemRoots = ['/bin', '/sbin', '/usr', '/etc', '/System', '/Library', '/opt'];
      for (const sysRoot of systemRoots) {
        if (sourcePath === sysRoot || sourcePath.startsWith(sysRoot + path.sep)) {
          return `Protected path: System path '${sourcePath}' cannot be quarantined.`;
        }
      }
      if (
        sourcePath === '/var' ||
        (sourcePath.startsWith('/var' + path.sep) &&
          !sourcePath.startsWith('/var/folders' + path.sep))
      ) {
        return `Protected path: System path '${sourcePath}' cannot be quarantined.`;
      }
    }

    // Git metadata
    const base = path.basename(sourcePath);
    if (base === '.git' || sourcePath.endsWith(path.sep + '.git')) {
      return `Protected path: Git repository metadata '${sourcePath}' cannot be quarantined.`;
    }

    // node_modules root itself (subdirectories like node_modules/.vite are allowed)
    if (base === 'node_modules') {
      return `Protected path: The root 'node_modules' directory cannot be quarantined as a whole.`;
    }

    return null;
  }
}
