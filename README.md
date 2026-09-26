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

### Cleanup Planner

Digital Janitor includes a safe, deterministic planning layer implemented by the `CleanupPlanner` class.

The Planner converts `AnalyzerResult` findings into a structured, proposed `CleanupPlan`.

#### Pipeline Architecture

```text
SCAN
  ↓
ANALYZE
  ↓
PLAN (Digital Janitor Step 9 stops here)
  ↓
APPROVAL
  ↓
QUARANTINE
  ↓
VERIFY
  ↓
DELETE
```

**IMPORTANT**: STEP 9 creates plans only. No cleanup action is executed. The Planner does not delete, move, rename, quarantine, or execute anything.

#### Key Principles

- **Proposed Actions Only**: Analyzer findings are converted into proposed actions (`CleanupAction`) specifying the action type (`remove-directory`, `remove-file`, `docker-remove-container`, etc.), target, and estimated storage bytes.
- **Mandatory Human Approval**: Every generated action enforces `requiresApproval: true`, and every plan enforces `requiresHumanApproval: true`. No action is ever pre-approved.
- **Risk Filtering**:
  - `low` risk findings: Included by default.
  - `medium` risk findings: Included by default.
  - `high` risk findings: Excluded by default.
  - `critical` risk findings: Excluded by default.
    Excluded findings are captured in `blockedActions` with clear explanatory reasons.
- **Critical Docker Safety**: Unattached Docker volumes are **never** directly planned for removal in Step 9. Because volumes can contain persistent application databases or critical data, volume findings are strictly routed to `blockedActions` requiring explicit investigation.
- **Protected System and Workspace Infrastructure**:
  - Git repository metadata (`.git`) is strictly protected and blocked.
  - Entire parent roots (`/`, `.git`, `node_modules`) are protected. Specific known cache subdirectories (such as `node_modules/.vite` or `.next/cache`) are eligible.
  - Generic cache directories (`cache`, `caches`, `.cache`) require investigation and are blocked.
  - Running Docker containers, referenced images, and default Docker system networks (`bridge`, `host`, `none`) are blocked.
  - Dependency findings do not generate package removal commands.
- **Deduplication of Overlapping Paths**: If a parent directory cleanup action is planned (e.g. `remove-directory` on `/app/.next/cache`), any nested child actions are deduplicated and routed to `blockedActions` to prevent redundant or conflicting operations.
- **Deterministic Action and Plan IDs**: Action IDs and Plan IDs are calculated via SHA-256 hashes independent of system timestamps.

### Step 10: Approval Gate (Execution Safety Boundary)

The Approval Gate implements a deterministic, pure execution safety boundary between the `CleanupPlanner` and future execution layers (Quarantine, Verify, Delete).

#### Safety Invariant

```
NO APPROVAL -> NO QUARANTINE -> NO DELETE
```

#### Key Architecture & Guarantees

- **Pure and Deterministic**: Operates purely in-memory. Zero filesystem writes, zero shell execution, zero child processes, zero Docker commands, and zero network calls.
- **Explicit Approval Only**: Actions are approved ONLY when explicitly listed in `ApprovalRequest.actionIds` and `decision === "approved"`. Unrequested actions are never automatically approved.
- **Risk Policy Enforcement**:
  - `low` and `medium` risk: Eligible for approval if explicitly requested.
  - `high` risk: Rejected by default unless `allowHighRisk: true`.
  - `critical` risk: Rejected by default unless `allowCriticalRisk: true`.
  - High/critical risk actions are never silently downgraded.
- **Planner Block Invariance**: Any action or source finding previously blocked by the `CleanupPlanner` is strictly blocked and cannot be approved.
- **Plan ID Matching**: `ApprovalRequest.planId` must strictly match `CleanupPlan.id`. Mismatches reject all actions with a structured error.
- **Deduplication & Deterministic Ordering**: Requested action IDs are deduplicated and all output ID lists (`approvedActionIds`, `rejectedActionIds`, `blockedActionIds`) are deterministically sorted.
- **Architectural Boundary Enforcement (`ApprovedExecutionPayload`)**: Future execution layers (Quarantine, Executor) must receive an `ApprovedExecutionPayload` produced via `ApprovalGate.createExecutionPayload(plan, result)`. Executors must never directly receive or execute an unapproved `CleanupPlan`.

### Step 11: Quarantine Executor (Controlled Safe Movement)

The Quarantine Executor performs the first controlled filesystem mutation in the project: moving explicitly approved file and directory cleanup actions into a safe, isolated quarantine directory.

#### Safety Invariants

```
UNAPPROVED ACTION -> NO QUARANTINE -> NO FILESYSTEM MUTATION
QUARANTINE != DELETE
```

#### Key Architecture & Guarantees

