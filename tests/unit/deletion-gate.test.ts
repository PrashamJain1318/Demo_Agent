import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DeletionGate } from '../../src/cleanup/deletion/DeletionGate.js';
import type { QuarantineManifest } from '../../src/types/quarantine.js';
import type { VerificationReport } from '../../src/types/verification.js';
import type { DeletionRequest } from '../../src/types/deletion.js';

describe('DeletionGate Unit Tests', () => {
  const gate = new DeletionGate();
  const testQuarantineRoot = '/project/.digital-janitor/quarantine';

  function createManifest(overrides?: Partial<QuarantineManifest>): QuarantineManifest {
    return {
      manifestId: 'manifest-del-1',
      createdAt: '2026-09-25T12:00:00Z',
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
      items: [
        {
          actionId: 'act-file-1',
          sourcePath: '/project/cache/file.txt',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          actionType: 'remove-file',
          status: 'quarantined',
          originalSizeBytes: 100,
          originalSha256: 'hash-abc-123',
        },
      ],
      ...overrides,
    };
  }

  function createVerification(overrides?: Partial<VerificationReport>): VerificationReport {
    return {
      manifestId: 'manifest-del-1',
      verifiedAt: '2026-09-25T12:05:00Z',
      status: 'verified',
      intactCount: 1,
      missingCount: 0,
      modifiedCount: 0,
      inaccessibleCount: 0,
      invalidCount: 0,
      items: [
        {
          actionId: 'act-file-1',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          originalPath: '/project/cache/file.txt',
          status: 'intact',
          expectedHash: 'hash-abc-123',
          actualHash: 'hash-abc-123',
          expectedSizeBytes: 100,
          actualSizeBytes: 100,
        },
      ],
      ...overrides,
    };
  }

  function createRequest(overrides?: Partial<DeletionRequest>): DeletionRequest {
    return {
      manifestId: 'manifest-del-1',
      actionIds: ['act-file-1'],
      decision: 'approved',
      requestedAt: '2026-09-25T12:10:00Z',
      requestedBy: 'security-admin',
      ...overrides,
    };
  }

  // 1. explicit approved intact file
  it('1. explicit approved intact file is eligible for deletion', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('approved');
    expect(payload.approvedActionIds).toEqual(['act-file-1']);
    expect(payload.eligibleItems.length).toBe(1);
    expect(payload.eligibleItems[0].actionId).toBe('act-file-1');
  });

  // 2. explicit approved intact directory
  it('2. explicit approved intact directory is eligible for deletion', () => {
    const dirQuarPath = path.join(testQuarantineRoot, 'manifest-del-1/items/act-dir-1/cache');
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-dir-1',
          sourcePath: '/project/cache',
          quarantinePath: dirQuarPath,
          actionType: 'remove-directory',
          status: 'quarantined',
          originalSha256: 'dir-hash-456',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-dir-1',
          quarantinePath: dirQuarPath,
          originalPath: '/project/cache',
          status: 'intact',
          expectedHash: 'dir-hash-456',
          actualHash: 'dir-hash-456',
        },
      ],
    });

    const request = createRequest({ actionIds: ['act-dir-1'] });
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('approved');
    expect(payload.approvedActionIds).toEqual(['act-dir-1']);
    expect(payload.eligibleItems[0].actionType).toBe('remove-directory');
  });

  // 3. rejected decision
  it('3. rejected decision approves nothing', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest({ decision: 'rejected' });

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.approvedActionIds).toEqual([]);
    expect(payload.eligibleItems).toEqual([]);
    expect(payload.rejectedActionIds).toContain('act-file-1');
  });

  // 4. unknown action
  it('4. unknown action is rejected', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest({ actionIds: ['act-unknown'] });

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.approvedActionIds).toEqual([]);
    expect(payload.rejectedActionIds).toEqual(['act-unknown']);
    expect(payload.rejectionReasons['act-unknown']).toContain('does not exist');
  });

  // 5. unrequested action
  it('5. unrequested action is not approved', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-A',
          sourcePath: '/project/a',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-A/a'),
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'hash-a',
        },
        {
          actionId: 'act-B',
          sourcePath: '/project/b',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-B/b'),
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'hash-b',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-A',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-A/a'),
          originalPath: '/project/a',
          status: 'intact',
          actualHash: 'hash-a',
        },
        {
          actionId: 'act-B',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-B/b'),
          originalPath: '/project/b',
          status: 'intact',
          actualHash: 'hash-b',
        },
      ],
    });

    // Request deletion only for act-A
    const request = createRequest({ actionIds: ['act-A'] });
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.approvedActionIds).toEqual(['act-A']);
    expect(payload.approvedActionIds).not.toContain('act-B');
  });

  // 6. manifest ID mismatch
  it('6. manifest ID mismatch rejects all actions', () => {
    const manifest = createManifest({ manifestId: 'manifest-correct' });
    const verification = createVerification({ manifestId: 'manifest-correct' });
    const request = createRequest({ manifestId: 'manifest-different' });

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.approvedActionIds).toEqual([]);
    expect(payload.rejectionReasons['act-file-1']).toContain('Manifest ID mismatch');
  });

  // 7. verification manifest mismatch
  it('7. verification manifest mismatch rejects all actions', () => {
    const manifest = createManifest({ manifestId: 'manifest-correct' });
    const verification = createVerification({ manifestId: 'manifest-other' });
    const request = createRequest({ manifestId: 'manifest-correct' });

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.approvedActionIds).toEqual([]);
    expect(payload.rejectionReasons['act-file-1']).toContain('Verification manifest ID mismatch');
  });

  // 8. missing verification
  it('8. missing verification item rejects action', () => {
    const manifest = createManifest();
    const verification = createVerification({ items: [] });
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectedActionIds).toContain('act-file-1');
    expect(payload.rejectionReasons['act-file-1']).toContain('no corresponding verification item');
  });

  // 9. modified verification
  it('9. modified verification rejects action', () => {
    const manifest = createManifest();
    const verification = createVerification({
      items: [
        {
          actionId: 'act-file-1',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          originalPath: '/project/cache/file.txt',
          status: 'modified',
          error: 'Content hash modified',
        },
      ],
    });
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectedActionIds).toContain('act-file-1');
    expect(payload.rejectionReasons['act-file-1']).toContain("verification status is 'modified'");
  });

  // 10. missing verification item (item status missing)
  it('10. verification status missing rejects action', () => {
    const manifest = createManifest();
    const verification = createVerification({
      items: [
        {
          actionId: 'act-file-1',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          originalPath: '/project/cache/file.txt',
          status: 'missing',
        },
      ],
    });
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-file-1']).toContain("verification status is 'missing'");
  });

  // 11. stale verification
  it('11. stale verification hash mismatch rejects action', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-file-1',
          sourcePath: '/project/cache/file.txt',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'initial-hash-111',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-file-1',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          originalPath: '/project/cache/file.txt',
          status: 'intact',
          actualHash: 'different-hash-999',
        },
      ],
    });

    const request = createRequest();
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-file-1']).toContain('Stale verification');
  });

  // 12. quarantine status not quarantined
  it('12. quarantine status not quarantined is rejected', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-file-1',
          sourcePath: '/project/cache/file.txt',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          actionType: 'remove-file',
          status: 'failed',
        },
      ],
    });
    const verification = createVerification();
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-file-1']).toContain('is not quarantined');
  });

  // 13. Docker action rejected
  it('13. Docker action is rejected for filesystem deletion', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-docker',
          sourcePath: 'container-123',
          quarantinePath: '',
          actionType: 'docker-remove-container',
          status: 'quarantined',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-docker',
          quarantinePath: '',
          originalPath: 'container-123',
          status: 'intact',
        },
      ],
    });

    const request = createRequest({ actionIds: ['act-docker'] });
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-docker']).toContain('unsupported type');
  });

  // 14. protected path rejected
  it('14. protected path rejected', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-prot',
          sourcePath: '/etc/shadow',
          quarantinePath: '/etc/shadow',
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'hash-shadow',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-prot',
          quarantinePath: '/etc/shadow',
          originalPath: '/etc/shadow',
          status: 'intact',
          actualHash: 'hash-shadow',
        },
      ],
    });

    const request = createRequest({ actionIds: ['act-prot'] });
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectedActionIds).toContain('act-prot');
  });

  // 15. path mismatch rejected
  it('15. path mismatch between manifest and verification rejected', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-file-1',
          sourcePath: '/project/cache/file.txt',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          actionType: 'remove-file',
          status: 'quarantined',
          originalSha256: 'hash-abc',
        },
      ],
    });

    const verification = createVerification({
      items: [
        {
          actionId: 'act-file-1',
          quarantinePath: path.join(testQuarantineRoot, 'different-path/file.txt'),
          originalPath: '/project/cache/file.txt',
          status: 'intact',
          actualHash: 'hash-abc',
        },
      ],
    });

    const request = createRequest();
    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-file-1']).toContain('Quarantine path mismatch');
  });

  // 16. duplicate IDs rejected / deduplicated
  it('16. duplicate IDs in request are handled safely and deduplicated', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest({ actionIds: ['act-file-1', 'act-file-1'] });

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('approved');
    expect(payload.approvedActionIds).toEqual(['act-file-1']);
    expect(payload.eligibleItems.length).toBe(1);
  });

  // 17. restored item rejected
  it('17. item marked skipped (e.g. restored or skipped) is rejected', () => {
    const manifest = createManifest({
      items: [
        {
          actionId: 'act-file-1',
          sourcePath: '/project/cache/file.txt',
          quarantinePath: path.join(testQuarantineRoot, 'manifest-del-1/items/act-file-1/file.txt'),
          actionType: 'remove-file',
          status: 'skipped',
        },
      ],
    });
    const verification = createVerification();
    const request = createRequest();

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.rejectionReasons['act-file-1']).toContain('is not quarantined');
  });

  // 18. no automatic approval
  it('18. no automatic approval without explicit request', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest({ actionIds: [] }); // empty actionIds

    const payload = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
    });

    expect(payload.decision).toBe('rejected');
    expect(payload.approvedActionIds).toEqual([]);
    expect(payload.eligibleItems).toEqual([]);
  });

  // 19. deterministic evaluation
  it('19. deterministic evaluation produces identical payloads for identical inputs', () => {
    const manifest = createManifest();
    const verification = createVerification();
    const request = createRequest();
    const fixedNow = '2026-09-25T12:00:00Z';

    const p1 = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
      now: fixedNow,
    });
    const p2 = gate.evaluate(manifest, verification, request, {
      quarantineRoot: testQuarantineRoot,
      now: fixedNow,
    });

    expect(p1).toEqual(p2);
  });

  // 20. no filesystem mutation
  it('20. no filesystem mutation or deletion methods exist on DeletionGate', () => {
    const content = fs.readFileSync('src/cleanup/deletion/DeletionGate.ts', 'utf8');
    expect(content).not.toContain('unlink');
    expect(content).not.toContain('rmdir');
    expect(content).not.toContain('mkdir');
    expect(content).not.toContain('rename');
    expect(content).not.toContain('writeFile');
    expect(content).not.toContain('child_process');
  });
});
