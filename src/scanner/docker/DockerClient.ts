import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(childProcess.execFile);

export interface IDockerClient {
  checkVersion(): Promise<{ available: boolean; version?: string; error?: string }>;
  listContainers(all?: boolean): Promise<Array<Record<string, unknown>>>;
  listImages(): Promise<Array<Record<string, unknown>>>;
  listVolumes(): Promise<Array<Record<string, unknown>>>;
  inspectVolumes(names: string[]): Promise<Array<Record<string, unknown>>>;
  listNetworks(): Promise<Array<Record<string, unknown>>>;
  inspectNetworks(ids: string[]): Promise<Array<Record<string, unknown>>>;
  getSystemDf(): Promise<Array<Record<string, unknown>>>;
}

export interface DockerClientOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * DockerClient provides safe, read-only interaction with the Docker CLI using execFile.
 *
 * Safety guarantees:
 * - Uses child_process.execFile exclusively (no shell execution, no shell interpolation).
 * - Only read-only Docker subcommands are permitted (version, ps, images, volume ls/inspect, network ls/inspect, system df).
 * - Enforces strict command timeouts (default 10s) and bounded buffer sizes.
 * - Handles missing Docker CLI or offline daemon gracefully without uncaught exceptions.
 */
export class DockerClient implements IDockerClient {
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options?: DockerClientOptions) {
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
  }

  /**
   * Checks whether the Docker CLI is present and the Docker daemon is responding.
   */
  async checkVersion(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await this.runDocker(['version', '--format', '{{json .}}']);
      const parsed = JSON.parse(stdout);
      if (parsed.Server) {
        return {
          available: true,
          version: parsed.Server.Version || parsed.Client?.Version || 'unknown',
        };
      }
      return {
        available: false,
        version: parsed.Client?.Version,
        error: 'Docker daemon is not running or unreachable',
      };
    } catch (err: unknown) {
      const execErr = err as {
        code?: string | number;
        stderr?: string;
        message?: string;
        killed?: boolean;
      };
      if (execErr.code === 'ENOENT') {
        return {
          available: false,
          error: 'Docker CLI executable not found in PATH',
        };
      }
      if (execErr.killed) {
        return {
          available: false,
          error: 'Docker version command timed out',
        };
      }
      const stderr = (execErr.stderr || execErr.message || '').trim();
      return {
        available: false,
        error: stderr ? `Docker daemon unavailable: ${stderr}` : 'Docker daemon unavailable',
      };
    }
  }

  /**
   * Lists containers in machine-readable JSON format.
   */
  async listContainers(all = true): Promise<Array<Record<string, unknown>>> {
    const args = ['ps', '--format', '{{json .}}', '--no-trunc'];
    if (all) {
      args.splice(1, 0, '-a');
    }
    const { stdout } = await this.runDocker(args);
    return this.parseJsonLines(stdout);
  }

  /**
   * Lists local images in machine-readable JSON format.
   */
  async listImages(): Promise<Array<Record<string, unknown>>> {
    const { stdout } = await this.runDocker(['images', '--format', '{{json .}}', '--no-trunc']);
    return this.parseJsonLines(stdout);
  }

  /**
   * Lists volumes in machine-readable JSON format.
   */
  async listVolumes(): Promise<Array<Record<string, unknown>>> {
    const { stdout } = await this.runDocker(['volume', 'ls', '--format', '{{json .}}']);
    return this.parseJsonLines(stdout);
  }

  /**
   * Inspects specified volumes to gather mountpoint, scope, and labels.
   */
  async inspectVolumes(names: string[]): Promise<Array<Record<string, unknown>>> {
    if (!names || names.length === 0) return [];
    try {
      const { stdout } = await this.runDocker(['volume', 'inspect', ...names]);
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Lists networks in machine-readable JSON format.
   */
  async listNetworks(): Promise<Array<Record<string, unknown>>> {
    const { stdout } = await this.runDocker([
      'network',
      'ls',
      '--format',
      '{{json .}}',
      '--no-trunc',
    ]);
    return this.parseJsonLines(stdout);
  }

  /**
   * Inspects specified networks to retrieve driver options and container memberships.
   */
  async inspectNetworks(ids: string[]): Promise<Array<Record<string, unknown>>> {
    if (!ids || ids.length === 0) return [];
    try {
      const { stdout } = await this.runDocker(['network', 'inspect', ...ids]);
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Gathers Docker disk usage metrics across categories via `docker system df`.
   */
  async getSystemDf(): Promise<Array<Record<string, unknown>>> {
    try {
      const { stdout } = await this.runDocker(['system', 'df', '--format', '{{json .}}']);
      return this.parseJsonLines(stdout);
    } catch {
      return [];
    }
  }

  /**
   * Safe execution wrapper invoking `docker` with an array of arguments via execFile.
   */
  private async runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('docker', args, {
      timeout: this.timeoutMs,
      maxBuffer: this.maxBuffer,
    });
  }

  /**
   * Parses newline-delimited JSON objects emitted by `--format '{{json .}}'`.
   */
  private parseJsonLines(stdout: string): Array<Record<string, unknown>> {
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const results: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && typeof item === 'object') {
          results.push(item);
        }
      } catch {
        // Skip unparseable lines
      }
    }
    return results;
  }
}