- **No Permanent Deletion**: Zero `fs.rm`, zero `fs.unlink`, zero `fs.rmdir`. Only `fs.mkdir` and `fs.rename` into the quarantine vault.
- **Architectural Input Enforcement**: Consumes ONLY `ApprovedExecutionPayload`. The executor strictly rejects raw `CleanupPlan` objects.
- **Supported Action Types**: Only filesystem actions (`remove-file` and `remove-directory`) can be quarantined. Docker actions are skipped/rejected with safe explanatory statuses; Docker resources are never mutated.
- **Protected Paths Enforcement**: Strictly protects root directories (`/`), user home, Desktop, Documents, Downloads, Library, system folders (`/bin`, `/sbin`, `/usr`, `/etc`), `.git` repositories, `node_modules` root directories, and `quarantineRoot` itself.
- **Symlink Protection**: Symlinks are inspected with `lstat` and never followed or moved.
- **Path Traversal Guards**: Verifies all source and destination paths remain within intended boundaries and prevents `..` escapes.
- **Collision Safety**: Uses collision-free, deterministic directory layouts: `<quarantineRoot>/<manifestId>/items/<actionId>/<basename>`. Overwrites are strictly prohibited; collisions result in failed items without data loss.
- **Deterministic Manifest**: Produces a `QuarantineManifest` with a deterministic ID (`quarantine-<hash>`) based on approved actions and the quarantine root, independent of timestamps.
- **Dry-Run Mode**: Supports `dryRun: true` to validate paths and destinations without modifying the filesystem or creating directories.

### Step 12: Quarantine Verification & Restore (Reversible Quarantine)

The Quarantine Verification and Restore layer makes the quarantine subsystem deterministic, verifiable, and completely reversible.

#### Safety Invariants

```
VERIFY != DELETE
RESTORE != DELETE
ONLY A VALID QUARANTINE MANIFEST -> CAN BE VERIFIED / RESTORED
```

#### Key Architecture & Guarantees

- **Read-Only Verifier (`QuarantineVerifier`)**:
  - Verification is strictly read-only: zero file modifications, zero renames, zero directory creations, zero deletions.
  - Consumes ONLY `QuarantineManifest`, rejecting raw plans.
  - Validates manifest integrity: verifies manifest ID, detects duplicate action IDs, guards against path traversals and escaping `quarantineRoot`.
  - Content Hashing: Computes streamed SHA-256 for files and deterministic sorted representations for directories (recursively hashing files without traversing symlinks outside).
  - Categorizes items into `intact`, `modified`, `missing`, `inaccessible`, or `invalid`.
- **Safe Restorer (`QuarantineRestorer`)**:
  - Explicit Action IDs Only: Requires an explicit list of action IDs to restore. Unrequested items are never restored.
  - Never Overwrites Existing Destinations: If the original destination already exists, restore fails safely without overwriting.
  - Protected Path Guards: Blocks restoration to root directories (`/`), user home, Desktop, Documents, Downloads, Library, system folders, Git metadata, `node_modules` root, or inside `quarantineRoot`.
  - Re-creates Missing Parent Directories: Creates only required parent directories for original paths after all validations succeed.
  - Post-Restore Verification: Validates restored content hash and size against recorded quarantine metadata immediately after restoration.
  - Symlink Safety: Refuses to restore if either the quarantine source or the destination is a symbolic link.
  - Zero permanent deletion: Uses only `fs.rename` and `fs.mkdir`. No `fs.rm`, `fs.unlink`, `fs.rmdir`.

### Step 13: Permanent Deletion Safety Boundary

The Permanent Deletion Safety Boundary introduces the final, strictly controlled deletion gate and executor. Permanent deletion is restricted to explicitly verified, intact items residing within the quarantine vault.

#### Critical Safety Invariants

Permanent deletion requires ALL of the following conditions:

1. Valid `QuarantineManifest`
2. Explicit final deletion approval (`decision: "approved"`)
3. Explicit action IDs
4. Item exists in quarantine
5. Item status is "quarantined"
6. Latest verification status is "intact"
7. Verification must correspond to the same manifest
8. Verification must correspond to the same quarantine path
9. No restore has occurred
10. No destination collision exists
11. Protected-path validation passes
12. Action type is filesystem-only (`remove-file` or `remove-directory`)
13. No Docker actions
14. No path traversal
15. No symlink escape
16. Final deletion request matches the verified item exactly

_If ANY condition fails: NO DELETE._

#### Key Architecture & Guarantees

- **Final Delete Approval Gate (`DeletionGate`)**:
  - Pure & Side-Effect Free: Evaluates manifest, verification report, and deletion request without modifying the filesystem.
  - Stale Verification Protection: Verifies that the recorded quarantine hash matches the verified hash.
  - Produces a strongly-typed `ValidatedDeletionPayload` containing only eligible items.
  - Rejects unapproved, missing, modified, inaccessible, invalid, or restored items.
