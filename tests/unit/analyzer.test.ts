import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Analyzer } from '../../src/analyzer/Analyzer.js';
import type { AnalyzerInput } from '../../src/types/analyzer.js';
import type { CacheScanResult } from '../../src/types/cache.js';
import type { DockerScanResult } from '../../src/types/docker.js';
import type { GitScanResult } from '../../src/types/git.js';
import type { DependencyScanResult } from '../../src/types/dependencies.js';
import type { FileScanResult } from '../../src/types/scanner.js';

describe('Analyzer Unit Tests', () => {
  const analyzer = new Analyzer();
  const fixedDate = '2026-09-25T14:00:00.000Z';

  // 1. empty input
  it('1. empty input returns empty findings and initialized metrics', () => {
    const result = analyzer.analyze({}, { now: fixedDate });

    expect(result.findings).toEqual([]);
    expect(result.totalFindings).toBe(0);
    expect(result.totalBytes).toBe(0);
    expect(result.lowRiskCount).toBe(0);
    expect(result.mediumRiskCount).toBe(0);
    expect(result.highRiskCount).toBe(0);
    expect(result.criticalRiskCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.sourceSummary).toEqual({
      files: 0,
      git: 0,
      dependencies: 0,
      cache: 0,
      docker: 0,
    });
  });

  // 2. cache analysis
  it('2. cache analysis creates structured findings from cache scan results', () => {
    const cacheInput: CacheScanResult = {
      rootPath: '/app',
      caches: [
        {
          path: '/app/.npm',
          relativePath: '.npm',
          type: 'npm',
          sizeBytes: 150000,
          entryCount: 42,
          detectedBy: '.npm',
        },
      ],
      totalCacheSizeBytes: 150000,
      totalCacheEntries: 42,
      truncated: false,
    };

    const result = analyzer.analyze({ cache: cacheInput }, { now: fixedDate });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.source).toBe('cache');
    expect(f.category).toBe('cache');
    expect(f.sizeBytes).toBe(150000);
    expect(f.risk).toBe('low');
    expect(f.recommendation).toBe('review');
    expect(f.reversible).toBe(true);
  });

  // 3. known build cache risk
  it('3. known build cache risk: .next/cache and node_modules/.vite classified as build-artifact, low risk, 0.95 confidence', () => {
    const cacheInput: CacheScanResult = {
      rootPath: '/workspace',
      caches: [
        {
          path: '/workspace/.next/cache',
          relativePath: '.next/cache',
          type: 'next',
          sizeBytes: 80000,
          entryCount: 15,
          detectedBy: '.next/cache',
        },
        {
          path: '/workspace/node_modules/.vite',
          relativePath: 'node_modules/.vite',
          type: 'vite',
          sizeBytes: 40000,
          entryCount: 10,
          detectedBy: 'node_modules/.vite',
        },
        {
          path: '/workspace/__pycache__',
          relativePath: '__pycache__',
          type: 'python',
          sizeBytes: 5000,
          entryCount: 3,
          detectedBy: '__pycache__',
        },
      ],
      totalCacheSizeBytes: 125000,
      totalCacheEntries: 28,
      truncated: false,
    };

    const result = analyzer.analyze({ cache: cacheInput });
    const nextFinding = result.findings.find((f) => f.title.includes('NEXT'));
    const viteFinding = result.findings.find((f) => f.title.includes('VITE'));
    const pyFinding = result.findings.find((f) => f.title.includes('PYTHON'));

    expect(nextFinding?.category).toBe('build-artifact');
    expect(nextFinding?.risk).toBe('low');
    expect(nextFinding?.recommendation).toBe('review');
    expect(nextFinding?.confidence).toBe(0.95);

    expect(viteFinding?.category).toBe('build-artifact');
    expect(viteFinding?.risk).toBe('low');
    expect(viteFinding?.confidence).toBe(0.95);

    expect(pyFinding?.category).toBe('cache');
    expect(pyFinding?.risk).toBe('low');
    expect(pyFinding?.confidence).toBe(0.95);
  });

  // 4. package manager cache risk
  it('4. package manager cache risk: .npm, .pnpm-store, .yarn/cache classified as low risk, review, 0.90 confidence', () => {
    const cacheInput: CacheScanResult = {
      rootPath: '/home/user',
      caches: [
        {
          path: '/home/user/.npm',
          relativePath: '.npm',
          type: 'npm',
          sizeBytes: 100000,
          entryCount: 20,
          detectedBy: '.npm',
        },
        {
          path: '/home/user/.pnpm-store',
          relativePath: '.pnpm-store',
          type: 'pnpm',
          sizeBytes: 200000,
          entryCount: 30,
          detectedBy: '.pnpm-store',
        },
        {
          path: '/home/user/.yarn/cache',
          relativePath: '.yarn/cache',
          type: 'yarn',
          sizeBytes: 50000,
          entryCount: 12,
          detectedBy: '.yarn/cache',
        },
      ],
      totalCacheSizeBytes: 350000,
      totalCacheEntries: 62,
      truncated: false,
    };

    const result = analyzer.analyze({ cache: cacheInput });
    for (const finding of result.findings) {
      expect(finding.category).toBe('cache');
      expect(finding.risk).toBe('low');
      expect(finding.recommendation).toBe('review');
      expect(finding.confidence).toBe(0.9);
      expect(finding.reversible).toBe(true);
    }
  });

  // 5. generic cache risk
  it('5. generic cache risk: generic cache directories classified as medium risk, investigate, 0.70 confidence', () => {
    const cacheInput: CacheScanResult = {
      rootPath: '/app',
      caches: [
        {
          path: '/app/.cache',
          relativePath: '.cache',
          type: 'generic',
          sizeBytes: 75000,
          entryCount: 5,
          detectedBy: '.cache',
        },
      ],
      totalCacheSizeBytes: 75000,
      totalCacheEntries: 5,
      truncated: false,
    };

    const result = analyzer.analyze({ cache: cacheInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('cache');
    expect(f.risk).toBe('medium');
    expect(f.recommendation).toBe('investigate');
    expect(f.confidence).toBe(0.7);
    expect(f.reversible).toBe(false);
  });

  // 6. stopped Docker container
  it('6. stopped Docker container classified with medium risk, review, 0.90 confidence', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [
        {
          id: 'c12345678901',
          name: 'stopped-dev-db',
          image: 'postgres:15',
          imageId: 'img-pg15',
          state: 'exited',
          status: 'Exited (0) 2 days ago',
          createdAt: '2026-09-20',
          ports: '',
          mounts: '',
          sizeBytes: 12000000,
          candidateForReview: true,
        },
      ],
      images: [],
      volumes: [],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('medium');
    expect(f.recommendation).toBe('review');
    expect(f.confidence).toBe(0.9);
    expect(f.resourceId).toBe('c12345678901');
    expect(f.title).toBe('Stopped Docker Container (stopped-dev-db)');
    expect(f.description).toContain('candidate for review');
    expect(f.description).toContain('not assumed to be disposable');
  });

  // 7. unreferenced Docker image
  it('7. unreferenced Docker image (0 containers) classified with medium risk, review, 0.85 confidence (not described as disposable)', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [
        {
          id: 'sha256:abcd1234',
          repository: 'old-node-app',
          tag: 'v1.0.0',
          createdAt: '2026-08-01',
          sizeBytes: 250000000,
          containersUsing: 0,
          candidateForReview: true,
        },
      ],
      volumes: [],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('medium');
    expect(f.recommendation).toBe('review');
    expect(f.confidence).toBe(0.85);
    expect(f.sizeBytes).toBe(250000000);
    expect(f.title).toBe('Unreferenced Docker Image (old-node-app:v1.0.0)');
    expect(f.description).toContain('unreferenced image, candidate for review');
    expect(f.description).toContain('not assumed to be disposable');
  });

  // 8. unattached Docker volume
  it('8. unattached Docker volume (0 containers) classified as Unattached Docker Volume with HIGH risk, investigate, 0.95 confidence', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [],
      volumes: [
        {
          name: 'pgdata_backup',
          driver: 'local',
          mountpoint: '/var/lib/docker/volumes/pgdata_backup/_data',
          containerCount: 0,
          candidateForReview: true,
        },
      ],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('high');
    expect(f.recommendation).toBe('investigate');
    expect(f.confidence).toBe(0.95);
    expect(f.resourceId).toBe('pgdata_backup');
    expect(f.title).toBe('Unattached Docker Volume (pgdata_backup)');
    expect(f.description).toContain('unattached volume, candidate for review');
    expect(f.description).toContain('not assumed to be disposable');
  });

  // 9. unattached Docker network
  it('9. unattached Docker network (non-system, 0 containers) classified as Unattached with medium risk, review, 0.90 confidence', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [],
      volumes: [],
      networks: [
        {
          id: 'net999',
          name: 'custom_backend_net',
          driver: 'bridge',
          scope: 'local',
          internal: false,
          attachable: false,
          containerCount: 0,
          candidateForReview: true,
        },
      ],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('medium');
    expect(f.recommendation).toBe('review');
    expect(f.confidence).toBe(0.9);
    expect(f.title).toBe('Unattached Docker Network (custom_backend_net)');
    expect(f.description).toContain('unattached network, candidate for review');
    expect(f.description).toContain('not assumed to be disposable');
  });

  // 10. system Docker network
  it('10. system Docker network (bridge) classified with low risk, RETAIN recommendation, 1.0 confidence', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [],
      volumes: [],
      networks: [
        {
          id: 'net-bridge-id',
          name: 'bridge',
          driver: 'bridge',
          scope: 'local',
          internal: false,
          attachable: false,
          containerCount: 0,
          candidateForReview: false,
        },
      ],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('low');
    expect(f.recommendation).toBe('retain');
    expect(f.confidence).toBe(1.0);
  });

  // 11. Docker build cache
  it('11. Docker build cache entry classified with low risk, review, 0.90 confidence', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [],
      volumes: [],
      networks: [],
      buildCache: [
        {
          id: 'bc-layer-abc',
          type: 'regular',
          sizeBytes: 45000000,
          reclaimable: true,
        },
      ],
      totalReclaimableBytes: 45000000,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.category).toBe('docker');
    expect(f.risk).toBe('low');
    expect(f.recommendation).toBe('review');
    expect(f.confidence).toBe(0.9);
    expect(f.sizeBytes).toBe(45000000);
  });

  // 12. Git metadata retained
  it('12. Git metadata retained: .git directory classified with category repository, low risk, RETAIN recommendation, 1.0 confidence', () => {
    const gitInput: GitScanResult = {
      rootPath: '/repo',
      isRepository: true,
      gitDirectory: '/repo/.git',
      gitDirectoryType: 'directory',
      branch: 'main',
      head: '1234567890abcdef',
      repositorySizeBytes: 5000000,
      packCount: 2,
      looseObjectCount: 15,
      truncated: false,
    };

    const result = analyzer.analyze({ git: gitInput });
    expect(result.findings.length).toBe(1);
    const f = result.findings[0];
    expect(f.source).toBe('git');
    expect(f.category).toBe('repository');
    expect(f.risk).toBe('low');
    expect(f.recommendation).toBe('retain');
    expect(f.confidence).toBe(1.0);
    expect(f.sizeBytes).toBe(5000000);
  });

  // 13. dependency false-positive prevention
  it('13. dependency false-positive prevention: normal declared and installed dependencies produce NO waste findings', () => {
    const depInput: DependencyScanResult = {
      rootPath: '/project',
      manifestFound: true,
      manifestType: 'package.json',
      dependencies: [
        { name: 'express', requestedVersion: '^4.18.2', dependencyType: 'production' },
        { name: 'typescript', requestedVersion: '^5.0.0', dependencyType: 'development' },
      ],
      installedDependencies: [
        { name: 'express', version: '4.18.2', path: '/project/node_modules/express' },
        { name: 'typescript', version: '5.0.4', path: '/project/node_modules/typescript' },
      ],
      totalDependencies: 2,
      totalInstalledDependencies: 2,
      nodeModulesPresent: true,
      truncated: false,
    };

    const result = analyzer.analyze({ dependencies: depInput });
    expect(result.findings.length).toBe(0);
    expect(result.totalFindings).toBe(0);
  });

  // 14. large arbitrary file does not become waste
  it('14. large arbitrary file does not become waste solely due to large sizeBytes', () => {
    const filesInput: FileScanResult = {
      rootPath: '/data',
      entries: [
        {
          path: '/data/database_backup.sql',
          relativePath: 'database_backup.sql',
          type: 'file',
          sizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB
          modifiedAt: '2026-09-01T12:00:00Z',
          extension: '.sql',
        },
        {
          path: '/data/main_application.bin',
          relativePath: 'main_application.bin',
          type: 'file',
          sizeBytes: 500 * 1024 * 1024,
          modifiedAt: '2026-09-10T12:00:00Z',
          extension: '.bin',
        },
      ],
      totalEntries: 2,
      truncated: false,
    };

    const result = analyzer.analyze({ files: filesInput });
    expect(result.findings.length).toBe(0);
  });

  // 15. deterministic finding IDs
  it('15. deterministic finding IDs: produces identical IDs across separate runs', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 12345,
            entryCount: 10,
            detectedBy: '.npm',
          },
        ],
        totalCacheSizeBytes: 12345,
        totalCacheEntries: 10,
        truncated: false,
      },
    };

    const result1 = analyzer.analyze(input, { now: '2026-09-25T10:00:00.000Z' });
    const result2 = analyzer.analyze(input, { now: '2026-09-25T11:00:00.000Z' });

    expect(result1.findings[0].id).toBe(result2.findings[0].id);
    expect(result1.findings[0].id).toMatch(/^fn-[a-f0-9]{16}$/);
  });

  // 16. same input produces same findings
  it('16. same input produces same findings: complete deterministic output reproduction', () => {
    const input: AnalyzerInput = {
      git: {
        rootPath: '/repo',
        isRepository: true,
        gitDirectory: '/repo/.git',
        gitDirectoryType: 'directory',
        branch: 'main',
        head: 'abc',
        repositorySizeBytes: 1000,
        truncated: false,
      },
      cache: {
        rootPath: '/repo',
        caches: [
          {
            path: '/repo/.next/cache',
            relativePath: '.next/cache',
            type: 'next',
            sizeBytes: 5000,
            entryCount: 5,
            detectedBy: '.next/cache',
          },
        ],
        totalCacheSizeBytes: 5000,
        totalCacheEntries: 5,
        truncated: false,
      },
    };

    const result1 = analyzer.analyze(input, { now: fixedDate });
    const result2 = analyzer.analyze(input, { now: fixedDate });

    expect(result1).toEqual(result2);
  });

  // 17. overlapping cache sizes
  it('17. overlapping cache sizes: nested sub-cache is not double counted in totalBytes', () => {
    const cacheInput: CacheScanResult = {
      rootPath: '/app',
      caches: [
        {
          path: '/app/.next/cache',
          relativePath: '.next/cache',
          type: 'next',
          sizeBytes: 1000,
          entryCount: 10,
          detectedBy: '.next/cache',
        },
        {
          path: '/app/.next/cache/webpack',
          relativePath: '.next/cache/webpack',
          type: 'generic',
          sizeBytes: 400,
          entryCount: 4,
          detectedBy: 'webpack',
        },
      ],
      totalCacheSizeBytes: 1000,
      totalCacheEntries: 10,
      truncated: false,
    };

    const result = analyzer.analyze({ cache: cacheInput });
    expect(result.findings.length).toBe(2);
    // Should NOT double count 1000 + 400 = 1400; parent /app/.next/cache encompasses /app/.next/cache/webpack
    expect(result.totalBytes).toBe(1000);
  });

  // 18. totalBytes calculation
  it('18. totalBytes calculation: correctly accumulates distinct non-overlapping resources', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 5000,
            entryCount: 1,
            detectedBy: '.npm',
          },
          {
            path: '/app/.gradle/caches',
            relativePath: '.gradle/caches',
            type: 'gradle',
            sizeBytes: 10000,
            entryCount: 1,
            detectedBy: '.gradle',
          },
        ],
        totalCacheSizeBytes: 15000,
        totalCacheEntries: 2,
        truncated: false,
      },
      docker: {
        dockerAvailable: true,
        containers: [],
        images: [
          {
            id: 'img1',
            repository: 'test-repo',
            tag: 'latest',
            createdAt: '2026-09-01',
            sizeBytes: 20000,
            containersUsing: 0,
          },
        ],
        volumes: [],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    // 5000 (npm) + 10000 (gradle) + 20000 (docker image) = 35000
    expect(result.totalBytes).toBe(35000);
  });

  // 19. risk counters
  it('19. risk counters: accurately tallies low, medium, high, and critical risk findings', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          }, // low
          {
            path: '/app/cache',
            relativePath: 'cache',
            type: 'generic',
            sizeBytes: 200,
            entryCount: 1,
            detectedBy: 'cache',
          }, // medium
        ],
        totalCacheSizeBytes: 300,
        totalCacheEntries: 2,
        truncated: false,
      },
      docker: {
        dockerAvailable: true,
        containers: [],
        images: [],
        volumes: [
          {
            name: 'critical_orphan_data',
            driver: 'local',
            containerCount: 0,
          }, // high risk
        ],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    expect(result.lowRiskCount).toBe(1);
    expect(result.mediumRiskCount).toBe(1);
    expect(result.highRiskCount).toBe(1);
    expect(result.criticalRiskCount).toBe(0);
    expect(result.totalFindings).toBe(3);
  });

  // 20. sourceSummary
  it('20. sourceSummary: accurately categorizes findings count by scanner source', () => {
    const input: AnalyzerInput = {
      git: {
        rootPath: '/app',
        isRepository: true,
        gitDirectory: '/app/.git',
        gitDirectoryType: 'directory',
        repositorySizeBytes: 500,
        truncated: false,
      },
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          },
        ],
        totalCacheSizeBytes: 100,
        totalCacheEntries: 1,
        truncated: false,
      },
      docker: {
        dockerAvailable: true,
        containers: [],
        images: [
          {
            id: 'img1',
            repository: 'r',
            tag: 't',
            createdAt: '2026-09-01',
            sizeBytes: 50,
            containersUsing: 0,
          },
          {
            id: 'img2',
            repository: 'r2',
            tag: 't2',
            createdAt: '2026-09-01',
            sizeBytes: 60,
            containersUsing: 0,
          },
        ],
        volumes: [],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    expect(result.sourceSummary).toEqual({
      files: 0,
      git: 1,
      dependencies: 0,
      cache: 1,
      docker: 2,
    });
  });

  // 21. scanner warning propagation
  it('21. scanner warning propagation: preserves Docker unavailable and truncation warnings', () => {
    const input: AnalyzerInput = {
      docker: {
        dockerAvailable: false,
        containers: [],
        images: [],
        volumes: [],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: ['Docker daemon unavailable: connect: no such file or directory'],
        truncated: false,
      },
      cache: {
        rootPath: '/app',
        caches: [],
        totalCacheSizeBytes: 0,
        totalCacheEntries: 0,
        truncated: true,
      },
    };

    const result = analyzer.analyze(input);
    expect(result.warnings).toContain(
      'Docker daemon unavailable: connect: no such file or directory',
    );
    expect(result.warnings).toContain('Cache scan results were truncated due to limits.');
  });

  // 22. missing scanner sections
  it('22. missing scanner sections: gracefully accepts any partial combination of inputs', () => {
    // Only git
    const gitOnly = analyzer.analyze({
      git: {
        rootPath: '/app',
        isRepository: false,
        gitDirectory: '',
        gitDirectoryType: 'directory',
        truncated: false,
      },
    });
    expect(gitOnly.totalFindings).toBe(0);

    // Only files
    const filesOnly = analyzer.analyze({
      files: {
        rootPath: '/app',
        entries: [],
        totalEntries: 0,
        truncated: false,
      },
    });
    expect(filesOnly.totalFindings).toBe(0);
  });

  // 23. confidence values
  it('23. confidence values: all findings report confidence in the valid [0, 1] range', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.next/cache',
            relativePath: '.next/cache',
            type: 'next',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.next',
          },
          {
            path: '/app/.cache',
            relativePath: '.cache',
            type: 'generic',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.cache',
          },
        ],
        totalCacheSizeBytes: 200,
        totalCacheEntries: 2,
        truncated: false,
      },
      git: {
        rootPath: '/app',
        isRepository: true,
        gitDirectory: '/app/.git',
        gitDirectoryType: 'directory',
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    for (const finding of result.findings) {
      expect(finding.confidence).toBeGreaterThanOrEqual(0);
      expect(finding.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  // 24. recommendation values
  it('24. recommendation values: all findings use valid recommendations (review, retain, or investigate)', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          },
          {
            path: '/app/cache',
            relativePath: 'cache',
            type: 'generic',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: 'cache',
          },
        ],
        totalCacheSizeBytes: 200,
        totalCacheEntries: 2,
        truncated: false,
      },
      git: {
        rootPath: '/app',
        isRepository: true,
        gitDirectory: '/app/.git',
        gitDirectoryType: 'directory',
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    const validRecs = new Set(['review', 'retain', 'investigate']);
    for (const finding of result.findings) {
      expect(validRecs.has(finding.recommendation)).toBe(true);
    }
  });

  // 25. no destructive recommendation exists
  it('25. no destructive recommendation exists: no finding has recommendation "delete"', () => {
    const input: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          },
        ],
        totalCacheSizeBytes: 100,
        totalCacheEntries: 1,
        truncated: false,
      },
      docker: {
        dockerAvailable: true,
        containers: [
          {
            id: 'c1',
            name: 'stopped-c',
            image: 'img',
            imageId: 'img-id',
            state: 'exited',
            status: 'exited',
            createdAt: '2026-09-01',
            ports: '',
            mounts: '',
            candidateForReview: true,
          },
        ],
        images: [
          {
            id: 'img1',
            repository: 'r',
            tag: 't',
            createdAt: '2026-09-01',
            sizeBytes: 100,
            containersUsing: 0,
            candidateForReview: true,
          },
        ],
        volumes: [
          {
            name: 'v1',
            driver: 'local',
            containerCount: 0,
            candidateForReview: true,
          },
        ],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
    };

    const result = analyzer.analyze(input);
    for (const finding of result.findings) {
      expect(finding.recommendation as string).not.toBe('delete');
      expect(finding.recommendation as string).not.toBe('prune');
      expect(finding.recommendation as string).not.toBe('remove');
    }
  });

  // 26. no filesystem mutation
  it('26. no filesystem mutation: analyzing never modifies or writes to the filesystem', async () => {
    const testDir = path.resolve('./tests/fixtures');
    const beforeFiles = fs.existsSync(testDir) ? fs.readdirSync(testDir) : [];

    analyzer.analyze({
      cache: {
        rootPath: testDir,
        caches: [
          {
            path: path.join(testDir, '.npm'),
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          },
        ],
        totalCacheSizeBytes: 100,
        totalCacheEntries: 1,
        truncated: false,
      },
    });

    const afterFiles = fs.existsSync(testDir) ? fs.readdirSync(testDir) : [];
    expect(afterFiles).toEqual(beforeFiles);
  });

  // 27. no Docker command execution
  it('27. no Docker command execution: Analyzer has no child_process or Docker execution dependencies', async () => {
    const analyzerFile = path.resolve('src/analyzer/Analyzer.ts');
    const riskFile = path.resolve('src/analyzer/risk.ts');
    const content = fs.readFileSync(analyzerFile, 'utf8') + fs.readFileSync(riskFile, 'utf8');

    expect(content).not.toContain('child_process');
    expect(content).not.toContain('exec(');
    expect(content).not.toContain('execFile');
    expect(content).not.toContain('spawn(');
    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker rm');
    expect(content).not.toContain('docker stop');
  });

  // 28. deterministic ordering of findings
  it('28. deterministic ordering of findings: findings are sorted stably across multiple invocations', () => {
    const input: AnalyzerInput = {
      docker: {
        dockerAvailable: true,
        containers: [
          {
            id: 'c2',
            name: 'beta-container',
            image: 'img',
            imageId: 'img2',
            state: 'exited',
            status: 'exited',
            createdAt: '2026-09-01',
            ports: '',
            mounts: '',
          },
          {
            id: 'c1',
            name: 'alpha-container',
            image: 'img',
            imageId: 'img1',
            state: 'exited',
            status: 'exited',
            createdAt: '2026-09-01',
            ports: '',
            mounts: '',
          },
        ],
        images: [],
        volumes: [],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.npm',
            relativePath: '.npm',
            type: 'npm',
            sizeBytes: 100,
            entryCount: 1,
            detectedBy: '.npm',
          },
        ],
        totalCacheSizeBytes: 100,
        totalCacheEntries: 1,
        truncated: false,
      },
    };

    const resA = analyzer.analyze(input, { now: fixedDate });
    const resB = analyzer.analyze(input, { now: fixedDate });

    const titlesA = resA.findings.map((f) => f.title);
    const titlesB = resB.findings.map((f) => f.title);

    expect(titlesA).toEqual(titlesB);
    // Cache findings (source: 'cache') precede Docker findings (source: 'docker')
    expect(resA.findings[0].source).toBe('cache');
    expect(resA.findings[1].source).toBe('docker');
  });

  // 29. unattached volume precision semantics
  it('29. unattached volume precision semantics: volume with 0 containers is described as unattached with high risk and investigate recommendation', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [],
      volumes: [
        {
          name: 'app_database_vol',
          driver: 'local',
          mountpoint: '/var/lib/docker/volumes/app_database_vol/_data',
          containerCount: 0,
          candidateForReview: true,
        },
      ],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    expect(result.findings.length).toBe(1);
    const volumeFinding = result.findings[0];

    // Must be neutrally labeled as Unattached, NOT unused
    expect(volumeFinding.title).toBe('Unattached Docker Volume (app_database_vol)');
    expect(volumeFinding.title.toLowerCase()).not.toContain('unused');
    expect(volumeFinding.recommendation).toBe('investigate');
    expect(volumeFinding.risk).toBe('high');
    // Confidence 0.95 means high certainty that 0 containers reference it
    expect(volumeFinding.confidence).toBe(0.95);
    expect(volumeFinding.description).toContain('currently has 0 container references');
    expect(volumeFinding.description).toContain('candidate for review');
    expect(volumeFinding.description.toLowerCase()).not.toContain('safe to delete');
    expect(volumeFinding.description.toLowerCase()).not.toContain('definitely unused');
    expect(volumeFinding.description).toContain('not assumed to be disposable');
  });

  // 30. stopped containers are not described as disposable
  it('30. stopped containers are not described as disposable', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [
        {
          id: 'c-stop-1',
          name: 'api-server-legacy',
          image: 'node:18',
          imageId: 'img-18',
          state: 'exited',
          status: 'Exited (137)',
          createdAt: '2026-09-10',
          ports: '',
          mounts: '',
          candidateForReview: true,
        },
      ],
      images: [],
      volumes: [],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    const finding = result.findings[0];
    expect(finding.title).toBe('Stopped Docker Container (api-server-legacy)');
    expect(finding.recommendation).toBe('review');
    expect(finding.description).toContain('candidate for review');
    expect(finding.description.toLowerCase()).not.toContain('safe to delete');
    expect(finding.description.toLowerCase()).not.toContain('definitely unused');
    expect(finding.description).toContain('not assumed to be disposable');
  });

  // 31. unreferenced images are not described as disposable
  it('31. unreferenced images are not described as disposable', () => {
    const dockerInput: DockerScanResult = {
      dockerAvailable: true,
      containers: [],
      images: [
        {
          id: 'img-alpine-1',
          repository: 'alpine',
          tag: '3.19',
          createdAt: '2026-09-01',
          sizeBytes: 7000000,
          containersUsing: 0,
          candidateForReview: true,
        },
      ],
      volumes: [],
      networks: [],
      buildCache: [],
      totalReclaimableBytes: 0,
      warnings: [],
      truncated: false,
    };

    const result = analyzer.analyze({ docker: dockerInput });
    const finding = result.findings[0];
    expect(finding.title).toBe('Unreferenced Docker Image (alpine:3.19)');
    expect(finding.recommendation).toBe('review');
    expect(finding.description).toContain('unreferenced image, candidate for review');
    expect(finding.description.toLowerCase()).not.toContain('safe to delete');
    expect(finding.description.toLowerCase()).not.toContain('definitely unused');
    expect(finding.description).toContain('not assumed to be disposable');
  });

  // 32. no finding across all sources uses prohibited deletion terms
  it('32. no finding across any source uses "safe to delete", "definitely unused", or calls resources disposable', () => {
    const fullInput: AnalyzerInput = {
      cache: {
        rootPath: '/app',
        caches: [
          {
            path: '/app/.next/cache',
            relativePath: '.next/cache',
            type: 'next',
            sizeBytes: 1000,
            entryCount: 5,
            detectedBy: '.next',
          },
          {
            path: '/app/cache',
            relativePath: 'cache',
            type: 'generic',
            sizeBytes: 200,
            entryCount: 2,
            detectedBy: 'cache',
          },
        ],
        totalCacheSizeBytes: 1200,
        totalCacheEntries: 7,
        truncated: false,
      },
      docker: {
        dockerAvailable: true,
        containers: [
          {
            id: 'c1',
            name: 'c',
            image: 'img',
            imageId: 'i',
            state: 'exited',
            status: 'exited',
            createdAt: '2026-09-01',
            ports: '',
            mounts: '',
            candidateForReview: true,
          },
        ],
        images: [
          {
            id: 'i1',
            repository: 'r',
            tag: 't',
            createdAt: '2026-09-01',
            sizeBytes: 100,
            containersUsing: 0,
            candidateForReview: true,
          },
        ],
        volumes: [
          {
            name: 'v1',
            driver: 'local',
            containerCount: 0,
            candidateForReview: true,
          },
        ],
        networks: [
          {
            id: 'n1',
            name: 'custom_net',
            driver: 'bridge',
            scope: 'local',
            internal: false,
            attachable: false,
            containerCount: 0,
            candidateForReview: true,
          },
        ],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [],
        truncated: false,
      },
      git: {
        rootPath: '/app',
        isRepository: true,
        gitDirectory: '/app/.git',
        gitDirectoryType: 'directory',
        repositorySizeBytes: 5000,
        truncated: false,
      },
    };

    const result = analyzer.analyze(fullInput);
    for (const finding of result.findings) {
      const lowerTitle = finding.title.toLowerCase();
      const lowerDesc = finding.description.toLowerCase();

      expect(lowerTitle).not.toContain('safe to delete');
      expect(lowerTitle).not.toContain('definitely unused');
      expect(lowerTitle).not.toContain('disposable');

      expect(lowerDesc).not.toContain('safe to delete');
      expect(lowerDesc).not.toContain('definitely unused');
      // If "disposable" appears, it must be negated (e.g. "not assumed to be disposable")
      if (lowerDesc.includes('disposable')) {
        expect(lowerDesc).toContain('not assumed to be disposable');
      }
    }
  });
});
