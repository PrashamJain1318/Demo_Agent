import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DockerScanner, parseDockerBytes } from '../../src/scanner/docker/DockerScanner.js';
import { IDockerClient } from '../../src/scanner/docker/DockerClient.js';

function createMockDockerClient(overrides?: Partial<IDockerClient>): IDockerClient {
  return {
    checkVersion: vi.fn().mockResolvedValue({ available: true, version: '27.1.0' }),
    listContainers: vi.fn().mockResolvedValue([]),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue([]),
    inspectVolumes: vi.fn().mockResolvedValue([]),
    listNetworks: vi.fn().mockResolvedValue([]),
    inspectNetworks: vi.fn().mockResolvedValue([]),
    getSystemDf: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('DockerScanner', () => {
  describe('Helper: parseDockerBytes', () => {
    it('parses various byte units accurately', () => {
      expect(parseDockerBytes('100B')).toBe(100);
      expect(parseDockerBytes('1.5KB')).toBe(1536);
      expect(parseDockerBytes('10MB')).toBe(10485760);
      expect(parseDockerBytes('2GB')).toBe(2147483648);
      expect(parseDockerBytes('1TB')).toBe(1099511627776);
      expect(parseDockerBytes('800MB (53%)')).toBe(838860800);
      expect(parseDockerBytes(5000)).toBe(5000);
      expect(parseDockerBytes('invalid')).toBe(0);
      expect(parseDockerBytes(null)).toBe(0);
    });
  });

  describe('Scanner Behavior', () => {
    it('1. reports dockerAvailable=true and collects version when Docker is available', async () => {
      const mockClient = createMockDockerClient({
        checkVersion: vi.fn().mockResolvedValue({ available: true, version: '27.1.1' }),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.dockerAvailable).toBe(true);
      expect(result.dockerVersion).toBe('27.1.1');
      expect(result.truncated).toBe(false);
    });

    it('2. safely handles Docker CLI missing (ENOENT) without throwing', async () => {
      const mockClient = createMockDockerClient({
        checkVersion: vi.fn().mockResolvedValue({
          available: false,
          error: 'Docker CLI executable not found in PATH',
        }),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.dockerAvailable).toBe(false);
      expect(result.containers).toEqual([]);
      expect(result.images).toEqual([]);
      expect(result.volumes).toEqual([]);
      expect(result.networks).toEqual([]);
      expect(result.buildCache).toEqual([]);
      expect(result.totalReclaimableBytes).toBe(0);
      expect(result.warnings[0]).toContain('Docker CLI executable not found in PATH');
      expect(result.truncated).toBe(false);
    });

    it('3. safely handles Docker daemon unavailable without throwing', async () => {
      const mockClient = createMockDockerClient({
        checkVersion: vi.fn().mockResolvedValue({
          available: false,
          error: 'Docker daemon is not running or unreachable',
        }),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.dockerAvailable).toBe(false);
      expect(result.warnings[0]).toContain('Docker daemon is not running or unreachable');
    });

    it('4. safely handles command timeout without throwing or crashing', async () => {
      const mockClient = createMockDockerClient({
        checkVersion: vi.fn().mockResolvedValue({
          available: false,
          error: 'Docker version command timed out',
        }),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.dockerAvailable).toBe(false);
      expect(result.warnings[0]).toContain('timed out');
    });

    it('5, 6, 7. parses containers and correctly identifies running vs stopped states', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi.fn().mockResolvedValue([
          {
            ID: 'c1',
            Names: '/web-app',
            Image: 'nginx:latest',
            ImageID: 'sha256:img1',
            State: 'running',
            Status: 'Up 2 hours',
            CreatedAt: '2026-09-01 10:00:00',
            Ports: '0.0.0.0:80->80/tcp',
            Mounts: 'my-vol',
            Size: '15MB',
          },
          {
            ID: 'c2',
            Names: 'worker-job',
            Image: 'node:alpine',
            ImageID: 'sha256:img2',
            State: 'exited',
            Status: 'Exited (0) 5 minutes ago',
            CreatedAt: '2026-09-01 11:00:00',
            Ports: '',
            Mounts: '',
            Size: '5MB',
          },
        ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.containers).toHaveLength(2);

      // Running container
      const running = result.containers.find((c) => c.id === 'c1')!;
      expect(running.name).toBe('web-app');
      expect(running.state).toBe('running');
      expect(running.candidateForReview).toBe(false);
      expect(running.sizeBytes).toBe(15 * 1024 * 1024);

      // Stopped container
      const stopped = result.containers.find((c) => c.id === 'c2')!;
      expect(stopped.name).toBe('worker-job');
      expect(stopped.state).toBe('exited');
      expect(stopped.candidateForReview).toBe(true);
      expect(stopped.sizeBytes).toBe(5 * 1024 * 1024);
    });

    it('8 & 9. parses images and marks images with zero containers as candidateForReview', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi
          .fn()
          .mockResolvedValue([
            { ID: 'c1', Image: 'redis:latest', ImageID: 'sha256:img1', State: 'running' },
          ]),
        listImages: vi.fn().mockResolvedValue([
          {
            ID: 'sha256:img1',
            Repository: 'redis',
            Tag: 'latest',
            CreatedAt: '2026-08-01',
            Size: '100MB',
          },
          {
            ID: 'sha256:img2',
            Repository: 'unused-app',
            Tag: 'v1.0',
            CreatedAt: '2026-08-02',
            Size: '250MB',
          },
        ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.images).toHaveLength(2);

      const inUse = result.images.find((i) => i.id === 'sha256:img1')!;
      expect(inUse.containersUsing).toBe(1);
      expect(inUse.candidateForReview).toBe(false);

      const unused = result.images.find((i) => i.id === 'sha256:img2')!;
      expect(unused.containersUsing).toBe(0);
      expect(unused.candidateForReview).toBe(true);
    });

    it('10 & 11. parses volumes and marks unreferenced volumes as candidateForReview', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi.fn().mockResolvedValue([{ ID: 'c1', Mounts: 'active-data, /host/dir' }]),
        listVolumes: vi.fn().mockResolvedValue([
          { Name: 'active-data', Driver: 'local' },
          { Name: 'orphan-data', Driver: 'local' },
        ]),
        inspectVolumes: vi.fn().mockResolvedValue([
          {
            Name: 'active-data',
            Driver: 'local',
            Mountpoint: '/var/lib/docker/volumes/active-data/_data',
            Scope: 'local',
            Labels: { env: 'prod' },
          },
          {
            Name: 'orphan-data',
            Driver: 'local',
            Mountpoint: '/var/lib/docker/volumes/orphan-data/_data',
            Scope: 'local',
          },
        ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.volumes).toHaveLength(2);

      const active = result.volumes.find((v) => v.name === 'active-data')!;
      expect(active.containerCount).toBe(1);
      expect(active.candidateForReview).toBe(false);
      expect(active.labels).toEqual({ env: 'prod' });

      const orphan = result.volumes.find((v) => v.name === 'orphan-data')!;
      expect(orphan.containerCount).toBe(0);
      expect(orphan.candidateForReview).toBe(true);
    });

    it('12 & 13. parses networks and prevents default/system networks from review candidate flag', async () => {
      const mockClient = createMockDockerClient({
        listNetworks: vi.fn().mockResolvedValue([
          { ID: 'net1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
          { ID: 'net2', Name: 'custom-active', Driver: 'bridge', Scope: 'local' },
          { ID: 'net3', Name: 'custom-unused', Driver: 'bridge', Scope: 'local' },
        ]),
        inspectNetworks: vi.fn().mockResolvedValue([
          { Id: 'net1', Name: 'bridge', Containers: {} },
          { Id: 'net2', Name: 'custom-active', Containers: { c1: {} } },
          { Id: 'net3', Name: 'custom-unused', Containers: {} },
        ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.networks).toHaveLength(3);

      // System network with 0 containers is NOT marked candidate
      const bridge = result.networks.find((n) => n.name === 'bridge')!;
      expect(bridge.candidateForReview).toBe(false);

      // Custom network in use is NOT marked candidate
      const customActive = result.networks.find((n) => n.name === 'custom-active')!;
      expect(customActive.containerCount).toBe(1);
      expect(customActive.candidateForReview).toBe(false);

      // Custom unused network IS marked candidate
      const customUnused = result.networks.find((n) => n.name === 'custom-unused')!;
      expect(customUnused.containerCount).toBe(0);
      expect(customUnused.candidateForReview).toBe(true);
    });

    it('14 & 15. handles build cache with safe warning when per-entry enumeration is unavailable', async () => {
      const mockClient = createMockDockerClient({
        getSystemDf: vi
          .fn()
          .mockResolvedValue([
            { Type: 'Build Cache', TotalCount: '5', Size: '1.2GB', Reclaimable: '1.2GB (100%)' },
          ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.buildCache).toEqual([]);
      expect(
        result.warnings.some((w) => w.includes('build-cache enumeration is unavailable')),
      ).toBe(true);
    });

    it('16, 17, 18, 19, 20. enforces independent limits across all categories and sets truncated flag', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi.fn().mockResolvedValue([{ ID: 'c1' }, { ID: 'c2' }, { ID: 'c3' }]),
        listImages: vi.fn().mockResolvedValue([{ ID: 'img1' }, { ID: 'img2' }]),
        listVolumes: vi.fn().mockResolvedValue([{ Name: 'v1' }, { Name: 'v2' }]),
        listNetworks: vi.fn().mockResolvedValue([{ ID: 'n1' }, { ID: 'n2' }]),
      });

      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan({
        maxContainers: 2,
        maxImages: 10,
        maxVolumes: 10,
        maxNetworks: 10,
      });

      // Only containers truncated
      expect(result.containers).toHaveLength(2);
      expect(result.images).toHaveLength(2);
      expect(result.volumes).toHaveLength(2);
      expect(result.networks).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it('21. sets truncated=false when all categories are within their limits', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi.fn().mockResolvedValue([{ ID: 'c1' }]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan({ maxContainers: 10 });

      expect(result.containers).toHaveLength(1);
      expect(result.truncated).toBe(false);
    });

    it('22 & 23. accurately calculates totalReclaimableBytes strictly from Docker reported values without inventing data', async () => {
      const mockClient = createMockDockerClient({
        getSystemDf: vi.fn().mockResolvedValue([
          { Type: 'Images', TotalCount: '5', Active: '2', Size: '2GB', Reclaimable: '500MB (25%)' },
          {
            Type: 'Containers',
            TotalCount: '4',
            Active: '1',
            Size: '200MB',
            Reclaimable: '100MB (50%)',
          },
          { Type: 'Local Volumes', TotalCount: '3', Active: '1', Size: '1GB', Reclaimable: '0B' },
          { Type: 'Build Cache', TotalCount: '10', Active: '0', Size: '1GB', Reclaimable: '1GB' },
        ]),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      // 500MB + 100MB + 0B + 1GB = 524288000 + 104857600 + 0 + 1073741824 = 1702887424 bytes
      const expected = 500 * 1024 * 1024 + 100 * 1024 * 1024 + 1024 * 1024 * 1024;
      expect(result.totalReclaimableBytes).toBe(expected);
    });

    it('24. produces safe warning when an underlying query encounters a partial error', async () => {
      const mockClient = createMockDockerClient({
        listContainers: vi
          .fn()
          .mockRejectedValue(new Error('Permission denied accessing docker.sock')),
      });
      const scanner = new DockerScanner(mockClient);
      const result = await scanner.scan();

      expect(result.dockerAvailable).toBe(true);
      expect(result.containers).toEqual([]);
      expect(
        result.warnings.some((w) => w.includes('Permission denied accessing docker.sock')),
      ).toBe(true);
    });

    it('25. validates options and rejects non-positive limit inputs', async () => {
      const scanner = new DockerScanner(createMockDockerClient());
      await expect(scanner.scan({ maxContainers: 0 })).rejects.toThrow(
        /maxContainers must be a positive integer/,
      );
      await expect(scanner.scan({ maxImages: -5 })).rejects.toThrow(
        /maxImages must be a positive integer/,
      );
    });
  });

  describe('Security Audit: No Mutation or Dangerous Execution', () => {
    it('verifies implementation files contain zero prohibited Docker mutating commands or shell execution APIs', () => {
      const dockerFiles = [
        path.resolve(__dirname, '../../src/scanner/docker/DockerScanner.ts'),
        path.resolve(__dirname, '../../src/scanner/docker/DockerClient.ts'),
        path.resolve(__dirname, '../../src/types/docker.ts'),
      ];

      const forbiddenTokens = [
        'docker rm',
        'docker rmi',
        'docker volume rm',
        'docker system prune',
        'docker builder prune',
        'docker stop',
        'docker kill',
        'docker restart',
        'docker exec',
        'docker run',
        'docker build',
        'docker pull',
        'docker push',
        'child_process.exec(',
        'childProcess.exec(',
        'child_process.spawn(',
        'childProcess.spawn(',
        'shell: true',
      ];

      for (const filePath of dockerFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const token of forbiddenTokens) {
          expect(content.includes(token)).toBe(false);
        }
      }
    });
  });
});
