# Digital Janitor

Digital Janitor is an automated maintenance and hygiene framework designed to scan repositories, clean build artifacts, prune orphaned cache/docker storage, verify dependencies, and safely manage storage with human-in-the-loop approval workflows.

## Current Project Status

- **Status**: Foundation / Scaffolding Phase
- **MCP Server Implementation**: **NOT started yet**
- **TrueForge Integration**: **NOT started yet**
- **TrueFoundry Integration**: **NOT started yet**
- **Business Logic**: **NOT started yet**

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
