import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuarantineRestorer } from '../../src/cleanup/quarantine/QuarantineRestorer.js';
import type { QuarantineManifest } from '../../src/types/quarantine.js';
import { hashDirectory, hashFile } from '../../src/utils/hash.js';

describe('QuarantineRestorer Unit Tests', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let originalBaseDir: string;
  let restorer: QuarantineRestorer;

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-restorer-test-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    originalBaseDir = path.join(tempBaseDir, 'original-location');
    await fs.promises.mkdir(quarantineRootDir, { recursive: true });
    await fs.promises.mkdir(originalBaseDir, { recursive: true });
    restorer = new QuarantineRestorer();
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // 1. restores explicit file action
  it('1. restores explicit file action back to original location', async () => {
    const quarFile = path.join(quarantineRootDir, 'file.txt');
    const origFile = path.join(originalBaseDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'test-restore-content');
    const hash = await hashFile(quarFile);
    const stat = await fs.promises.stat(quarFile);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-restore-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-file',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: hash,
          originalSizeBytes: stat.size,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-file'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(fs.existsSync(origFile)).toBe(true);
    expect(fs.existsSync(quarFile)).toBe(false);
    expect(await fs.promises.readFile(origFile, 'utf8')).toBe('test-restore-content');
  });

  // 2. restores explicit directory action
  it('2. restores explicit directory action back to original location', async () => {
    const quarDir = path.join(quarantineRootDir, 'cache-dir');
    const origDir = path.join(originalBaseDir, 'cache-dir');
    await fs.promises.mkdir(quarDir, { recursive: true });
    await fs.promises.writeFile(path.join(quarDir, 'sub.txt'), 'sub-content');
    const hash = await hashDirectory(quarDir);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-restore-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: origDir,
          quarantinePath: quarDir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-dir'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(fs.existsSync(origDir)).toBe(true);
    expect(fs.existsSync(path.join(origDir, 'sub.txt'))).toBe(true);
    expect(fs.existsSync(quarDir)).toBe(false);
  });

  // 3. unrequested action is not restored
  it('3. unrequested action is not restored', async () => {
    const fileA = path.join(quarantineRootDir, 'fileA.txt');
    const fileB = path.join(quarantineRootDir, 'fileB.txt');
    const origA = path.join(originalBaseDir, 'fileA.txt');
    const origB = path.join(originalBaseDir, 'fileB.txt');
    await fs.promises.writeFile(fileA, 'content-a');
    await fs.promises.writeFile(fileB, 'content-b');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-multi',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 2,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-A',
          sourcePath: origA,
          quarantinePath: fileA,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: await hashFile(fileA),
          originalSizeBytes: 9,
        },
        {
          actionId: 'act-B',
          sourcePath: origB,
          quarantinePath: fileB,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: await hashFile(fileB),
          originalSizeBytes: 9,
        },
      ],
    };

    // Request restore of act-A only
    const report = await restorer.restore(manifest, ['act-A'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(fs.existsSync(origA)).toBe(true);
    expect(fs.existsSync(fileA)).toBe(false);

    // act-B remains quarantined
    expect(fs.existsSync(origB)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(true);
  });

  // 4. unknown action is rejected
  it('4. unknown action is rejected with error', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'manifest-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 0,
      failedCount: 0,
      skippedCount: 0,
      items: [],
    };

    const report = await restorer.restore(manifest, ['act-nonexistent'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].error).toContain('not found');
  });

  // 5. invalid manifest rejected
  it('5. invalid manifest rejected', async () => {
    const rawPlan = {
      id: 'plan-1',
      findingsAnalyzed: 10,
    };

    await expect(
      restorer.restore(rawPlan as unknown as QuarantineManifest, ['act-1'], {
        quarantineRoot: quarantineRootDir,
      }),
    ).rejects.toThrowError(/Execution boundary violated/);
  });

  // 6. missing quarantine item rejected
  it('6. missing quarantine item rejected', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'manifest-missing',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-missing',
          sourcePath: path.join(originalBaseDir, 'missing.txt'),
          quarantinePath: path.join(quarantineRootDir, 'nonexistent.txt'),
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-missing'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].error).toContain('does not exist');
  });

  // 7. existing destination causes failure
  it('7. existing destination causes failure and does not overwrite', async () => {
    const quarFile = path.join(quarantineRootDir, 'file.txt');
    const origFile = path.join(originalBaseDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'quarantine-version');
    await fs.promises.writeFile(origFile, 'already-existing-version');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-col',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-col',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: await hashFile(quarFile),
          originalSizeBytes: 18,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-col'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].error).toContain('already exists');

    // Existing original file remains untouched
    expect(await fs.promises.readFile(origFile, 'utf8')).toBe('already-existing-version');
    // Quarantine file remains untouched
    expect(fs.existsSync(quarFile)).toBe(true);
  });

  // 8. destination symlink causes failure
  it('8. destination symlink causes failure and is not overwritten', async () => {
    const realTarget = path.join(originalBaseDir, 'real.txt');
    const symlinkDest = path.join(originalBaseDir, 'symlink-dest.txt');
    await fs.promises.writeFile(realTarget, 'real');
    await fs.promises.symlink(realTarget, symlinkDest);

    const quarFile = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'new-data');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-sym-dest',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-sym-dest',
          sourcePath: symlinkDest,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-sym-dest'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('already exists');
    expect(fs.existsSync(quarFile)).toBe(true);
  });

  // 9. original protected path rejected
  it('9. original protected path rejected', async () => {
    const quarFile = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'data');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-prot',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-prot',
          sourcePath: '/etc/evil.conf',
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-prot'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('Protected path');
  });

  // 10. quarantine path rejected as original destination
  it('10. quarantine path rejected as original destination', async () => {
    const quarFile = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'data');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-self',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-self',
          sourcePath: path.join(quarantineRootDir, 'inside', 'dest.txt'),
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-self'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('inside quarantineRoot');
  });

  // 11. missing parent directory can be safely created
  it('11. missing parent directory can be safely created on restore', async () => {
    const quarFile = path.join(quarantineRootDir, 'deep.txt');
    const origFile = path.join(originalBaseDir, 'deep', 'nested', 'path', 'deep.txt');
    await fs.promises.writeFile(quarFile, 'deep-content');
    const hash = await hashFile(quarFile);
    const stat = await fs.promises.stat(quarFile);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-deep',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-deep',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: hash,
          originalSizeBytes: stat.size,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-deep'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(fs.existsSync(origFile)).toBe(true);
    expect(await fs.promises.readFile(origFile, 'utf8')).toBe('deep-content');
  });

  // 12. restore preserves file content
  it('12. restore preserves file content perfectly', async () => {
    const quarFile = path.join(quarantineRootDir, 'preserve.txt');
    const origFile = path.join(originalBaseDir, 'preserve.txt');
    const exactData = 'important-persisted-file-content\nwith\nmultiple lines!';
    await fs.promises.writeFile(quarFile, exactData);
    const hash = await hashFile(quarFile);
    const stat = await fs.promises.stat(quarFile);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-preserve',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-pres',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: hash,
          originalSizeBytes: stat.size,
        },
      ],
    };

    await restorer.restore(manifest, ['act-pres'], { quarantineRoot: quarantineRootDir });
    expect(await fs.promises.readFile(origFile, 'utf8')).toBe(exactData);
  });

  // 13. restore preserves directory contents
  it('13. restore preserves directory contents and structure', async () => {
    const quarDir = path.join(quarantineRootDir, 'full-dir');
    const origDir = path.join(originalBaseDir, 'full-dir');
    await fs.promises.mkdir(path.join(quarDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(quarDir, 'sub', 'f1.txt'), 'f1-data');
    await fs.promises.writeFile(path.join(quarDir, 'f2.txt'), 'f2-data');
    const hash = await hashDirectory(quarDir);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-dir-full',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir-full',
          sourcePath: origDir,
          quarantinePath: quarDir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-dir-full'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(await fs.promises.readFile(path.join(origDir, 'sub', 'f1.txt'), 'utf8')).toBe('f1-data');
    expect(await fs.promises.readFile(path.join(origDir, 'f2.txt'), 'utf8')).toBe('f2-data');
  });

  // 14. restore does not overwrite
  it('14. restore does not overwrite when destination exists', async () => {
    const quarFile = path.join(quarantineRootDir, 'file.txt');
    const origFile = path.join(originalBaseDir, 'file.txt');
    await fs.promises.writeFile(quarFile, 'quar');
    await fs.promises.writeFile(origFile, 'dont-overwrite-me');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-no-overwrite',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-no-ov',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-no-ov'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(await fs.promises.readFile(origFile, 'utf8')).toBe('dont-overwrite-me');
  });

  // 15. partial restore reports independent results
  it('15. partial restore reports independent results', async () => {
    const quarGood = path.join(quarantineRootDir, 'good.txt');
    const origGood = path.join(originalBaseDir, 'good.txt');
    await fs.promises.writeFile(quarGood, 'good-content');

    const origBad = path.join(originalBaseDir, 'bad.txt');
    await fs.promises.writeFile(origBad, 'already-here'); // collision

    const quarBad = path.join(quarantineRootDir, 'bad.txt');
    await fs.promises.writeFile(quarBad, 'bad-content');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-partial',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 2,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-good',
          sourcePath: origGood,
          quarantinePath: quarGood,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: await hashFile(quarGood),
          originalSizeBytes: 12,
        },
        {
          actionId: 'act-bad',
          sourcePath: origBad,
          quarantinePath: quarBad,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: await hashFile(quarBad),
          originalSizeBytes: 11,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-good', 'act-bad'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(report.failedCount).toBe(1);
    expect(fs.existsSync(origGood)).toBe(true);
    expect(fs.existsSync(quarBad)).toBe(true);
  });

  // 16. post-restore verification succeeds
  it('16. post-restore verification succeeds when hashes match', async () => {
    const quarFile = path.join(quarantineRootDir, 'verify-success.txt');
    const origFile = path.join(originalBaseDir, 'verify-success.txt');
    await fs.promises.writeFile(quarFile, 'verified-content');
    const hash = await hashFile(quarFile);
    const stat = await fs.promises.stat(quarFile);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-verify-pass',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-v-pass',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: hash,
          originalSizeBytes: stat.size,
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-v-pass'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.restoredCount).toBe(1);
    expect(report.items[0].status).toBe('restored');
  });

  // 17. post-restore verification failure is reported
  it('17. post-restore verification failure is reported when expected hash does not match', async () => {
    const quarFile = path.join(quarantineRootDir, 'verify-fail.txt');
    const origFile = path.join(originalBaseDir, 'verify-fail.txt');
    await fs.promises.writeFile(quarFile, 'corrupted-data');

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-verify-fail',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-v-fail',
          sourcePath: origFile,
          quarantinePath: quarFile,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'expected-different-hash-value',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-v-fail'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].error).toContain('Post-restore verification failed');
  });

  // 18. symlink quarantine item rejected
  it('18. symlink quarantine item rejected', async () => {
    const realFile = path.join(quarantineRootDir, 'real.txt');
    const symlinkFile = path.join(quarantineRootDir, 'symlink.txt');
    await fs.promises.writeFile(realFile, 'real');
    await fs.promises.symlink(realFile, symlinkFile);

    const manifest: QuarantineManifest = {
      manifestId: 'manifest-sym-item',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-sym-item',
          sourcePath: path.join(originalBaseDir, 'sym.txt'),
          quarantinePath: symlinkFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await restorer.restore(manifest, ['act-sym-item'], {
      quarantineRoot: quarantineRootDir,
    });

    expect(report.failedCount).toBe(1);
    expect(report.items[0].error).toContain('symbolic link');
  });

  // 19. no Docker mutation
  it('19. no Docker mutation in QuarantineRestorer', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineRestorer.ts', 'utf8');
    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker');
  });

  // 20. no permanent deletion
  it('20. no permanent deletion methods in QuarantineRestorer', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineRestorer.ts', 'utf8');
    expect(content).not.toContain('fs.rm');
    expect(content).not.toContain('fs.unlink');
    expect(content).not.toContain('fs.rmdir');
    expect(content).not.toContain('unlink(');
    expect(content).not.toContain('delete(');
  });

  // 21. no shell execution
  it('21. no shell execution in QuarantineRestorer', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineRestorer.ts', 'utf8');
    expect(content).not.toContain('child_process');
    expect(content).not.toContain('exec(');
    expect(content).not.toContain('spawn(');
  });

  // 22. no automatic restore
  it('22. no automatic restore or bypass methods exist in QuarantineRestorer', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineRestorer.ts', 'utf8');
    expect(content).not.toContain('restoreAll');
    expect(content).not.toContain('autoRestore');
    expect(content).not.toContain('restoreEverything');
    expect(content).not.toContain('forceRestore');
    expect(content).not.toContain('bypassRestoreSafety');
  });
});
