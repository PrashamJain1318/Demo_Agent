# Digital Janitor

Digital Janitor is an automated maintenance and hygiene framework designed to scan repositories, clean build artifacts, prune orphaned cache/docker storage, verify dependencies, and safely manage storage with human-in-the-loop approval workflows.

## Current Project Status

- **Status**: Minimal MCP Server Phase
- **MCP Server Implementation**: **Basic Streamable HTTP endpoint implemented**
- **TrueForge Integration**: **NOT started yet**
- **TrueFoundry Integration**: **NOT started yet**
- **Business Logic / Cleanups**: **NOT started yet**

The repository currently contains the TypeScript foundation, directory skeleton, strict type configuration, linting, formatting, and testing harness.

## Architecture

The target architecture is structured around modular domains:

```
digital-janitor/
├── src/
│   ├── config/          # Configuration and environment loaders
│   ├── mcp/             # MCP tools, resources, and prompts
│   │   ├── tools/
│   │   ├── resources/
│   │   └── prompts/
│   ├── scanner/         # Scanners (files, git, docker, dependencies, cache)
│   ├── analyzer/        # Space and dependency analyzers
│   ├── cleanup/         # Planners, quarantine managers, executors, verifiers
│   ├── safety/          # Safety policies and approval gates
│   ├── types/           # Shared TypeScript interfaces & domain schemas
│   └── utils/           # Shared utilities
├── tests/
│   ├── unit/            # Unit test suite
│   ├── integration/     # Integration test suite
│   └── fixtures/        # Mock fixtures
├── docs/                # Architecture documentation
└── dist/                # Compiled JavaScript output
```

## Getting Started

### Prerequisites

- Node.js (v20+ recommended)
- npm

### Installation

```bash
npm install
```

### Development Scripts

- **Type Check**:
  ```bash
  npm run typecheck
  ```
- **Run Tests**:
  ```bash
  npm test
  ```
- **Run Tests in Watch Mode**:
  ```bash
  npm run test:watch
  ```
- **Build**:
  ```bash
  npm run build
  ```
- **Lint**:
  ```bash
  npm run lint
  ```
- **Format Code**:
  ```bash
  npm run format
  ```
- **Check Formatting**:
  ```bash
  npm run format:check
  ```

### Running the Server

To start the development server with live reload:

```bash
npm run dev
```

To run the production build:

```bash
npm run build
npm start
```

**Default port**: `8000` (can be changed via `PORT` environment variable).
**MCP Endpoint**: `POST /mcp`

The server exposes one simple diagnostic tool named `health_check` which returns `{ "status": "ok", "service": "digital-janitor-mcp", "version": "0.1.0" }`.

#### Testing the Server

You can send a basic MCP initialization request via `curl`:

```bash
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl-test", "version": "1.0" }
    }
  }'
```

### Cache Scanner

Digital Janitor includes a dedicated, safe, read-only cache discovery scanner exposed through the `scan_cache` MCP tool.

- **Purpose**: Discovers and inspects standard cache directories created by package managers, build systems, frameworks, and operating systems.
- **Safety**: Strictly read-only. It inspects metadata, counts entries, and measures byte usage. It does NOT delete, unlink, clean up, or mutate any files or directories.
- **Supported Cache Types**:
  - `npm`: `.npm` cache directory
  - `pnpm`: `.pnpm-store` content-addressable store
  - `yarn`: `.yarn/cache` package cache
  - `python`: `__pycache__` compiled bytecode cache directories
  - `next`: `.next/cache` Next.js build and page cache
  - `vite`: `node_modules/.vite` pre-bundled dependency cache
  - `gradle`: `.gradle/caches` dependency and build cache
  - `macos`: `Library/Caches` user application cache (detected when scanning a user home directory)
  - `generic`: generic cache directories explicitly named `cache`, `caches`, or `.cache`
- **Configurable Limits**:
  - `maxDepth`: Maximum recursion depth (default: `6`, must be a non-negative integer).
  - `maxResults`: Maximum number of cache entry records returned (default: `100`, must be a positive integer). If reached, `truncated` is set to `true`.
- **Double-Counting Prevention**: Nested caches (e.g. an inner cache located inside an outer cache) are tracked individually in `caches`, while `totalCacheSizeBytes` and `totalCacheEntries` are calculated only from top-level non-overlapping cache roots to prevent double-counting.
- **Cleanup Status**: No cleanup or pruning is performed. This scanner is strictly diagnostic and analytical.

