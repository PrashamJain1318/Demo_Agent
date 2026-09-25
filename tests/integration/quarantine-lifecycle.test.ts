import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuarantineExecutor } from '../../src/cleanup/quarantine/QuarantineExecutor.js';
import { QuarantineVerifier } from '../../src/cleanup/quarantine/QuarantineVerifier.js';
import { QuarantineRestorer } from '../../src/cleanup/quarantine/QuarantineRestorer.js';
import type { ApprovedExecutionPayload } from '../../src/types/approval.js';
import type { CleanupAction } from '../../src/types/cleanup.js';

describe('Quarantine Lifecycle Integration Test', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let fixtureDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-quar-integration-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    fixtureDir = path.join(tempBaseDir, 'fixture');
    cacheDir = path.join(fixtureDir, 'cache');

    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(path.join(cacheDir, 'a.txt'), 'file-a-initial');
    await fs.promises.writeFile(path.join(cacheDir, 'b.txt'), 'file-b-initial');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('verifies full quarantine, verification, tampering detection, and restore lifecycle', async () => {
    const executor = new QuarantineExecutor();
    const verifier = new QuarantineVerifier();
    const restorer = new QuarantineRestorer();

    // 1. Create an approved cleanup action
    const actionId = 'action-cache-dir';
    const action: CleanupAction = {
      id: actionId,
      type: 'remove-directory',
      target: cacheDir,
      sourceFindingId: 'finding-cache-1',
      title: 'Quarantine build cache directory',
      reason: 'Stale build cache',
      risk: 'low',
      estimatedBytes: 24,
      reversible: true,
      requiresApproval: true,
      prerequisites: [],
      warnings: [],
    };

    const payload: ApprovedExecutionPayload = {
      planId: 'integration-plan-1',
      approvedAt: '2026-09-25T12:00:00Z',
      approvedBy: 'integration-safety-officer',
      approvedActions: [action],
    };

    // 2. Quarantine the directory & 3. Generate QuarantineManifest
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(manifest.successfulCount).toBe(1);
    expect(manifest.items.length).toBe(1);
    expect(fs.existsSync(cacheDir)).toBe(false);

    const quarantinedItem = manifest.items[0];
    expect(quarantinedItem.status).toBe('quarantined');
    expect(quarantinedItem.originalSha256).toBeTruthy();
    expect(fs.existsSync(quarantinedItem.quarantinePath)).toBe(true);

    // 4. Verify quarantine
    const initialReport = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(initialReport.status).toBe('verified');
    expect(initialReport.intactCount).toBe(1);
    expect(initialReport.items[0].status).toBe('intact');

    // 5. Modify the quarantined content
    const tamperedFile = path.join(quarantinedItem.quarantinePath, 'a.txt');
    await fs.promises.writeFile(tamperedFile, 'file-a-tampered');

    // 6. Verifier detects modification
    const tamperedReport = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(tamperedReport.status).toBe('issues-found');
    expect(tamperedReport.modifiedCount).toBe(1);
    expect(tamperedReport.items[0].status).toBe('modified');

    // Restore original content to simulate restoring unmodified or repairing
    await fs.promises.writeFile(tamperedFile, 'file-a-initial');
    const repairedReport = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(repairedReport.status).toBe('verified');

    // 7. Restore the item
    const restoreReport = await restorer.restore(manifest, [actionId], {
      quarantineRoot: quarantineRootDir,
    });
    expect(restoreReport.restoredCount).toBe(1);
    expect(restoreReport.failedCount).toBe(0);

    // 8. Confirm original structure exists again
    expect(fs.existsSync(cacheDir)).toBe(true);
    expect(await fs.promises.readFile(path.join(cacheDir, 'a.txt'), 'utf8')).toBe('file-a-initial');
    expect(await fs.promises.readFile(path.join(cacheDir, 'b.txt'), 'utf8')).toBe('file-b-initial');

    // 9. Confirm quarantine path is now empty/relocated
    expect(fs.existsSync(quarantinedItem.quarantinePath)).toBe(false);
  });
});
