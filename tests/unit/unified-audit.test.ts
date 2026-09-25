import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { UnifiedAudit } from '../../src/audit/UnifiedAudit.js';
import { Analyzer } from '../../src/analyzer/Analyzer.js';
import { DependencyScanner } from '../../src/scanner/dependencies/DependencyScanner.js';
import { hashDirectory } from '../../src/utils/hash.js';

describe('UnifiedAudit Domain Service (Step 16A)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-audit-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. SUCCESSFUL FILE-ONLY AUDIT
  // =========================================================================
  it('1. performs a successful file-only audit', async () => {
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'hello content');
    await fs.writeFile(path.join(tempDir, 'file2.log'), 'log data');

    const auditService = new UnifiedAudit();
    const result = await auditService.audit(tempDir, {
      includeScanners: ['files'],
    });

    expect(result.auditId).toMatch(/^audit-[0-9a-f]{16}$/);
    expect(result.rootPath).toBe(path.resolve(tempDir));
    expect(result.scannersRun).toEqual(['files']);
    expect(result.scannerResults.files).toBeDefined();
    expect(result.scannerResults.files?.totalEntries).toBeGreaterThanOrEqual(2);
    expect(result.scannerResults.git).toBeUndefined();
    expect(result.scannerResults.dependencies).toBeUndefined();
    expect(result.scannerResults.cache).toBeUndefined();
    expect(result.scannerResults.docker).toBeUndefined();
    expect(result.summary.filesScanned).toBeGreaterThanOrEqual(2);
    expect(result.summary.gitRepositoriesDetected).toBe(0);
    expect(result.summary.dependencyManifestsDetected).toBe(0);
    expect(result.summary.cachesDetected).toBe(0);
  });

  // =========================================================================
  // 2. SUCCESSFUL MULTI-SCANNER AUDIT
  // =========================================================================
  it('2. performs a successful multi-scanner audit across files, git, dependencies, and cache', async () => {
    // 1. File
    await fs.writeFile(path.join(tempDir, 'index.ts'), 'console.log("hello");');

    // 2. Git repo
    const gitDir = path.join(tempDir, '.git');
    const objectsDir = path.join(gitDir, 'objects', '4b');
    const refsHeads = path.join(gitDir, 'refs', 'heads');
    await fs.mkdir(objectsDir, { recursive: true });
    await fs.mkdir(refsHeads, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(refsHeads, 'main'), '0123456789abcdef0123456789abcdef01234567\n');
    await fs.writeFile(path.join(objectsDir, '825dc642cb6eb9a060e54bf8d69288fbee4904'), 'obj');

    // 3. Package.json
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-app', dependencies: { lodash: '^4.17.21' } }),
    );

    // 4. Cache directory
    const cacheDir = path.join(tempDir, '.npm');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'cache.bin'), 'cache-content');

    const auditService = new UnifiedAudit();
    const result = await auditService.audit(tempDir, {
      includeScanners: ['files', 'git', 'dependencies', 'cache'],
    });

    expect(result.scannersRun).toEqual(['files', 'git', 'dependencies', 'cache']);
    expect(result.scannerResults.files).toBeDefined();
    expect(result.scannerResults.git).toBeDefined();
    expect(result.scannerResults.git?.isRepository).toBe(true);
    expect(result.scannerResults.dependencies).toBeDefined();
    expect(result.scannerResults.dependencies?.manifestFound).toBe(true);
    expect(result.scannerResults.cache).toBeDefined();
    expect(result.scannerResults.cache?.caches.length).toBeGreaterThanOrEqual(1);

    expect(result.summary.filesScanned).toBeGreaterThan(0);
    expect(result.summary.gitRepositoriesDetected).toBe(1);
    expect(result.summary.dependencyManifestsDetected).toBe(1);
    expect(result.summary.cachesDetected).toBeGreaterThanOrEqual(1);
    expect(result.summary.totalFindings).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // 3. ANALYZER RECEIVES COLLECTED SCANNER RESULTS
  // =========================================================================
  it('3. passes collected scanner results directly to Analyzer without alteration', async () => {
    await fs.writeFile(path.join(tempDir, 'sample.txt'), 'data');

    const mockAnalyzer = new Analyzer();
    const analyzeSpy = vi.spyOn(mockAnalyzer, 'analyze');

    const auditService = new UnifiedAudit({ analyzer: mockAnalyzer });
    const result = await auditService.audit(tempDir, {
      includeScanners: ['files'],
    });

    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    const analyzerInput = analyzeSpy.mock.calls[0][0];
    expect(analyzerInput.files).toBe(result.scannerResults.files);
    expect(analyzerInput.git).toBeUndefined();
    expect(result.findings).toEqual(analyzeSpy.mock.results[0].value.findings);
  });

  // =========================================================================
  // 4. SCANNER WARNINGS ARE PRESERVED
  // =========================================================================
  it('4. preserves and aggregates scanner warnings and error notifications', async () => {
    // Setup file scanner truncation by setting maxResults: 1 with 3 files
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(tempDir, 'b.txt'), 'b');
    await fs.writeFile(path.join(tempDir, 'c.txt'), 'c');

    const auditService = new UnifiedAudit();
    const result = await auditService.audit(tempDir, {
      includeScanners: ['files', 'git'],
      files: { maxResults: 1 },
    });

    // Both files truncation and git not-a-repo warnings should be captured
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);

    const truncationWarn = result.warnings.find(
      (w) => w.scanner === 'files' && w.category === 'truncation',
    );
    expect(truncationWarn).toBeDefined();

    const gitWarn = result.warnings.find(
      (w) => w.scanner === 'git' && w.category === 'not_a_repository',
    );
    expect(gitWarn).toBeDefined();
  });

  // =========================================================================
  // 5. ONE SCANNER FAILURE DOES NOT SILENTLY DISAPPEAR
  // =========================================================================
  it('5. does not fail the entire audit when a single scanner errors, and records the failure in warnings', async () => {
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'content');

    const failingDependencyScanner = {
      scan: vi.fn().mockRejectedValue(new Error('Simulated dependency scanner filesystem failure')),
    } as unknown as DependencyScanner;

    const auditService = new UnifiedAudit({
      dependencyScanner: failingDependencyScanner,
    });

    const result = await auditService.audit(tempDir, {
      includeScanners: ['files', 'dependencies'],
    });

    // The audit should succeed and include files
    expect(result.scannerResults.files).toBeDefined();
    expect(result.scannerResults.dependencies).toBeUndefined();

    // The failure must be recorded in warnings with scanner and message
    const depFailure = result.warnings.find((w) => w.scanner === 'dependencies');
    expect(depFailure).toBeDefined();
    expect(depFailure?.category).toBe('scanner_error');
    expect(depFailure?.message).toContain('Simulated dependency scanner filesystem failure');
  });

  // =========================================================================
  // 6. INVALID ROOT PATH IS REJECTED
  // =========================================================================
  it('6. rejects invalid rootPath arguments with descriptive errors', async () => {
    const auditService = new UnifiedAudit();

    // Empty or whitespace
    await expect(auditService.audit('')).rejects.toThrow(/rootPath must be a non-empty string/i);
    await expect(auditService.audit('   ')).rejects.toThrow(/rootPath must be a non-empty string/i);

    // Non-existent directory
    const nonExistent = path.join(tempDir, 'does-not-exist');
    await expect(auditService.audit(nonExistent)).rejects.toThrow(/Path does not exist/i);

    // File instead of directory
    const filePath = path.join(tempDir, 'regular-file.txt');
    await fs.writeFile(filePath, 'just a file');
    await expect(auditService.audit(filePath)).rejects.toThrow(/Path is not a directory/i);

    // Symlink directory
    const realDir = path.join(tempDir, 'real-dir');
    const symlinkDir = path.join(tempDir, 'symlink-dir');
    await fs.mkdir(realDir);
    await fs.symlink(realDir, symlinkDir);
    await expect(auditService.audit(symlinkDir)).rejects.toThrow(
      /Root path cannot be a symbolic link/i,
    );
  });

  // =========================================================================
  // 7. READ-ONLY BEHAVIOR
  // =========================================================================
  it('7. guarantees complete read-only behavior without altering files or directories', async () => {
    const subDir = path.join(tempDir, 'subdir');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'immutable content');
    await fs.writeFile(path.join(subDir, 'subfile.log'), 'immutable log');

    const beforeHash = await hashDirectory(tempDir);
    const beforeStat = await fs.stat(path.join(tempDir, 'file.txt'));

    const auditService = new UnifiedAudit();
    await auditService.audit(tempDir);

    const afterHash = await hashDirectory(tempDir);
    const afterStat = await fs.stat(path.join(tempDir, 'file.txt'));

    expect(afterHash).toBe(beforeHash);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });

  // =========================================================================
  // 8. DETERMINISTIC AUDIT ID FOR IDENTICAL LOGICAL INPUT
  // =========================================================================
  it('8. generates deterministic auditId for identical logical input regardless of runtime timestamp', async () => {
    await fs.writeFile(path.join(tempDir, 'sample.txt'), 'sample content');

    const auditService = new UnifiedAudit();

    // Run 1 with simulated timestamp 1
    const result1 = await auditService.audit(tempDir, {
      includeScanners: ['files'],
      now: '2026-01-01T00:00:00.000Z',
    });

    // Run 2 with simulated timestamp 2
    const result2 = await auditService.audit(tempDir, {
      includeScanners: ['files'],
      now: '2026-12-31T23:59:59.999Z',
    });

    // The auditId MUST be identical because the scanned target and logical inputs are identical
    expect(result1.auditId).toBe(result2.auditId);
    expect(result1.auditId).toMatch(/^audit-[0-9a-f]{16}$/);

    // Modifying the logical input (adding a file) must produce a different deterministic auditId
    await fs.writeFile(path.join(tempDir, 'additional.txt'), 'extra content');
    const result3 = await auditService.audit(tempDir, {
      includeScanners: ['files'],
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(result3.auditId).not.toBe(result1.auditId);
  });

  // =========================================================================
  // 9. NO DESTRUCTIVE COMPONENTS ARE INVOKED
  // =========================================================================
  it('9. verifies no destructive, approval, or execution components are invoked', async () => {
    // Static code inspection of UnifiedAudit.ts ensures no imports of mutation modules
    const unifiedAuditCode = await fs.readFile(
      path.resolve(process.cwd(), 'src/audit/UnifiedAudit.ts'),
      'utf8',
    );

    expect(unifiedAuditCode).not.toContain('ApprovalGate');
    expect(unifiedAuditCode).not.toContain('QuarantineExecutor');
    expect(unifiedAuditCode).not.toContain('QuarantineRestorer');
    expect(unifiedAuditCode).not.toContain('DeletionGate');
    expect(unifiedAuditCode).not.toContain('DeletionExecutor');
    expect(unifiedAuditCode).not.toContain('fs.rm');
    expect(unifiedAuditCode).not.toContain('fs.unlink');
    expect(unifiedAuditCode).not.toContain('child_process');
    expect(unifiedAuditCode).not.toContain('exec(');
    expect(unifiedAuditCode).not.toContain('spawn(');
  });

  // =========================================================================
  // 10. EMPTY / PARTIAL SCANNER RESULTS ARE HANDLED SAFELY
  // =========================================================================
  it('10. handles empty directories and partial scanner results safely without errors', async () => {
    // Empty directory
    const auditService = new UnifiedAudit();
    const result = await auditService.audit(tempDir, {
      includeScanners: ['files', 'git', 'dependencies', 'cache'],
    });

    expect(result.summary.filesScanned).toBe(0);
    expect(result.summary.gitRepositoriesDetected).toBe(0);
    expect(result.summary.dependencyManifestsDetected).toBe(0);
    expect(result.summary.cachesDetected).toBe(0);
    expect(result.summary.totalFindings).toBe(0);
    expect(result.summary.totalReclaimableBytes).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.auditId).toBeDefined();

    // Partial scanner execution (e.g. only dependencies)
    const depOnlyResult = await auditService.audit(tempDir, {
      includeScanners: ['dependencies'],
    });
    expect(depOnlyResult.scannersRun).toEqual(['dependencies']);
    expect(depOnlyResult.scannerResults.files).toBeUndefined();
    expect(depOnlyResult.scannerResults.dependencies?.manifestFound).toBe(false);
  });
});
