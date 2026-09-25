import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuarantineExecutor } from '../../src/cleanup/quarantine/QuarantineExecutor.js';
import { QuarantineVerifier } from '../../src/cleanup/quarantine/QuarantineVerifier.js';
import { DeletionGate } from '../../src/cleanup/deletion/DeletionGate.js';
import { DeletionExecutor } from '../../src/cleanup/deletion/DeletionExecutor.js';
import type { ApprovedExecutionPayload } from '../../src/types/approval.js';
import type { CleanupAction } from '../../src/types/cleanup.js';
import type { DeletionRequest } from '../../src/types/deletion.js';

describe('Permanent Deletion Lifecycle Integration Test', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let fixtureDir: string;
  let unrelatedFile: string;

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-del-lifecycle-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    fixtureDir = path.join(tempBaseDir, 'fixture');
    await fs.promises.mkdir(fixtureDir, { recursive: true });

    unrelatedFile = path.join(tempBaseDir, 'unrelated.txt');
    await fs.promises.writeFile(unrelatedFile, 'keep-this-unrelated-file', 'utf8');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('completes the full verified permanent deletion flow and rejects modified items', async () => {
    const quarExecutor = new QuarantineExecutor();
    const verifier = new QuarantineVerifier();
    const gate = new DeletionGate();
    const delExecutor = new DeletionExecutor();

    // 1. Create disposable fixture
    const targetFile = path.join(fixtureDir, 'disposable-cache.bin');
    await fs.promises.writeFile(targetFile, 'disposable-data-payload');

    // 2. Create approved cleanup action
    const actionId = 'act-del-lifecycle-1';
    const action: CleanupAction = {
      id: actionId,
      type: 'remove-file',
      target: targetFile,
      sourceFindingId: 'finding-del-1',
      title: 'Quarantine and delete disposable cache',
      reason: 'Stale cache file',
      risk: 'low',
      estimatedBytes: 23,
      reversible: true,
      requiresApproval: true,
      prerequisites: [],
      warnings: [],
    };

    const approvedPayload: ApprovedExecutionPayload = {
      planId: 'plan-del-lifecycle',
      approvedAt: '2026-09-25T12:00:00Z',
      approvedBy: 'lead-operator',
      approvedActions: [action],
    };

    // 3. Quarantine
    const manifest = await quarExecutor.execute(approvedPayload, {
      quarantineRoot: quarantineRootDir,
    });
    expect(manifest.successfulCount).toBe(1);
    expect(fs.existsSync(targetFile)).toBe(false);

    const quarItem = manifest.items[0];
    expect(fs.existsSync(quarItem.quarantinePath)).toBe(true);

    // 4. Verify
    const verifyReport = await verifier.verify(manifest, {
      quarantineRoot: quarantineRootDir,
    });
    expect(verifyReport.status).toBe('verified');
    expect(verifyReport.intactCount).toBe(1);

    // 5. Create explicit final deletion request
    const deletionRequest: DeletionRequest = {
      manifestId: manifest.manifestId,
      actionIds: [actionId],
      decision: 'approved',
      requestedAt: '2026-09-25T12:10:00Z',
      requestedBy: 'lead-operator',
    };

    // 6. Pass request through DeletionGate
    const validatedPayload = gate.evaluate(manifest, verifyReport, deletionRequest, {
      quarantineRoot: quarantineRootDir,
    });
    expect(validatedPayload.decision).toBe('approved');
    expect(validatedPayload.approvedActionIds).toEqual([actionId]);
    expect(validatedPayload.eligibleItems.length).toBe(1);

    // 7. Execute validated deletion
    const deletionReport = await delExecutor.execute(validatedPayload, {
      quarantineRoot: quarantineRootDir,
    });

    // 8. Confirm quarantine item no longer exists
    expect(fs.existsSync(quarItem.quarantinePath)).toBe(false);

    // 9. Confirm deletion report says deleted
    expect(deletionReport.deletedCount).toBe(1);
    expect(deletionReport.failedCount).toBe(0);
    expect(deletionReport.items[0].status).toBe('deleted');

    // 10. Confirm no unrelated file was affected
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(await fs.promises.readFile(unrelatedFile, 'utf8')).toBe('keep-this-unrelated-file');
  });

  // Mandatory: quarantine -> verify -> modify -> deletion request -> deletion MUST fail
  it('mandatory safety check: quarantine -> verify -> modify -> deletion request -> deletion MUST fail', async () => {
    const quarExecutor = new QuarantineExecutor();
    const verifier = new QuarantineVerifier();
    const gate = new DeletionGate();
    const delExecutor = new DeletionExecutor();

    // 1. Create disposable file
    const targetFile = path.join(fixtureDir, 'tamper-target.bin');
    await fs.promises.writeFile(targetFile, 'initial-unmodified-content');

    const actionId = 'act-tamper-test';
    const action: CleanupAction = {
      id: actionId,
      type: 'remove-file',
      target: targetFile,
      sourceFindingId: 'finding-tamper-1',
      title: 'Quarantine and test tamper guard',
      reason: 'Tamper guard verification',
      risk: 'low',
      reversible: true,
      requiresApproval: true,
      prerequisites: [],
      warnings: [],
    };

    // 2. Quarantine
    const manifest = await quarExecutor.execute(
      {
        planId: 'plan-tamper',
        approvedAt: '2026-09-25T12:00:00Z',
        approvedBy: 'lead-operator',
        approvedActions: [action],
      },
      { quarantineRoot: quarantineRootDir },
    );
    const quarPath = manifest.items[0].quarantinePath;

    // 3. Verify
    const verifyReport = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(verifyReport.status).toBe('verified');

    // 4. Modify quarantined file AFTER verification
    await fs.promises.writeFile(quarPath, 'tampered-after-verification');

    // 5. Deletion request
    const deletionRequest: DeletionRequest = {
      manifestId: manifest.manifestId,
      actionIds: [actionId],
      decision: 'approved',
      requestedAt: '2026-09-25T12:15:00Z',
    };

    // If gate is evaluated before re-verifying, gate might approve based on stale report,
    // BUT DeletionExecutor's last-moment integrity check MUST abort and fail!
    const validatedPayload = gate.evaluate(manifest, verifyReport, deletionRequest, {
      quarantineRoot: quarantineRootDir,
    });

    const deletionReport = await delExecutor.execute(validatedPayload, {
      quarantineRoot: quarantineRootDir,
    });

    // Deletion MUST fail!
    expect(deletionReport.deletedCount).toBe(0);
    expect(deletionReport.failedCount).toBe(1);
    expect(deletionReport.items[0].status).toBe('failed');
    expect(deletionReport.items[0].error).toContain('Race-safety integrity check failed');

    // Quarantine file MUST still exist (not deleted!)
    expect(fs.existsSync(quarPath)).toBe(true);
    expect(await fs.promises.readFile(quarPath, 'utf8')).toBe('tampered-after-verification');
  });
});
