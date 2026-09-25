import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuarantineExecutor } from '../../src/cleanup/quarantine/QuarantineExecutor.js';
import { ApprovalGate } from '../../src/cleanup/approval/ApprovalGate.js';
import type { ApprovedExecutionPayload } from '../../src/types/approval.js';
import type { CleanupAction, CleanupPlan } from '../../src/types/cleanup.js';

describe('QuarantineExecutor Unit Tests', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let workDir: string;
  let executor: QuarantineExecutor;
  let gate: ApprovalGate;

  beforeEach(async () => {
    // Isolated temporary directory for test fixtures
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-quarantine-test-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    workDir = path.join(tempBaseDir, 'workdir');
    await fs.promises.mkdir(workDir, { recursive: true });

    executor = new QuarantineExecutor();
    gate = new ApprovalGate();
  });

  afterEach(async () => {
    // Clean up temporary test files
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createAction(overrides?: Partial<CleanupAction>): CleanupAction {
    return {
      id: 'action-test-1',
      type: 'remove-file',
      target: path.join(workDir, 'test-target.txt'),
      sourceFindingId: 'finding-1',
      title: 'Remove test file',
      reason: 'Stale test artifact',
      risk: 'low',
      estimatedBytes: 100,
      reversible: true,
      requiresApproval: true,
      prerequisites: [],
      warnings: [],
      ...overrides,
    };
  }

  function createPayload(actions: CleanupAction[]): ApprovedExecutionPayload {
    return {
      planId: 'plan-123',
      approvedAt: '2026-09-25T12:00:00.000Z',
      approvedBy: 'security-operator',
      approvedActions: actions,
    };
  }

  // 1. approved file is moved into quarantine
  it('1. approved file is moved into quarantine', async () => {
    const filePath = path.join(workDir, 'stale-cache.json');
    await fs.promises.writeFile(filePath, 'cache-content');

    const action = createAction({ id: 'act-file-1', type: 'remove-file', target: filePath });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(1);
    expect(manifest.failedCount).toBe(0);
    expect(manifest.skippedCount).toBe(0);

    const item = manifest.items[0];
    expect(item.status).toBe('quarantined');
    expect(item.sourcePath).toBe(filePath);

    // Verify source no longer exists
    expect(fs.existsSync(filePath)).toBe(false);
    // Verify file exists in quarantine destination
    expect(fs.existsSync(item.quarantinePath)).toBe(true);
    expect(await fs.promises.readFile(item.quarantinePath, 'utf8')).toBe('cache-content');
  });

  // 2. approved directory is moved into quarantine
  it('2. approved directory is moved into quarantine', async () => {
    const dirPath = path.join(workDir, 'cache-folder');
    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.writeFile(path.join(dirPath, 'data.bin'), 'binary-data');

    const action = createAction({ id: 'act-dir-1', type: 'remove-directory', target: dirPath });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(1);
    const item = manifest.items[0];
    expect(item.status).toBe('quarantined');

    // Verify source directory no longer exists
    expect(fs.existsSync(dirPath)).toBe(false);
    // Verify directory exists in quarantine destination
    expect(fs.existsSync(item.quarantinePath)).toBe(true);
    expect(fs.existsSync(path.join(item.quarantinePath, 'data.bin'))).toBe(true);
  });

  // 3. unapproved action cannot be moved
  it('3. unapproved action cannot be moved', async () => {
    const approvedFile = path.join(workDir, 'approved.txt');
    const unapprovedFile = path.join(workDir, 'unapproved.txt');
    await fs.promises.writeFile(approvedFile, 'approved');
    await fs.promises.writeFile(unapprovedFile, 'unapproved');

    const actionA = createAction({ id: 'action-A', target: approvedFile });
    const actionB = createAction({ id: 'action-B', target: unapprovedFile });

    const plan: CleanupPlan = {
      id: 'plan-1',
      createdAt: '2026-09-25T12:00:00.000Z',
      findingsAnalyzed: 2,
      actions: [actionA, actionB],
      totalEstimatedBytes: 200,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    // Operator approves only action-A
    const approvalResult = gate.evaluate(plan, {
      planId: 'plan-1',
      actionIds: ['action-A'],
      decision: 'approved',
      requestedAt: '2026-09-25T12:01:00.000Z',
    });

    const payload = gate.createExecutionPayload(plan, approvalResult);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(1);
    expect(fs.existsSync(approvedFile)).toBe(false);
    // Unapproved file was NOT quarantined
    expect(fs.existsSync(unapprovedFile)).toBe(true);
  });

  // 4. unknown action cannot be moved
  it('4. unknown action cannot be moved', async () => {
    const file = path.join(workDir, 'file.txt');
    await fs.promises.writeFile(file, 'hello');

    const plan: CleanupPlan = {
      id: 'plan-1',
      createdAt: '2026-09-25T12:00:00.000Z',
      findingsAnalyzed: 0,
      actions: [],
      totalEstimatedBytes: 0,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    // Requesting unknown action ID
    const approvalResult = gate.evaluate(plan, {
      planId: 'plan-1',
      actionIds: ['action-unknown'],
      decision: 'approved',
      requestedAt: '2026-09-25T12:01:00.000Z',
    });

    expect(approvalResult.approvedActionIds).toEqual([]);
    expect(() => gate.createExecutionPayload(plan, approvalResult)).toThrow();
  });

  // 5. Docker action is skipped/rejected
  it('5. Docker action is skipped/rejected', async () => {
    const dockerAction = createAction({
      id: 'docker-act-1',
      type: 'docker-remove-container',
      target: 'container-id-12345',
    });

    const payload = createPayload([dockerAction]);
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(0);
    expect(manifest.skippedCount).toBe(1);
    expect(manifest.items[0].status).toBe('skipped');
    expect(manifest.items[0].error).toContain('Docker or unsupported action type');
  });

  // 6. dry-run performs no filesystem mutation
  it('6. dry-run performs no filesystem mutation', async () => {
    const file = path.join(workDir, 'keep-me.txt');
    await fs.promises.writeFile(file, 'original-data');

    const action = createAction({ id: 'act-dry', target: file });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
    });

    expect(manifest.successfulCount).toBe(0);
    expect(manifest.skippedCount).toBe(1);
    expect(manifest.items[0].status).toBe('skipped');
    expect(manifest.items[0].error).toContain('Dry run');

    // Original file must still exist
    expect(fs.existsSync(file)).toBe(true);
  });

  // 7. dry-run does not create quarantine directory
  it('7. dry-run does not create quarantine directory', async () => {
    const file = path.join(workDir, 'dry-test.txt');
    await fs.promises.writeFile(file, 'some-data');

    const action = createAction({ id: 'act-dry-dir', target: file });
    const payload = createPayload([action]);

    await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
    });

    // Quarantine root should not have been created by dry run
    expect(fs.existsSync(quarantineRootDir)).toBe(false);
  });

  // 8. source does not exist
  it('8. source does not exist is marked failed in manifest', async () => {
    const nonexistent = path.join(workDir, 'does-not-exist.txt');
    const action = createAction({ id: 'act-nonexistent', target: nonexistent });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.failedCount).toBe(1);
    expect(manifest.items[0].status).toBe('failed');
    expect(manifest.items[0].error).toContain('Source path does not exist');
  });

  // 9. source is a symlink
  it('9. source is a symlink is safely rejected/skipped', async () => {
    const realFile = path.join(workDir, 'real-target.txt');
    const symlinkPath = path.join(workDir, 'symlink-file.txt');
    await fs.promises.writeFile(realFile, 'real-file-content');
    await fs.promises.symlink(realFile, symlinkPath);

    const action = createAction({ id: 'act-symlink', target: symlinkPath });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(0);
    expect(['skipped', 'failed']).toContain(manifest.items[0].status);
    expect(manifest.items[0].error).toContain('symbolic link');

    // Neither the symlink nor the target should have been moved
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.existsSync(realFile)).toBe(true);
  });

  // 10. destination collision does not overwrite
  it('10. destination collision does not overwrite', async () => {
    const file = path.join(workDir, 'collide.txt');
    await fs.promises.writeFile(file, 'new-version');

    const action = createAction({ id: 'act-collision', target: file });
    const payload = createPayload([action]);

    // Pre-create the collision destination
    const options = { quarantineRoot: quarantineRootDir };
    // Determine manifestId
    const firstRun = await executor.execute(payload, options);
    expect(firstRun.successfulCount).toBe(1);

    // Re-create the source file with same name
    await fs.promises.writeFile(file, 'different-version');

    // Run again - collision at destination
    const secondRun = await executor.execute(payload, options);
    expect(secondRun.failedCount).toBe(1);
    expect(secondRun.items[0].status).toBe('failed');
    expect(secondRun.items[0].error).toContain('already exists');

    // Source must not have been removed
    expect(fs.existsSync(file)).toBe(true);
  });

  // 11. quarantine destination remains inside quarantineRoot
  it('11. quarantine destination remains inside quarantineRoot', async () => {
    const file = path.join(workDir, 'target.txt');
    await fs.promises.writeFile(file, 'test');

    const action = createAction({ id: 'act-inside', target: file });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    const item = manifest.items[0];

    const normalizedDest = path.normalize(item.quarantinePath);
    const normalizedRoot = path.normalize(quarantineRootDir);
    expect(normalizedDest.startsWith(normalizedRoot + path.sep)).toBe(true);
  });

  // 12. source protected path is rejected
  it('12. source protected path is rejected', async () => {
    const protectedActions = [
      createAction({ id: 'p-root', target: '/' }),
      createAction({ id: 'p-home', target: os.homedir() }),
      createAction({ id: 'p-desktop', target: path.join(os.homedir(), 'Desktop') }),
      createAction({ id: 'p-git', target: path.join(workDir, '.git') }),
      createAction({ id: 'p-node_modules', target: path.join(workDir, 'node_modules') }),
      createAction({ id: 'p-etc', target: '/etc' }),
    ];

    const payload = createPayload(protectedActions);
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(0);
    expect(manifest.failedCount).toBe(protectedActions.length);
    for (const item of manifest.items) {
      expect(item.status).toBe('failed');
      expect(item.error).toContain('Protected path');
    }
  });

  // 13. quarantineRoot itself cannot be quarantined
  it('13. quarantineRoot itself cannot be quarantined', async () => {
    const action = createAction({ id: 'act-self', target: quarantineRootDir });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.failedCount).toBe(1);
    expect(manifest.items[0].status).toBe('failed');
    expect(manifest.items[0].error).toContain('conflicts with quarantineRoot');
  });

  // 14. path traversal is rejected
  it('14. path traversal in action ID or target is rejected', async () => {
    const file = path.join(workDir, 'traversal.txt');
    await fs.promises.writeFile(file, 'data');

    const action = createAction({ id: '../../escape', target: file });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.failedCount).toBe(1);
    expect(manifest.items[0].status).toBe('failed');
    expect(manifest.items[0].error).toContain('illegal path characters');
    expect(fs.existsSync(file)).toBe(true);
  });

  // 15. independent failure does not corrupt successful actions
  it('15. independent failure does not corrupt successful actions', async () => {
    const goodFile = path.join(workDir, 'good.txt');
    const missingFile = path.join(workDir, 'missing.txt');
    await fs.promises.writeFile(goodFile, 'good-data');

    const actionGood = createAction({ id: 'act-good', target: goodFile });
    const actionBad = createAction({ id: 'act-bad', target: missingFile });

    const payload = createPayload([actionGood, actionBad]);
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(1);
    expect(manifest.failedCount).toBe(1);

    const goodItem = manifest.items.find((i) => i.actionId === 'act-good')!;
    const badItem = manifest.items.find((i) => i.actionId === 'act-bad')!;

    expect(goodItem.status).toBe('quarantined');
    expect(badItem.status).toBe('failed');

    expect(fs.existsSync(goodFile)).toBe(false);
    expect(fs.existsSync(goodItem.quarantinePath)).toBe(true);
  });

  // 16. failed move is reported correctly
  it('16. failed move is reported correctly with error details', async () => {
    const nonExistent = path.join(workDir, 'unreal.txt');
    const action = createAction({ id: 'act-fail', target: nonExistent });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.failedCount).toBe(1);
    expect(manifest.items[0].error).toBeTruthy();
    expect(typeof manifest.items[0].error).toBe('string');
  });

  // 17. manifest records successful move
  it('17. manifest records successful move and item counts accurately', async () => {
    const file = path.join(workDir, 'record-test.txt');
    await fs.promises.writeFile(file, 'content');

    const action = createAction({ id: 'act-rec', target: file });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.manifestId).toMatch(/^quarantine-[0-9a-f]{16}$/);
    expect(manifest.successfulCount).toBe(1);
    expect(manifest.failedCount).toBe(0);
    expect(manifest.skippedCount).toBe(0);
    expect(manifest.items.length).toBe(1);
    expect(manifest.items[0].status).toBe('quarantined');
  });

  // 18. manifest records failure
  it('18. manifest records failure details and counts accurately', async () => {
    const action = createAction({ id: 'act-fail-rec', target: '/nonexistent/fake/path' });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(0);
    expect(manifest.failedCount).toBe(1);
    expect(manifest.items[0].status).toBe('failed');
    expect(manifest.items[0].error).toBeTruthy();
  });

  // 19. manifest IDs are deterministic
  it('19. manifest IDs are deterministic for identical actions and quarantineRoot', async () => {
    const action1 = createAction({ id: 'act-1', target: '/path/one' });
    const action2 = createAction({ id: 'act-2', target: '/path/two' });

    const payload = createPayload([action1, action2]);

    const run1 = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
      now: '2026-09-25T10:00:00Z',
    });
    const run2 = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
      now: '2026-09-25T11:00:00Z',
    });

    expect(run1.manifestId).toBe(run2.manifestId);
  });

  // 20. createdAt does not change manifest identity
  it('20. createdAt does not change manifest identity', async () => {
    const action = createAction({ id: 'act-stamp', target: '/path/fixed' });
    const payload = createPayload([action]);

    const runA = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
      now: '1970-01-01T00:00:00.000Z',
    });
    const runB = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
      now: '2099-12-31T23:59:59.999Z',
    });

    expect(runA.manifestId).toBe(runB.manifestId);
    expect(runA.createdAt).not.toBe(runB.createdAt);
  });

  // 21. duplicate action IDs handled safely
  it('21. duplicate action IDs handled safely without duplicate execution', async () => {
    const file = path.join(workDir, 'duplicate.txt');
    await fs.promises.writeFile(file, 'dup-content');

    const action1 = createAction({ id: 'act-dup', target: file });
    const action2 = createAction({ id: 'act-dup', target: file });

    const payload = createPayload([action1, action2]);
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    // Deduplicated to 1 action execution
    expect(manifest.items.length).toBe(1);
    expect(manifest.successfulCount).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  // 22. executor cannot consume CleanupPlan directly
  it('22. executor cannot consume CleanupPlan directly', async () => {
    const rawPlan: CleanupPlan = {
      id: 'plan-xyz',
      createdAt: '2026-09-25T00:00:00Z',
      findingsAnalyzed: 5,
      actions: [createAction()],
      totalEstimatedBytes: 500,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    await expect(
      executor.execute(rawPlan as unknown as ApprovedExecutionPayload, {
        quarantineRoot: quarantineRootDir,
      }),
    ).rejects.toThrowError(/Execution boundary violated/);
  });

  // 23. no fs.rm usage
  it('23. no fs.rm usage in QuarantineExecutor source', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('fs.rm');
    expect(source).not.toContain('rm(');
    expect(source).not.toContain('rmdir');
  });

  // 24. no fs.unlink usage
  it('24. no fs.unlink usage in QuarantineExecutor source', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('unlink');
    expect(source).not.toContain('fs.unlink');
  });

  // 25. no child_process
  it('25. no child_process in QuarantineExecutor source', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('child_process');
  });

  // 26. no shell execution
  it('26. no shell execution in QuarantineExecutor source', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('exec(');
    expect(source).not.toContain('execFile(');
    expect(source).not.toContain('spawn(');
  });

  // 27. no DockerClient
  it('27. no DockerClient in QuarantineExecutor source', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('DockerClient');
    expect(source).not.toContain('docker rmi');
    expect(source).not.toContain('docker rm');
  });

  // 28. no permanent deletion
  it('28. no permanent deletion methods or calls exist in QuarantineExecutor', () => {
    const source = fs.readFileSync('src/cleanup/quarantine/QuarantineExecutor.ts', 'utf8');
    expect(source).not.toContain('delete(');
    expect(source).not.toContain('remove(');
    expect(source).not.toContain('purge(');
    expect(source).not.toContain('cleanupPermanent');
  });

  // 29. quarantine operation preserves source basename
  it('29. quarantine operation preserves source basename', async () => {
    const file = path.join(workDir, 'my-exact-name.cache');
    await fs.promises.writeFile(file, 'data');

    const action = createAction({ id: 'act-base', target: file });
    const payload = createPayload([action]);

    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    const item = manifest.items[0];

    expect(path.basename(item.quarantinePath)).toBe('my-exact-name.cache');
  });

  // 30. multiple same-basename sources do not collide
  it('30. multiple same-basename sources do not collide in quarantine vault', async () => {
    const dirA = path.join(workDir, 'dir-a');
    const dirB = path.join(workDir, 'dir-b');
    await fs.promises.mkdir(dirA, { recursive: true });
    await fs.promises.mkdir(dirB, { recursive: true });

    const fileA = path.join(dirA, 'common.log');
    const fileB = path.join(dirB, 'common.log');
    await fs.promises.writeFile(fileA, 'log-a');
    await fs.promises.writeFile(fileB, 'log-b');

    const actionA = createAction({ id: 'act-common-a', target: fileA });
    const actionB = createAction({ id: 'act-common-b', target: fileB });

    const payload = createPayload([actionA, actionB]);
    const manifest = await executor.execute(payload, { quarantineRoot: quarantineRootDir });

    expect(manifest.successfulCount).toBe(2);
    expect(manifest.failedCount).toBe(0);

    const itemA = manifest.items.find((i) => i.actionId === 'act-common-a')!;
    const itemB = manifest.items.find((i) => i.actionId === 'act-common-b')!;

    expect(itemA.quarantinePath).not.toBe(itemB.quarantinePath);
    expect(path.basename(itemA.quarantinePath)).toBe('common.log');
    expect(path.basename(itemB.quarantinePath)).toBe('common.log');

    expect(await fs.promises.readFile(itemA.quarantinePath, 'utf8')).toBe('log-a');
    expect(await fs.promises.readFile(itemB.quarantinePath, 'utf8')).toBe('log-b');
  });
});
