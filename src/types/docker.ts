export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  status: string;
  createdAt: string;
  ports: string;
  mounts: string;
  sizeBytes?: number;
  candidateForReview?: boolean;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  createdAt: string;
  sizeBytes: number;
  containersUsing: number;
  candidateForReview?: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint?: string;
  scope?: string;
  createdAt?: string;
  labels?: Record<string, string>;
  containerCount: number;
  candidateForReview?: boolean;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  containerCount: number;
  candidateForReview?: boolean;
}

export interface DockerBuildCache {
  id: string;
  type?: string;
  sizeBytes: number;
  createdAt?: string;
  lastUsedAt?: string;
  usageCount?: number;
  reclaimable?: boolean;
}

export interface DockerScanOptions {
  includeStopped?: boolean;
  maxContainers?: number;
  maxImages?: number;
  maxVolumes?: number;
  maxNetworks?: number;
  maxBuildCacheEntries?: number;
}

export interface DockerScanResult {
  dockerAvailable: boolean;
  dockerVersion?: string;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  buildCache: DockerBuildCache[];
  totalReclaimableBytes: number;
  warnings: string[];
  truncated: boolean;
}