### Docker Scanner

Digital Janitor includes a safe, read-only Docker inventory scanner exposed through the `scan_docker` MCP tool.

The Docker Scanner does not remove, stop, prune, modify, or execute commands inside Docker resources.

- **Read-Only Docker Inventory**: Scans and catalogs existing Docker resources on the host system without making any modifications.
- **Resources Discovered**:
  - **Containers**: Discovers running and stopped containers (identifying stopped containers neutrally as candidates for review).
  - **Images**: Inventories repository, tag, size, and container associations (identifying unused images as candidates for review).
  - **Volumes**: Discovers driver/volume records and references without mounting volumes or accessing files within them.
  - **Networks**: Catalogs network names, drivers, scopes, and attached container counts, while preserving default system networks.
  - **Build Cache**: Reads build cache storage metrics via read-only system summary commands without pruning.
- **Docker Unavailable Handling**: Gracefully detects when the Docker CLI is missing or the Docker daemon is unreachable. It returns a structured result with `dockerAvailable: false` and explanatory warnings rather than failing or exposing raw errors.
- **Timeout Protection**: All direct Docker CLI invocations enforce a strict 10-second timeout per command with safe process termination, preventing hanging commands.
- **Independent Limits**:
  - `maxContainers` (default: 100)
  - `maxImages` (default: 100)
  - `maxVolumes` (default: 100)
  - `maxNetworks` (default: 100)
  - `maxBuildCacheEntries` (default: 100)
    Limits operate independently across categories, setting `truncated: true` if any threshold is reached.
- **Reclaimable Storage**: Reports `totalReclaimableBytes` based strictly on explicit values reported by Docker CLI summaries (`docker system df`), without guessing or assuming all unused resources can be reclaimed.

### Analyzer

Digital Janitor includes an intelligence and normalization layer implemented by the `Analyzer` class.

The Analyzer consumes raw results produced by scanners and converts them into normalized, deterministic findings.

#### Pipeline Architecture

```text
SCAN
  ↓
ANALYZE (Digital Janitor Step 8 stops here)
  ↓
PLAN
  ↓
APPROVAL
  ↓
QUARANTINE
  ↓
VERIFY
  ↓
DELETE
```

**IMPORTANT**: Step 8 stops strictly at **ANALYZE**. The Analyzer does not remove, move, modify, or quarantine anything. No cleanup plans or delete actions are created, and no human approval or TrueForge connections are invoked.

#### Key Principles

- **Scanners Collect Evidence**: Scanners (`FileScanner`, `GitScanner`, `DependencyScanner`, `CacheScanner`, `DockerScanner`) collect raw factual metadata from the host environment.
- **Analyzer Normalizes Evidence**: The Analyzer synthesizes these raw inputs into structured findings with standardized categories (`cache`, `build-artifact`, `docker`, `repository`, `dependency`, `stale`).
- **Risk Levels**:
  - `low`: Known regenerable build caches, active running containers, and essential repository metadata.
  - `medium`: Inactive stopped containers, unreferenced container images, custom unattached networks, or generic caches.
  - `high`: Unattached Docker volumes (which may contain unbacked persistent data).
  - `critical`: Extremely rare, requiring explicit unambiguous evidence.
- **Classification Confidence**: A value between `0.0` and `1.0` representing certainty in the category classification and evidence detection (e.g. `0.95` confidence that no containers currently reference a volume), NOT a likelihood of disposability or safe deletion.
- **Conservative Recommendations**:
  - `review`: Resource is a candidate for operator review.
  - `retain`: Resource is required system or version control infrastructure (e.g. `.git`, system networks).
  - `investigate`: Ambiguity exists (e.g. generic cache, unattached volume, or manifest inconsistency).
  - _No destructive recommendations (such as `delete` or `prune`) exist in this layer._
- **Deterministic Findings and IDs**: Finding IDs are generated via SHA-256 hashes of `source:category:target:title`. The same input will always produce identical findings and IDs, independent of execution time or random numbers.
- **Storage Accounting**: `totalBytes` is calculated deterministically without double-counting nested directories or overlapping cache paths.
- **MCP Status**: The Analyzer operates as an internal library service during Step 8 to prevent coupling scanner execution or transporting complex nested schemas over MCP before the planning layer is implemented.

_Note: Explicitly, real cleanup functionality does not exist yet. No filesystem deletion, docker commands, or dependency changes are performed. TrueForge has not been connected yet._