- **Deletion Executor (`DeletionExecutor`)**:
  - Boundary Enforcement: Consumes ONLY `ValidatedDeletionPayload` from `DeletionGate`; refuses raw plans, manifests, or arbitrary file paths.
  - Last-Moment Integrity Check (Race-Safety): Recalculates the SHA-256 hash immediately before deletion and compares against the verified hash. If modified, deletion is aborted.
  - Symlink Safety: Strictly refuses to delete symbolic links.
  - Protected Paths: Protects filesystem roots, user home, system folders, Git metadata, and `quarantineRoot` itself.
  - Deletion APIs: Only Node `fs.promises.unlink` for files and `fs.promises.rm` for directories on verified quarantine paths. Zero shell execution, zero child processes, zero Docker commands.
  - Dry-Run Mode: Supports `dryRun: true` performing complete validation and last-moment hashing without deleting anything.

### Step 14: MCP Orchestration Layer

The MCP Orchestration Layer exposes Digital Janitor's end-to-end capabilities through a safe, typed MCP (Model Context Protocol) interface designed for future TrueForge agent orchestration.

#### Architectural Principles & Safety Invariants

- **Safety Boundary Orchestration (No Bypasses)**:
  - Every MCP tool wraps its corresponding internal application component (`FileScanner`, `GitScanner`, `DependencyScanner`, `CacheScanner`, `DockerScanner`, `Analyzer`, `CleanupPlanner`, `ApprovalGate`, `QuarantineExecutor`, `QuarantineVerifier`, `QuarantineRestorer`, `DeletionGate`, `DeletionExecutor`).
  - No tool implements its own safety logic or bypasses the established safety gates.
- **No Unrestricted Filesystem or Shell Tools**:
  - Does NOT expose arbitrary file or shell tools (`read_file`, `write_file`, `delete_file`, `move_file`, `execute_shell`, `run_command`).
  - Does NOT expose public Docker mutation commands.
- **Strict Input Validation & Typed Schemas**:
  - All tools define comprehensive Zod schemas that reject malformed inputs, arbitrary JSON blobs, path escapes, and unapproved payload structures.
- **No Global or Mutable Approval State**:
  - Per-request validation is strictly enforced; one request cannot implicitly authorize another.
- **Session Isolation**:
  - Maintains per-session MCP server instances and transport isolation over Streamable HTTP (`/mcp`), preventing session crosstalk or "Server already initialized" errors.

#### Exposed MCP Tools

1. **Read-Only Scanners**:
   - `scan_files`: Safe, read-only filesystem discovery scan under a specified root directory.
   - `scan_git_repository`: Safe, read-only Git repository inspection (branch, head, objects, pack metrics).
   - `scan_dependencies`: Safe, read-only Node.js `package.json` and `node_modules` dependency inspection.
   - `scan_cache`: Safe, read-only discovery of application, package manager, and framework caches.
   - `scan_docker`: Safe, read-only inventory of Docker containers, images, volumes, networks, and build cache.
2. **Analysis**:
   - `analyze_cleanup`: Deterministic intelligence layer analyzing scan results and producing structured findings with risk levels.
3. **Planning**:
   - `create_cleanup_plan`: Generates a proposed `CleanupPlan` distinguishing proposed actions from blocked actions (Git metadata, Docker volumes, protected paths).
4. **Approval**:
   - `evaluate_cleanup_approval`: Pure, read-only approval gate validating plan IDs, risk policies, and producing an `ApprovedExecutionPayload`.
5. **Quarantine**:
   - `quarantine_approved`: Moves approved items into the quarantine vault. Strictly consumes `ApprovedExecutionPayload` (rejects raw `CleanupPlan`).
6. **Verification**:
   - `verify_quarantine`: Read-only SHA-256 and directory-tree integrity verification of quarantined items.
7. **Restore**:
   - `restore_quarantine`: Restores explicitly requested action IDs from quarantine back to original locations without overwriting destinations.
8. **Deletion Approval**:
   - `evaluate_deletion`: Pure final deletion gate validating manifest, verification report, and deletion request.
9. **Permanent Deletion**:
   - `delete_verified`: Permanently deletes verified quarantine items with last-moment SHA-256 race-check. Strictly consumes `ValidatedDeletionPayload`.
10. **Diagnostics**:
    - `health_check`: MCP service health probe.

_Note: TrueForge integration has not been connected yet. Step 14 is strictly the local MCP orchestration layer._

Images of my Demo trueforge
<img width="1600" height="1041" alt="image" src="https://github.com/user-attachments/assets/a4acd576-992b-4e37-b7d1-5747bb3b12d3" />
