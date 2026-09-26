# Digital Janitor

Digital Janitor is an automated maintenance and hygiene framework designed to scan repositories, clean build artifacts, prune orphaned cache/docker storage, verify dependencies, and safely manage storage with human-in-the-loop approval workflows.

🏗️ Architecture
                    ┌──────────────────────┐
                    │       TrueForge      │
                    │      AI Agent        │
                    └──────────┬───────────┘
                               │
                               │ MCP
                               ▼
                    ┌──────────────────────┐
                    │   Digital Janitor    │
                    │      MCP Server      │
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
      File Scanner       GitHub Auditor     Docker Scanner
             │                 │                 │
             └─────────────────┼─────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │       Analyzer       │
                    │ Deterministic Rules  │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │   Cleanup Planner    │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │    Human Approval    │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │      Quarantine      │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │     Verification     │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │    Deletion Gate     │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Permanent Deletion   │
                    └──────────────────────┘
🧰 Technology Stack
Layer	Technology
AI Agent Runtime	TrueForge
Agent Tool Protocol	MCP
Language	TypeScript
Runtime	Node.js
MCP Transport	Streamable HTTP
Validation	Zod
Testing	Vitest
GitHub	GitHub REST / Git Trees API
Hashing	SHA-256
Docker	Read-only Docker adapter
🔧 TrueForge Integration

Digital Janitor exposes a read-only TrueForge MCP profile.

The profile contains exactly 9 tools:

#	Tool	Purpose
1	health_check	Service health
2	scan_files	Filesystem scanning
3	scan_git_repository	Git analysis
4	scan_dependencies	Dependency analysis
5	scan_cache	Cache detection
6	scan_docker	Docker inspection
7	analyze_cleanup	Finding analysis
8	create_cleanup_plan	Cleanup planning
9	audit_target	Unified audit entry point

The dangerous execution layer is intentionally separated from the TrueForge read-only profile.

These tools remain excluded:

evaluate_cleanup_approval
quarantine_approved
verify_quarantine
restore_quarantine
evaluate_deletion
delete_verified

The finalized project test suite verifies the 9-tool profile and the exclusion of the six dangerous tools.

🛡️ Safety Architecture

Digital Janitor is designed around least privilege.

1. Read-only investigation

Scanning does not modify the environment.

2. Deterministic analysis

The analyzer produces structured findings instead of allowing the LLM to directly decide what to delete.

3. Cleanup planning

The planner converts findings into explicit proposed actions.

4. Human approval

Destructive actions require explicit human approval.

5. Quarantine

Filesystem cleanup moves approved items into a quarantine area before permanent deletion.

6. Verification

Quarantined items are verified using hashes.

7. Restore

Items can be restored if required.

8. Deletion Gate

Permanent deletion requires the safety conditions to be satisfied immediately before deletion.

📦 Project Structure
Digital Janitor/
│
├── src/
│   ├── audit/
│   │   ├── AuditTargetService.ts
│   │   └── github/
│   │
│   ├── analyzer/
│   │
│   ├── cleanup/
│   │
│   ├── config/
│   │   └── trueforge.ts
│   │
│   ├── scanner/
│   │   ├── cache/
│   │   ├── dependencies/
│   │   ├── docker/
│   │   ├── files/
│   │   └── git/
│   │
│   ├── types/
│   │
│   ├── mcp/
│   │   ├── http.ts
│   │   └── server.ts
│   │
│   └── index.ts
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
⚙️ Installation
Prerequisites
Node.js
npm
Git
Docker — optional
TrueForge — for agent integration

Install dependencies:

npm install
▶️ Run Digital Janitor

Start the MCP server using the configured project command.

The MCP endpoint is:

http://localhost:8000/mcp

For the TrueForge read-only profile:

MCP_PROFILE=trueforge-read-only
🔌 Connect to TrueForge

Create an MCP connector:

Name:
digital-janitor

URL:
http://localhost:8000/mcp

Authentication:
None

After connecting, verify that TrueForge detects:

9 tools

including:

audit_target
🧪 Testing

Digital Janitor includes tests covering:

File Scanner
Git Scanner
Dependency Scanner
Cache Scanner
Docker Scanner
Analyzer
Cleanup Planner
Approval Gate
Quarantine Executor
Quarantine Verification
Restore
Deletion Gate
MCP Client Integration
TrueForge Integration
Unified Audit

The finalized validation reported:

Test Files: 23 passed
Tests:      356 passed

and TypeScript validation completed successfully with:

tsc --noEmit
Exit code: 0

🎬 Hackathon Demo

A strong demo can be completed in a few steps.

Step 1 — Give Digital Janitor a target
Audit this directory:

/Users/<user>/Projects/my-project
Step 2 — Agent investigates

TrueForge calls:

audit_target
Step 3 — Show the evidence

Display:

Findings
Evidence
Confidence
Severity
Estimated storage impact
Warnings
Limitations
Step 4 — Generate a cleanup plan
create_cleanup_plan
Step 5 — Human approval

The user reviews and approves selected actions.

Step 6 — Quarantine

Approved filesystem changes are moved into quarantine.

Step 7 — Verify

Digital Janitor verifies the quarantined items.

Step 8 — Restore or delete

The user can demonstrate restoration or proceed through the final deletion safety gate.

🧠 Design Philosophy
Investigate before acting

Digital Janitor doesn't immediately modify the environment.

Evidence before confidence

Every meaningful finding should explain why it was detected.

Reversible before irreversible

Quarantine comes before permanent deletion.

Human before destructive AI

The AI can investigate, analyze, and propose.

The human makes the final destructive decision.

🌟 What Makes Digital Janitor Different?

Traditional cleanup:

Pattern → Delete

Digital Janitor:

Target
  ↓
Investigate
  ↓
Collect Evidence
  ↓
Analyze
  ↓
Estimate Impact
  ↓
Create Plan
  ↓
Human Approval
  ↓
Quarantine
  ↓
Verify
  ↓
Delete

The goal isn't simply to delete more.

The goal is to clean intelligently without losing control.

🛣️ Future Roadmap

Potential extensions:

Cloud resource waste detection
CI/CD cleanup
IDE workspace cleanup
Dependency graph analysis
Scheduled audits
Historical cleanup reports
Team-level digital waste dashboards
Additional Git hosting providers
Organization-wide cleanup policies
👥 Team
Digital Janitor

Built for the TrueFoundry × Polaris Hackathon.

🎤 One-Line Pitch

Digital Janitor is an AI-powered, evidence-driven cleanup agent that investigates digital waste, explains what it finds, and prepares safe cleanup actions while keeping irreversible decisions under human control.

❤️ Built with

TrueForge • MCP • TypeScript • Node.js • GitHub • Docker • Vites

Demo Images of Agent

<img width="1600" height="1041" alt="PHOTO-2026-09-26-18-00-32" src="https://github.com/user-attachments/assets/3df5923d-7bda-417e-8470-d569c3deb845" />
