import {
  DockerContainer,
  DockerImage,
  DockerVolume,
  DockerNetwork,
  DockerBuildCache,
  DockerScanOptions,
  DockerScanResult,
} from '../../types/docker.js';
import { IDockerClient, DockerClient } from './DockerClient.js';

/**
 * Safely parses human-readable Docker byte sizes (e.g. "800MB (53%)", "1.5GB", "500kB", "100B")
 * into numeric integer bytes.
 */
export function parseDockerBytes(sizeStr: unknown): number {
  if (typeof sizeStr === 'number') {
    return Number.isFinite(sizeStr) && sizeStr >= 0 ? Math.round(sizeStr) : 0;
  }
  if (typeof sizeStr !== 'string') {
    return 0;
  }
  const match = sizeStr.trim().match(/^([0-9.]+)\s*([a-zA-Z]+)?/);
  if (!match) {
    return 0;
  }
  const num = parseFloat(match[1]);
  if (isNaN(num) || num < 0) {
    return 0;
  }
  const unit = (match[2] || 'B').toUpperCase();
  switch (unit) {
    case 'B':
      return Math.round(num);
    case 'KB':
    case 'KIB':
    case 'K':
      return Math.round(num * 1024);
    case 'MB':
    case 'MIB':
    case 'M':
      return Math.round(num * 1024 * 1024);
    case 'GB':
    case 'GIB':
    case 'G':
      return Math.round(num * 1024 * 1024 * 1024);
    case 'TB':
    case 'TIB':
    case 'T':
      return Math.round(num * 1024 * 1024 * 1024 * 1024);
    default:
      return Math.round(num);
  }
}

/**
 * DockerScanner performs a safe, read-only inventory of Docker containers, images,
 * volumes, networks, and build cache.
 *
 * Safety guarantees:
 * - Read-only: Never stops, removes, prunes, modifies, or creates Docker resources.
 * - Non-fatal: Safely reports when the Docker CLI or daemon is unavailable.
 * - Resource isolation: Independent limits for containers, images, volumes, networks, and cache.
 * - Unsupported estimates avoided: Reclaimable storage is strictly derived from values explicitly reported by Docker.
 */
export class DockerScanner {
  private readonly client: IDockerClient;
  private readonly defaultLimits = {
    maxContainers: 100,
    maxImages: 100,
    maxVolumes: 100,
    maxNetworks: 100,
    maxBuildCacheEntries: 100,
  };

  constructor(client?: IDockerClient) {
    this.client = client ?? new DockerClient();
  }

