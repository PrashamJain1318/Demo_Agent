import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeletionExecutor } from '../../src/cleanup/deletion/DeletionExecutor.js';
import type { ValidatedDeletionPayload } from '../../src/types/deletion.js';
import { hashDirectory, hashFile } from '../../src/utils/hash.js';

describe('DeletionExecutor Unit Tests', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let executor: DeletionExecutor;

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-del-executor-test-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    await fs.promises.mkdir(quarantineRootDir, { recursive: true });
    executor = new DeletionExecutor();
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createPayload(overrides?: Partial<ValidatedDeletionPayload>): ValidatedDeletionPayload {
    return {
      manifestId: 'manifest-del-exec',
      decision: 'approved',
      approvedActionIds: ['act-1'],
      rejectedActionIds: [],
      eligibleItems: [],
      rejectionReasons: {},
      validatedAt: '2026-09-25T12:00:00Z',
      ...overrides,
    };
  }

  // 1. approved file is permanently deleted
  it('1. approved file is permanently deleted', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'delete-me-file');
    const hash = await hashFile(file);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-file',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: hash,
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.deletedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  // 2. approved directory is permanently deleted
  it('2. approved directory is permanently deleted', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'sub.txt'), 'sub-content');
    const hash = await hashDirectory(dir);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-dir',
          quarantinePath: dir,
          originalPath: '/src/cache-dir',
          actionType: 'remove-directory',
          verifiedSha256: hash,
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.deletedCount).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  // 3. unapproved item cannot be deleted
  it('3. unapproved item cannot be deleted (rejected payload rejected)', async () => {
    const payload = createPayload({
      decision: 'rejected',
      eligibleItems: [],
    });

    await expect(
      executor.execute(payload, { quarantineRoot: quarantineRootDir }),
    ).rejects.toThrowError(/Execution boundary violated/);
  });

  // 4. modified item cannot be deleted
  it('4. modified item cannot be deleted (hash mismatch immediately before deletion)', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'initial-content');
    const originalHash = await hashFile(file);

    // Tamper with file
    await fs.promises.writeFile(file, 'tampered-content');

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-tampered',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: originalHash,
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.deletedCount).toBe(0);
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('Race-safety integrity check failed');
    // Tampered file remains untouched
    expect(fs.existsSync(file)).toBe(true);
  });

  // 5. missing item handled safely
  it('5. missing item handled safely and reported as failed', async () => {
    const missing = path.join(quarantineRootDir, 'missing.txt');

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-missing',
          quarantinePath: missing,
          originalPath: '/src/missing.txt',
          actionType: 'remove-file',
          verifiedSha256: 'some-hash',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('does not exist');
  });

  // 6. existing integrity mismatch prevents deletion
  it('6. existing integrity mismatch prevents deletion', async () => {
    const file = path.join(quarantineRootDir, 'wrong-hash.txt');
    await fs.promises.writeFile(file, 'content');

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-wrong',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: 'mismatched-verified-hash',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  // 7. symlink target is rejected
  it('7. symlink target is rejected and never deleted', async () => {
    const realFile = path.join(quarantineRootDir, 'real.txt');
    const symlinkFile = path.join(quarantineRootDir, 'symlink.txt');
    await fs.promises.writeFile(realFile, 'real-content');
    await fs.promises.symlink(realFile, symlinkFile);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-sym',
          quarantinePath: symlinkFile,
          originalPath: '/src/sym.txt',
          actionType: 'remove-file',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('symbolic link');
    expect(fs.existsSync(realFile)).toBe(true);
    expect(fs.existsSync(symlinkFile)).toBe(true);
  });

  // 8. quarantineRoot cannot be deleted
  it('8. quarantineRoot cannot be deleted', async () => {
    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-root',
          quarantinePath: quarantineRootDir,
          originalPath: '/src',
          actionType: 'remove-directory',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('conflicts with quarantineRoot itself');
    expect(fs.existsSync(quarantineRootDir)).toBe(true);
  });

  // 9. path traversal rejected
  it('9. path traversal escaping quarantineRoot is rejected', async () => {
    const outside = path.join(quarantineRootDir, '../outside.txt');
    await fs.promises.writeFile(outside, 'outside');

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-trav',
          quarantinePath: outside,
          originalPath: '/src/outside.txt',
          actionType: 'remove-file',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('escapes quarantineRoot');
    expect(fs.existsSync(outside)).toBe(true);
  });

  // 10. Docker action rejected
  it('10. Docker action is rejected by executor', async () => {
    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-docker',
          quarantinePath: path.join(quarantineRootDir, 'c-123'),
          originalPath: 'c-123',
          actionType: 'docker-remove-container',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('Unsupported action type');
  });

  // 11. dry-run performs no deletion
  it('11. dry-run performs no deletion', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'keep-me');
    const hash = await hashFile(file);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-dry',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: hash,
        },
      ],
    });

    const report = await executor.execute(payload, {
      quarantineRoot: quarantineRootDir,
      dryRun: true,
    });

    expect(report.deletedCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.items[0].status).toBe('skipped');
    expect(report.items[0].error).toContain('Dry run');
    expect(fs.existsSync(file)).toBe(true);
  });

  // 12. partial failures handled independently
  it('12. partial failures handled independently', async () => {
    const goodFile = path.join(quarantineRootDir, 'good.txt');
    await fs.promises.writeFile(goodFile, 'good-content');
    const goodHash = await hashFile(goodFile);

    const badFile = path.join(quarantineRootDir, 'bad.txt');
    await fs.promises.writeFile(badFile, 'bad-content');

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-good',
          quarantinePath: goodFile,
          originalPath: '/src/good.txt',
          actionType: 'remove-file',
          verifiedSha256: goodHash,
        },
        {
          actionId: 'act-bad',
          quarantinePath: badFile,
          originalPath: '/src/bad.txt',
          actionType: 'remove-file',
          verifiedSha256: 'wrong-hash',
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.deletedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    expect(fs.existsSync(goodFile)).toBe(false);
    expect(fs.existsSync(badFile)).toBe(true);
  });

  // 13. deletion report accurate
  it('13. deletion report is accurate', async () => {
    const file = path.join(quarantineRootDir, 'report-test.txt');
    await fs.promises.writeFile(file, 'test');
    const hash = await hashFile(file);

    const payload = createPayload({
      manifestId: 'manifest-exact-id',
      eligibleItems: [
        {
          actionId: 'act-rep',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: hash,
        },
      ],
    });

    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.manifestId).toBe('manifest-exact-id');
    expect(report.deletedCount).toBe(1);
    expect(report.items[0].status).toBe('deleted');
  });

  // 14. file content disappears after successful deletion
  it('14. file content disappears after successful deletion', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'sensitive-temp-data');
    const hash = await hashFile(file);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-file',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: hash,
        },
      ],
    });

    await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(fs.existsSync(file)).toBe(false);
  });

  // 15. directory disappears after successful deletion
  it('15. directory disappears after successful deletion', async () => {
    const dir = path.join(quarantineRootDir, 'dir-to-delete');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'child.txt'), 'child');
    const hash = await hashDirectory(dir);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-dir',
          quarantinePath: dir,
          originalPath: '/src/dir',
          actionType: 'remove-directory',
          verifiedSha256: hash,
        },
      ],
    });

    await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(fs.existsSync(dir)).toBe(false);
  });

  // 16. no shell execution
  it('16. no shell execution in DeletionExecutor source', () => {
    const content = fs.readFileSync('src/cleanup/deletion/DeletionExecutor.ts', 'utf8');
    expect(content).not.toContain('exec(');
    expect(content).not.toContain('execFile(');
    expect(content).not.toContain('spawn(');
  });

  // 17. no child_process
  it('17. no child_process in DeletionExecutor source', () => {
    const content = fs.readFileSync('src/cleanup/deletion/DeletionExecutor.ts', 'utf8');
    expect(content).not.toContain('child_process');
  });

  // 18. no DockerClient
  it('18. no DockerClient in DeletionExecutor source', () => {
    const content = fs.readFileSync('src/cleanup/deletion/DeletionExecutor.ts', 'utf8');
    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker rmi');
    expect(content).not.toContain('docker rm');
  });

  // 19. no arbitrary path deletion API
  it('19. no arbitrary path deletion method exists on DeletionExecutor', () => {
    const content = fs.readFileSync('src/cleanup/deletion/DeletionExecutor.ts', 'utf8');
    expect(content).not.toContain('deletePath(');
    expect(content).not.toContain('deleteArbitrary(');
    expect(content).not.toContain('deleteAll(');
    expect(content).not.toContain('autoDelete(');
    expect(content).not.toContain('forceDelete(');
  });

  // 20. final re-hash occurs before deletion
  it('20. final re-hash occurs before deletion and verifies integrity', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'data-v1');
    const hash = await hashFile(file);

    const payload = createPayload({
      eligibleItems: [
        {
          actionId: 'act-1',
          quarantinePath: file,
          originalPath: '/src/file.txt',
          actionType: 'remove-file',
          verifiedSha256: hash,
        },
      ],
    });

    // Content unmodified: re-hash succeeds and item deletes
    const report = await executor.execute(payload, { quarantineRoot: quarantineRootDir });
    expect(report.deletedCount).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
