import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuarantineVerifier } from '../../src/cleanup/quarantine/QuarantineVerifier.js';
import type { QuarantineManifest } from '../../src/types/quarantine.js';
import { hashDirectory, hashFile } from '../../src/utils/hash.js';

describe('QuarantineVerifier Unit Tests', () => {
  let tempBaseDir: string;
  let quarantineRootDir: string;
  let workDir: string;
  let verifier: QuarantineVerifier;

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-verifier-test-'));
    quarantineRootDir = path.join(tempBaseDir, 'quarantine-vault');
    workDir = path.join(tempBaseDir, 'workdir');
    await fs.promises.mkdir(quarantineRootDir, { recursive: true });
    await fs.promises.mkdir(workDir, { recursive: true });
    verifier = new QuarantineVerifier();
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // 1. intact file
  it('1. intact file is verified successfully', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'hello-world');
    const hash = await hashFile(file);
    const stat = await fs.promises.stat(file);

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-1',
          sourcePath: path.join(workDir, 'file.txt'),
          quarantinePath: file,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSizeBytes: stat.size,
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('verified');
    expect(report.intactCount).toBe(1);
    expect(report.items[0].status).toBe('intact');
  });

  // 2. modified file
  it('2. modified file is detected', async () => {
    const file = path.join(quarantineRootDir, 'file.txt');
    await fs.promises.writeFile(file, 'hello-world');
    const hash = await hashFile(file);
    const stat = await fs.promises.stat(file);

    // Modify file
    await fs.promises.writeFile(file, 'modified-world');

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-1',
          sourcePath: path.join(workDir, 'file.txt'),
          quarantinePath: file,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSizeBytes: stat.size,
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('issues-found');
    expect(report.modifiedCount).toBe(1);
    expect(report.items[0].status).toBe('modified');
    expect(report.items[0].error).toContain('hash mismatch');
  });

  // 3. missing file
  it('3. missing file is detected', async () => {
    const missingPath = path.join(quarantineRootDir, 'missing.txt');

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-1',
          sourcePath: path.join(workDir, 'missing.txt'),
          quarantinePath: missingPath,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSizeBytes: 10,
          originalSha256: 'fake-hash',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('issues-found');
    expect(report.missingCount).toBe(1);
    expect(report.items[0].status).toBe('missing');
  });

  // 4. inaccessible/invalid file
  it('4. inaccessible/invalid file status reported', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 0,
      failedCount: 1,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-fail',
          sourcePath: path.join(workDir, 'failed.txt'),
          quarantinePath: path.join(quarantineRootDir, 'failed.txt'),
          actionType: 'remove-file',
          status: 'failed',
          error: 'Original quarantine failed',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('issues-found');
    expect(report.invalidCount).toBe(1);
    expect(report.items[0].status).toBe('invalid');
  });

  // 5. intact directory
  it('5. intact directory is verified successfully', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'content-a');
    await fs.promises.writeFile(path.join(dir, 'b.txt'), 'content-b');

    const hash = await hashDirectory(dir);

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: path.join(workDir, 'cache-dir'),
          quarantinePath: dir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('verified');
    expect(report.intactCount).toBe(1);
    expect(report.items[0].status).toBe('intact');
  });

  // 6. modified directory
  it('6. modified directory is detected', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'content-a');

    const hash = await hashDirectory(dir);

    // Modify file inside directory
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'content-a-tampered');

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: path.join(workDir, 'cache-dir'),
          quarantinePath: dir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('issues-found');
    expect(report.modifiedCount).toBe(1);
    expect(report.items[0].status).toBe('modified');
  });

  // 7. added directory entry detected
  it('7. added directory entry detected', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'content-a');

    const hash = await hashDirectory(dir);

    // Add extra file
    await fs.promises.writeFile(path.join(dir, 'added.txt'), 'new-file');

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: path.join(workDir, 'cache-dir'),
          quarantinePath: dir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.modifiedCount).toBe(1);
    expect(report.items[0].status).toBe('modified');
  });

  // 8. removed directory entry detected
  it('8. removed directory entry detected', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'content-a');
    await fs.promises.writeFile(path.join(dir, 'b.txt'), 'content-b');

    const hash = await hashDirectory(dir);

    // Remove file b.txt
    await fs.promises.rm(path.join(dir, 'b.txt'));

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: path.join(workDir, 'cache-dir'),
          quarantinePath: dir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.modifiedCount).toBe(1);
    expect(report.items[0].status).toBe('modified');
  });

  // 9. changed nested file detected
  it('9. changed nested file detected', async () => {
    const dir = path.join(quarantineRootDir, 'cache-dir');
    const nested = path.join(dir, 'sub', 'deep');
    await fs.promises.mkdir(nested, { recursive: true });
    await fs.promises.writeFile(path.join(nested, 'deep.json'), '{"key":"initial"}');

    const hash = await hashDirectory(dir);

    // Change deep file
    await fs.promises.writeFile(path.join(nested, 'deep.json'), '{"key":"tampered"}');

    const manifest: QuarantineManifest = {
      manifestId: 'quarantine-manifest-dir',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dir',
          sourcePath: path.join(workDir, 'cache-dir'),
          quarantinePath: dir,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: hash,
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.modifiedCount).toBe(1);
  });

  // 10. manifest validation
  it('10. manifest validation rejects malformed manifest', async () => {
    const malformedManifest = {
      manifestId: '',
      createdAt: '2026-09-25T12:00:00Z',
      items: 'not-an-array' as unknown,
    } as unknown as QuarantineManifest;

    const report = await verifier.verify(malformedManifest);
    expect(report.status).toBe('invalid-manifest');
    expect(report.invalidCount).toBeGreaterThan(0);
  });

  // 11. duplicate action IDs rejected
  it('11. duplicate action IDs rejected in manifest', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'dup-manifest',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 2,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-dup',
          sourcePath: '/src/a',
          quarantinePath: path.join(quarantineRootDir, 'a'),
          actionType: 'remove-file',
          status: 'quarantined',
        },
        {
          actionId: 'act-dup',
          sourcePath: '/src/b',
          quarantinePath: path.join(quarantineRootDir, 'b'),
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('invalid-manifest');
    expect(report.items[0].error).toContain('Duplicate actionId');
  });

  // 12. quarantine path escape rejected
  it('12. quarantine path escape rejected', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'escape-manifest',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-esc',
          sourcePath: '/src/a',
          quarantinePath: '/etc/passwd',
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('invalid-manifest');
  });

  // 13. path traversal rejected
  it('13. path traversal rejected in quarantinePath', async () => {
    const manifest: QuarantineManifest = {
      manifestId: 'traversal-manifest',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-trav',
          sourcePath: '/src/a',
          quarantinePath: path.join(quarantineRootDir, '../outside'),
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.status).toBe('invalid-manifest');
  });

  // 14. symlink safety
  it('14. symlink in quarantine path is rejected as invalid', async () => {
    const realFile = path.join(quarantineRootDir, 'real.txt');
    const symlinkFile = path.join(quarantineRootDir, 'symlink.txt');
    await fs.promises.writeFile(realFile, 'real-content');
    await fs.promises.symlink(realFile, symlinkFile);

    const manifest: QuarantineManifest = {
      manifestId: 'symlink-manifest',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-sym',
          sourcePath: '/src/sym',
          quarantinePath: symlinkFile,
          actionType: 'remove-file',
          status: 'quarantined',
        },
      ],
    };

    const report = await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    expect(report.items[0].status).toBe('invalid');
    expect(report.items[0].error).toContain('unexpected symbolic link');
  });

  // 15. deterministic file hash
  it('15. deterministic file hash produces identical outputs for identical content', async () => {
    const file1 = path.join(quarantineRootDir, 'file1.txt');
    const file2 = path.join(quarantineRootDir, 'file2.txt');
    await fs.promises.writeFile(file1, 'deterministic-data');
    await fs.promises.writeFile(file2, 'deterministic-data');

    const hash1 = await hashFile(file1);
    const hash2 = await hashFile(file2);
    expect(hash1).toBe(hash2);
  });

  // 16. deterministic directory representation
  it('16. deterministic directory representation produces identical hashes', async () => {
    const dirA = path.join(quarantineRootDir, 'dir-a');
    const dirB = path.join(quarantineRootDir, 'dir-b');
    await fs.promises.mkdir(path.join(dirA, 'sub'), { recursive: true });
    await fs.promises.mkdir(path.join(dirB, 'sub'), { recursive: true });

    await fs.promises.writeFile(path.join(dirA, 'sub', 'f1.txt'), 'content-1');
    await fs.promises.writeFile(path.join(dirA, 'sub', 'f2.txt'), 'content-2');

    // Create in reverse order in dirB
    await fs.promises.writeFile(path.join(dirB, 'sub', 'f2.txt'), 'content-2');
    await fs.promises.writeFile(path.join(dirB, 'sub', 'f1.txt'), 'content-1');

    const hashA = await hashDirectory(dirA);
    const hashB = await hashDirectory(dirB);
    expect(hashA).toBe(hashB);
  });

  // 17. verification performs zero filesystem mutation
  it('17. verification performs zero filesystem mutation', async () => {
    const file = path.join(quarantineRootDir, 'test-zero.txt');
    await fs.promises.writeFile(file, 'unchanged-data');
    const hash = await hashFile(file);
    const statBefore = await fs.promises.stat(file);

    const manifest: QuarantineManifest = {
      manifestId: 'zero-mutation',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-zero',
          sourcePath: path.join(workDir, 'test-zero.txt'),
          quarantinePath: file,
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: hash,
          originalSizeBytes: statBefore.size,
        },
      ],
    };

    await verifier.verify(manifest, { quarantineRoot: quarantineRootDir });
    const statAfter = await fs.promises.stat(file);

    expect(statAfter.size).toBe(statBefore.size);
    expect(await fs.promises.readFile(file, 'utf8')).toBe('unchanged-data');
  });

  // 18. no child_process
  it('18. no child_process in QuarantineVerifier source', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineVerifier.ts', 'utf8');
    expect(content).not.toContain('child_process');
  });

  // 19. no DockerClient
  it('19. no DockerClient in QuarantineVerifier source', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineVerifier.ts', 'utf8');
    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker');
  });

  // 20. no deletion methods
  it('20. no deletion methods exist in QuarantineVerifier', () => {
    const content = fs.readFileSync('src/cleanup/quarantine/QuarantineVerifier.ts', 'utf8');
    expect(content).not.toContain('fs.rm');
    expect(content).not.toContain('fs.unlink');
    expect(content).not.toContain('fs.rmdir');
    expect(content).not.toContain('unlink(');
    expect(content).not.toContain('delete(');
  });
});