  /**
   * Scans Docker resources and produces a structured inventory.
   *
   * @param options Configuration for resource limits and inclusion flags.
   * @returns Structured scan result with warnings and truncation status.
   */
  async scan(options?: DockerScanOptions): Promise<DockerScanResult> {
    const maxContainers = this.validateLimit(
      options?.maxContainers,
      this.defaultLimits.maxContainers,
      'maxContainers',
    );
    const maxImages = this.validateLimit(
      options?.maxImages,
      this.defaultLimits.maxImages,
      'maxImages',
    );
    const maxVolumes = this.validateLimit(
      options?.maxVolumes,
      this.defaultLimits.maxVolumes,
      'maxVolumes',
    );
    const maxNetworks = this.validateLimit(
      options?.maxNetworks,
      this.defaultLimits.maxNetworks,
      'maxNetworks',
    );
    const maxBuildCacheEntries = this.validateLimit(
      options?.maxBuildCacheEntries,
      this.defaultLimits.maxBuildCacheEntries,
      'maxBuildCacheEntries',
    );
    const includeStopped = options?.includeStopped ?? true;

    // 1. Determine Docker availability
    const versionCheck = await this.client.checkVersion();
    if (!versionCheck.available) {
      return {
        dockerAvailable: false,
        dockerVersion: versionCheck.version,
        containers: [],
        images: [],
        volumes: [],
        networks: [],
        buildCache: [],
        totalReclaimableBytes: 0,
        warnings: [versionCheck.error || 'Docker is unavailable on this system'],
        truncated: false,
      };
    }

    const warnings: string[] = [];
    let truncated = false;

    // 2. Query Containers
    let rawContainers: Array<Record<string, unknown>> = [];
    try {
      rawContainers = await this.client.listContainers(includeStopped);
    } catch (err) {
      warnings.push(
        `Failed to list containers: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const containersTruncated = rawContainers.length > maxContainers;
    if (containersTruncated) {
      truncated = true;
    }
    const selectedContainers = rawContainers.slice(0, maxContainers);

    const containers: DockerContainer[] = selectedContainers.map((item) => {
      const state = String(item.State || item.Status || 'unknown').toLowerCase();
      const isRunning = state.startsWith('up') || state === 'running';
      return {
        id: String(item.ID || item.Id || ''),
        name: String(item.Names || item.Name || '').replace(/^\//, ''),
        image: String(item.Image || ''),
        imageId: String(item.ImageID || item.ImageId || ''),
        state: String(item.State || 'unknown'),
        status: String(item.Status || ''),
        createdAt: String(item.CreatedAt || ''),
        ports: String(item.Ports || ''),
        mounts: String(item.Mounts || ''),
        sizeBytes: item.Size ? parseDockerBytes(item.Size) : undefined,
        candidateForReview: !isRunning,
      };
    });

    // 3. Query Images
    let rawImages: Array<Record<string, unknown>> = [];
    try {
      rawImages = await this.client.listImages();
    } catch (err) {
      warnings.push(`Failed to list images: ${err instanceof Error ? err.message : String(err)}`);
    }

    const imagesTruncated = rawImages.length > maxImages;
    if (imagesTruncated) {
      truncated = true;
    }
    const selectedImages = rawImages.slice(0, maxImages);

    const images: DockerImage[] = selectedImages.map((img) => {
      const imgId = String(img.ID || img.Id || '');
      const repository = String(img.Repository || '<none>');
      const tag = String(img.Tag || '<none>');
      const fullRepoTag = repository !== '<none>' && tag !== '<none>' ? `${repository}:${tag}` : '';

      // Count containers referencing this image
      const containersUsing = rawContainers.filter((c) => {
        const cImgId = String(c.ImageID || c.ImageId || '');
        const cImg = String(c.Image || '');
        return (
          (imgId && (cImgId.startsWith(imgId) || imgId.startsWith(cImgId))) ||
          (fullRepoTag && cImg === fullRepoTag) ||
          cImg === repository
        );
      }).length;

      return {
        id: imgId,
        repository,
        tag,
        createdAt: String(img.CreatedAt || ''),
        sizeBytes: parseDockerBytes(img.Size),
        containersUsing,
        candidateForReview: containersUsing === 0,
      };
    });

    // 4. Query Volumes
    let rawVolumes: Array<Record<string, unknown>> = [];
    try {
      rawVolumes = await this.client.listVolumes();
    } catch (err) {
      warnings.push(`Failed to list volumes: ${err instanceof Error ? err.message : String(err)}`);
    }

    const volumesTruncated = rawVolumes.length > maxVolumes;
    if (volumesTruncated) {
      truncated = true;
    }
    const selectedVolumes = rawVolumes.slice(0, maxVolumes);
    const volumeNames = selectedVolumes.map((v) => String(v.Name || v.name || '')).filter(Boolean);

    let inspectedVolumes: Array<Record<string, unknown>> = [];
    if (volumeNames.length > 0) {
      try {
        inspectedVolumes = await this.client.inspectVolumes(volumeNames);
      } catch {
        // Fall back to basic listing metadata
      }
    }
    const inspectedVolumeMap = new Map<string, Record<string, unknown>>();
    for (const iv of inspectedVolumes) {
      if (iv.Name) {
        inspectedVolumeMap.set(String(iv.Name), iv);
      }
    }

    const volumes: DockerVolume[] = selectedVolumes.map((v) => {
      const name = String(v.Name || v.name || '');
      const inspected = inspectedVolumeMap.get(name);
      const driver = String(inspected?.Driver || v.Driver || v.driver || 'local');
      const mountpoint =
        inspected?.Mountpoint || v.Mountpoint || v.mountpoint
          ? String(inspected?.Mountpoint || v.Mountpoint || v.mountpoint)
          : undefined;
      const scope =
        inspected?.Scope || v.Scope || v.scope
          ? String(inspected?.Scope || v.Scope || v.scope)
          : undefined;
      const createdAt =
        inspected?.CreatedAt || v.CreatedAt
          ? String(inspected?.CreatedAt || v.CreatedAt)
          : undefined;
      const labels =
        inspected?.Labels && typeof inspected.Labels === 'object'
          ? (inspected.Labels as Record<string, string>)
          : undefined;

      // Count containers referencing this volume in their mounts
      const containerCount = rawContainers.filter((c) => {
        const mountsStr = String(c.Mounts || '');
        return mountsStr
          .split(',')
          .map((m) => m.trim())
          .includes(name);
      }).length;

      return {
        name,
        driver,
        mountpoint,
        scope,
        createdAt,
        labels,
        containerCount,
        candidateForReview: containerCount === 0,
      };
    });

    // 5. Query Networks
    let rawNetworks: Array<Record<string, unknown>> = [];
    try {
      rawNetworks = await this.client.listNetworks();
    } catch (err) {
      warnings.push(`Failed to list networks: ${err instanceof Error ? err.message : String(err)}`);
    }

    const networksTruncated = rawNetworks.length > maxNetworks;
    if (networksTruncated) {
      truncated = true;
    }
    const selectedNetworks = rawNetworks.slice(0, maxNetworks);
    const networkIds = selectedNetworks.map((n) => String(n.ID || n.Id || '')).filter(Boolean);

    let inspectedNetworks: Array<Record<string, unknown>> = [];
    if (networkIds.length > 0) {
      try {
        inspectedNetworks = await this.client.inspectNetworks(networkIds);
      } catch {
        // Fall back to basic listing metadata
      }
    }
    const inspectedNetworkMap = new Map<string, Record<string, unknown>>();
    for (const inNet of inspectedNetworks) {
      if (inNet.Id || inNet.ID) {
        inspectedNetworkMap.set(String(inNet.Id || inNet.ID), inNet);
      }
    }

    const systemNetworkNames = new Set(['bridge', 'host', 'none']);

    const networks: DockerNetwork[] = selectedNetworks.map((net) => {
      const id = String(net.ID || net.Id || '');
      const name = String(net.Name || net.name || '');
      const inspected = inspectedNetworkMap.get(id);
      const driver = String(inspected?.Driver || net.Driver || net.driver || 'bridge');
      const scope = String(inspected?.Scope || net.Scope || net.scope || 'local');
      const internal = Boolean(inspected?.Internal ?? net.Internal ?? false);
      const attachable = Boolean(inspected?.Attachable ?? net.Attachable ?? false);

      let containerCount = 0;
      if (inspected && inspected.Containers && typeof inspected.Containers === 'object') {
        containerCount = Object.keys(inspected.Containers).length;
      }

      const isSystemNetwork = systemNetworkNames.has(name.toLowerCase());
      return {
        id,
        name,
        driver,
        scope,
        internal,
        attachable,
        containerCount,
        candidateForReview: !isSystemNetwork && containerCount === 0,
      };
    });

    // 6. Query Build Cache & Total Reclaimable Bytes via docker system df
    let totalReclaimableBytes = 0;
    try {
      const dfRows = await this.client.getSystemDf();
      for (const row of dfRows) {
        if (row.Reclaimable) {
          totalReclaimableBytes += parseDockerBytes(row.Reclaimable);
        }
      }
    } catch {
      // Reclaimable calculation fallback to 0 if system df fails
    }

    // Detail build cache enumeration is typically unavailable without builder inspection
    const rawBuildCache: DockerBuildCache[] = [];
    if (rawBuildCache.length > maxBuildCacheEntries) {
      truncated = true;
    }
    const buildCache: DockerBuildCache[] = rawBuildCache.slice(0, maxBuildCacheEntries);
    warnings.push(
      'Detailed per-entry build-cache enumeration is unavailable; aggregate reclaimable usage is reflected in totalReclaimableBytes.',
    );

    return {
      dockerAvailable: true,
      dockerVersion: versionCheck.version,
      containers,
      images,
      volumes,
      networks,
      buildCache,
      totalReclaimableBytes,
      warnings,
      truncated,
    };
  }

  private validateLimit(limit: number | undefined, defaultValue: number, name: string): number {
    if (limit === undefined) return defaultValue;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`${name} must be a positive integer (> 0)`);
    }
    return limit;
  }
}
