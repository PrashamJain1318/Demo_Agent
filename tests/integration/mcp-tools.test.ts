import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../../src/mcp/http.js';
import type { CleanupPlan } from '../../src/types/cleanup.js';
import type { ApprovalResult, ApprovedExecutionPayload } from '../../src/types/approval.js';
import type { QuarantineManifest } from '../../src/types/quarantine.js';
import type { VerificationReport } from '../../src/types/verification.js';
import type { ValidatedDeletionPayload } from '../../src/types/deletion.js';

describe('MCP Tools Orchestration Layer Integration Tests (Step 14)', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let tempDir: string;
  let quarantineDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dj-mcp-tools-test-'));
    quarantineDir = path.join(tempDir, 'quarantine-vault');
    await fs.mkdir(quarantineDir, { recursive: true });

    server = await createHttpServer(0);
    const addr = server.address() as AddressInfo;
    serverPort = addr.port;
    serverUrl = `http://localhost:${serverPort}/mcp`;

    client = new Client({ name: 'mcp-tools-test-client', version: '0.1.0' }, { capabilities: {} });
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1-12: TOOL REGISTRATION AUDIT & NEGATIVE TOOL INVENTORY
  // =========================================================================

  it('1-9. lists all expected read-only, analysis, planning, approval, quarantine, verification, restore, and deletion tools', async () => {
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    // 1. Read-only scanner tools
    expect(toolNames).toContain('scan_files');
    expect(toolNames).toContain('scan_git_repository');
    expect(toolNames).toContain('scan_dependencies');
    expect(toolNames).toContain('scan_cache');
    expect(toolNames).toContain('scan_docker');

    // 2. Analysis tool
    expect(toolNames).toContain('analyze_cleanup');

    // 3. Planning tool
    expect(toolNames).toContain('create_cleanup_plan');

    // 4. Approval tool
    expect(toolNames).toContain('evaluate_cleanup_approval');

    // 5. Quarantine tool
    expect(toolNames).toContain('quarantine_approved');

    // 6. Verification tool
    expect(toolNames).toContain('verify_quarantine');

    // 7. Restore tool
    expect(toolNames).toContain('restore_quarantine');

    // 8. Deletion evaluation tool
    expect(toolNames).toContain('evaluate_deletion');

    // 9. Deletion tool
    expect(toolNames).toContain('delete_verified');

    // Plus base health check
    expect(toolNames).toContain('health_check');
  });

  it('10. verifies arbitrary delete tools are NOT listed', async () => {
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    expect(toolNames).not.toContain('delete');
    expect(toolNames).not.toContain('delete_file');
    expect(toolNames).not.toContain('delete_all');
    expect(toolNames).not.toContain('force_delete');
    expect(toolNames).not.toContain('purge_quarantine');
    expect(toolNames).not.toContain('rm');
    expect(toolNames).not.toContain('unlink');
  });

  it('11. verifies shell execution tools are NOT listed', async () => {
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    expect(toolNames).not.toContain('execute_shell');
    expect(toolNames).not.toContain('run_command');
    expect(toolNames).not.toContain('exec');
    expect(toolNames).not.toContain('spawn');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('sh');
  });

  it('12. verifies generic write_file tools are NOT listed', async () => {
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('read_file');
    expect(toolNames).not.toContain('move_file');
    expect(toolNames).not.toContain('create_file');
    expect(toolNames).not.toContain('edit_file');
  });

  // =========================================================================
  // 13. SCANNER INVOCATION
  // =========================================================================

  it('13. scanner tool invokes correct scanner and returns structured output', async () => {
    const testFile = path.join(tempDir, 'test-file.log');
    await fs.writeFile(testFile, 'test log data');

    const res = await client.callTool({
      name: 'scan_files',
      arguments: {
        rootPath: tempDir,
        maxDepth: 2,
        maxResults: 10,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text);
    expect(parsed.rootPath).toBe(path.resolve(tempDir));
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.totalEntries).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // 14. ANALYZER INVOCATION
  // =========================================================================

  it('14. analyzer tool invokes Analyzer and produces structured findings', async () => {
    const res = await client.callTool({
      name: 'analyze_cleanup',
      arguments: {
        cache: {
          rootPath: tempDir,
          scannedAt: new Date().toISOString(),
          caches: [
            {
              type: 'npm',
              path: path.join(tempDir, '.npm'),
              sizeBytes: 4096,
              entryCount: 1,
              description: 'npm cache directory',
              modifiedAt: new Date().toISOString(),
            },
          ],
          totalCacheSizeBytes: 4096,
          totalCacheEntries: 1,
          truncated: false,
          errors: [],
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content[0] as { type: string; text: string };
    const parsed = JSON.parse(content.text);
    expect(parsed.totalFindings).toBe(1);
    expect(parsed.findings[0].category).toBe('cache');
    expect(parsed.findings[0].risk).toBe('low');
  });

  // =========================================================================
  // 15. PLANNER INVOCATION
  // =========================================================================

  it('15. planner tool invokes CleanupPlanner and creates a proposed CleanupPlan', async () => {
    const analyzerResult = {
      findings: [
        {
          id: 'finding-1',
          category: 'cache',
          source: 'cache',
          title: 'NPM Cache Directory',
          description: 'Cache directory created by npm',
          path: path.join(tempDir, '.npm'),
          sizeBytes: 4096,
          risk: 'low',
          confidence: 0.95,
          recommendation: 'review',
          evidence: ['exists'],
          reversible: true,
          detectedAt: new Date().toISOString(),
        },
        {
          id: 'finding-blocked-git',
          category: 'repository',
          source: 'git',
          title: 'Git Repository Metadata',
          description: 'Git repository metadata directory',
          path: path.join(tempDir, '.git'),
          sizeBytes: 1024,
          risk: 'critical',
          confidence: 0.9,
          recommendation: 'retain',
          evidence: ['git'],
          reversible: false,
          detectedAt: new Date().toISOString(),
        },
      ],
      totalFindings: 2,
      totalBytes: 5120,
      lowRiskCount: 1,
      mediumRiskCount: 0,
      highRiskCount: 0,
      criticalRiskCount: 1,
      sourceSummary: { cache: 1, git: 1, files: 0, dependencies: 0, docker: 0 },
      warnings: [],
    };

    const res = await client.callTool({
      name: 'create_cleanup_plan',
      arguments: {
        analyzerResult,
        includeLowRisk: true,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content[0] as { type: string; text: string };
    const plan = JSON.parse(content.text) as CleanupPlan;

    expect(plan.id).toBeDefined();
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].type).toBe('remove-directory');
    expect(plan.requiresHumanApproval).toBe(true);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Git');
  });

  // =========================================================================
  // 16. APPROVAL GATE INVOCATION
  // =========================================================================

  it('16. approval tool invokes ApprovalGate and produces ApprovedExecutionPayload', async () => {
    const dummyActionId = 'act-test-1';
    const plan: CleanupPlan = {
      id: 'plan-test-100',
      createdAt: new Date().toISOString(),
      findingsAnalyzed: 1,
      actions: [
        {
          id: dummyActionId,
          type: 'remove-file',
          target: path.join(tempDir, 'sample-to-clean.tmp'),
          sourceFindingId: 'find-1',
          title: 'Sample clean action',
          reason: 'Safe test cleanup',
          risk: 'low',
          estimatedBytes: 100,
          reversible: true,
          requiresApproval: true,
          prerequisites: [],
          warnings: [],
        },
      ],
      totalEstimatedBytes: 100,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    const request = {
      planId: plan.id,
      actionIds: [dummyActionId],
      decision: 'approved' as const,
      requestedAt: new Date().toISOString(),
      requestedBy: 'operator-1',
      reason: 'Safe test cleanup',
    };

    const res = await client.callTool({
      name: 'evaluate_cleanup_approval',
      arguments: {
        plan,
        request,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content[0] as { type: string; text: string };
    const { result, executionPayload } = JSON.parse(content.text) as {
      result: ApprovalResult;
      executionPayload: ApprovedExecutionPayload;
    };

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual([dummyActionId]);
    expect(executionPayload).toBeDefined();
    expect(executionPayload.planId).toBe(plan.id);
    expect(executionPayload.approvedActions.length).toBe(1);
  });

  // =========================================================================
  // 17. QUARANTINE TOOL REJECTS RAW CLEANUP PLAN
  // =========================================================================

  it('17. quarantine tool rejects raw CleanupPlan directly', async () => {
    const rawPlan: CleanupPlan = {
      id: 'plan-raw',
      createdAt: new Date().toISOString(),
      findingsAnalyzed: 1,
      actions: [],
      totalEstimatedBytes: 0,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    const res = await client.callTool({
      name: 'quarantine_approved',
      arguments: {
        payload: rawPlan as unknown as Record<string, unknown>,
        quarantineRoot: quarantineDir,
      },
    });

    // Should return an error because payload does not conform to ApprovedExecutionPayload schema
    expect(res.isError).toBe(true);
    const content = res.content[0] as { type: string; text: string };
    expect(content.text).toMatch(/error|invalid|approvedActions/i);
  });

  // =========================================================================
  // 18. RESTORE REQUIRES EXPLICIT ACTION IDS
  // =========================================================================

  it('18. restore requires non-empty explicit action IDs', async () => {
    const mockManifest: QuarantineManifest = {
      manifestId: 'manifest-test-1',
      createdAt: new Date().toISOString(),
      items: [],
      successfulCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };

    const res = await client.callTool({
      name: 'restore_quarantine',
      arguments: {
        manifest: mockManifest,
        actionIds: [], // Empty action IDs
        quarantineRoot: quarantineDir,
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content[0] as { type: string; text: string };
    expect(content.text).toMatch(/error|actionIds|at least 1/i);
  });

  // =========================================================================
  // 19. DELETION EVALUATION INVOCATION
  // =========================================================================

  it('19. deletion evaluation invokes DeletionGate and produces ValidatedDeletionPayload', async () => {
    const manifestId = 'manifest-del-test';
    const actionId = 'act-del-1';
    const originalPath = path.join(tempDir, 'original.log');
    const quarantinePath = path.join(quarantineDir, 'item-del-1');
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const manifest: QuarantineManifest = {
      manifestId,
      createdAt: new Date().toISOString(),
      items: [
        {
          actionId,
          sourcePath: originalPath,
          quarantinePath,
          actionType: 'remove-file',
          originalSizeBytes: 0,
          originalSha256: hash,
          status: 'quarantined',
        },
      ],
      successfulCount: 1,
      failedCount: 0,
      skippedCount: 0,
    };

    const verification: VerificationReport = {
      manifestId,
      verifiedAt: new Date().toISOString(),
      status: 'verified',
      items: [
        {
          actionId,
          quarantinePath,
          originalPath,
          status: 'intact',
          expectedHash: hash,
          actualHash: hash,
          expectedSizeBytes: 0,
          actualSizeBytes: 0,
        },
      ],
      intactCount: 1,
      missingCount: 0,
      modifiedCount: 0,
      inaccessibleCount: 0,
      invalidCount: 0,
    };

    const request = {
      manifestId,
      actionIds: [actionId],
      decision: 'approved' as const,
      requestedAt: new Date().toISOString(),
      requestedBy: 'operator-1',
      reason: 'Permanently delete verified item',
    };

    const res = await client.callTool({
      name: 'evaluate_deletion',
      arguments: {
        manifest,
        verification,
        request,
        quarantineRoot: quarantineDir,
      },
    });

    expect(res.isError).toBeFalsy();
    const content = res.content[0] as { type: string; text: string };
    const payload = JSON.parse(content.text) as ValidatedDeletionPayload;

    expect(payload.manifestId).toBe(manifestId);
    expect(payload.decision).toBe('approved');
    expect(payload.approvedActionIds).toEqual([actionId]);
    expect(payload.eligibleItems.length).toBe(1);
  });

  // =========================================================================
  // 20-22: DELETE TOOL SAFETY BOUNDARIES
  // =========================================================================

  it('20. delete tool rejects raw CleanupPlan', async () => {
    const rawPlan: CleanupPlan = {
      id: 'plan-raw',
      createdAt: new Date().toISOString(),
      findingsAnalyzed: 0,
      actions: [],
      totalEstimatedBytes: 0,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
    };

    const res = await client.callTool({
      name: 'delete_verified',
      arguments: {
        payload: rawPlan as unknown as Record<string, unknown>,
        quarantineRoot: quarantineDir,
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content[0] as { type: string; text: string };
    expect(content.text).toMatch(/error|eligibleItems|manifestId/i);
  });

  it('21. delete tool rejects raw ApprovalResult', async () => {
    const approvalResult: ApprovalResult = {
      planId: 'plan-raw',
      decision: 'approved',
      evaluatedAt: new Date().toISOString(),
      approvedActionIds: ['act-1'],
      rejectedActionIds: [],
      rejectionReasons: {},
    };

    const res = await client.callTool({
      name: 'delete_verified',
      arguments: {
        payload: approvalResult as unknown as Record<string, unknown>,
        quarantineRoot: quarantineDir,
      },
    });

    expect(res.isError).toBe(true);
    const content = res.content[0] as { type: string; text: string };
    expect(content.text).toMatch(/error|eligibleItems|manifestId/i);
  });

  it('22. delete tool requires validated deletion payload', async () => {
    // Arbitrary object claiming to be payload
    const invalidPayload = {
      arbitraryField: 'bypass-attempt',
    };

    const res = await client.callTool({
      name: 'delete_verified',
      arguments: {
        payload: invalidPayload as unknown as Record<string, unknown>,
        quarantineRoot: quarantineDir,
      },
    });

    expect(res.isError).toBe(true);
  });

  // =========================================================================
  // 23. SESSION ISOLATION
  // =========================================================================

  it('23. MCP sessions remain strictly isolated', async () => {
    const clientB = new Client(
      { name: 'mcp-isolated-client-b', version: '0.1.0' },
      { capabilities: {} },
    );
    const transportB = new StreamableHTTPClientTransport(new URL(serverUrl));
    await clientB.connect(transportB);

    const [toolsA, toolsB] = await Promise.all([client.listTools(), clientB.listTools()]);
    expect(toolsA.tools.length).toBe(toolsB.tools.length);

    const [resA, resB] = await Promise.all([
      client.callTool({ name: 'health_check', arguments: {} }),
      clientB.callTool({ name: 'health_check', arguments: {} }),
    ]);

    expect((resA.content[0] as { text: string }).text).toBe(
      (resB.content[0] as { text: string }).text,
    );

    await clientB.close();
  });

  // =========================================================================
  // 24. MALFORMED INPUT REJECTED
  // =========================================================================

  it('24. malformed input is strictly rejected by schemas', async () => {
    // Malformed scan_files input (negative depth)
    const res1 = await client.callTool({
      name: 'scan_files',
      arguments: {
        rootPath: tempDir,
        maxDepth: -5,
      },
    });
    expect(res1.isError).toBe(true);

    // Malformed evaluate_cleanup_approval (missing required request decision)
    const res2 = await client.callTool({
      name: 'evaluate_cleanup_approval',
      arguments: {
        plan: {
          id: 'test-p',
          createdAt: '',
          findingsAnalyzed: 0,
          actions: [],
          totalEstimatedBytes: 0,
          requiresHumanApproval: true,
          warnings: [],
          blockedActions: [],
        },
        request: {
          planId: 'test-p',
          actionIds: ['act-1'],
          // missing decision
          requestedAt: '',
        },
      },
    });
    expect(res2.isError).toBe(true);
  });

  // =========================================================================
  // 25. MUTATION TOOLS CANNOT BYPASS SAFETY BOUNDARIES
  // =========================================================================

  it('25. mutation tools enforce safety boundaries and refuse invalid actions', async () => {
    // Attempt quarantine on an action with Docker actionType
    const dockerPayload: ApprovedExecutionPayload = {
      planId: 'plan-docker',
      approvedAt: new Date().toISOString(),
      approvedActions: [
        {
          id: 'act-docker-1',
          type: 'docker-remove-container',
          target: 'container-id-123',
          sourceFindingId: 'f-docker',
          title: 'Remove docker container',
          reason: 'Container unused',
          risk: 'high',
          reversible: false,
          requiresApproval: true,
          prerequisites: [],
          warnings: [],
        },
      ],
    };

    const resQuarantine = await client.callTool({
      name: 'quarantine_approved',
      arguments: {
        payload: dockerPayload,
        quarantineRoot: quarantineDir,
      },
    });

    // QuarantineExecutor rejects non-file/directory actions
    const contentQ = resQuarantine.content[0] as { type: string; text: string };
    const parsedQ = JSON.parse(contentQ.text);
    // Either isError: true or skipped/failed in manifest
    if (resQuarantine.isError) {
      expect(contentQ.text).toMatch(/error|unsupported|not allowed/i);
    } else {
      expect(parsedQ.failedCount + parsedQ.skippedCount).toBeGreaterThan(0);
      expect(parsedQ.successfulCount).toBe(0);
    }

    // Attempt delete_verified on non-existent quarantine path
    const emptyPayload: ValidatedDeletionPayload = {
      manifestId: 'manifest-empty',
      decision: 'approved',
      approvedActionIds: ['act-non-existent'],
      rejectedActionIds: [],
      eligibleItems: [
        {
          actionId: 'act-non-existent',
          originalPath: path.join(tempDir, 'does-not-exist.txt'),
          quarantinePath: path.join(quarantineDir, 'does-not-exist-in-vault.txt'),
          actionType: 'remove-file',
          verifiedSizeBytes: 10,
          verifiedSha256: 'deadbeef',
        },
      ],
      rejectionReasons: {},
      validatedAt: new Date().toISOString(),
    };

    const resDelete = await client.callTool({
      name: 'delete_verified',
      arguments: {
        payload: emptyPayload,
        quarantineRoot: quarantineDir,
      },
    });

    const contentD = resDelete.content[0] as { type: string; text: string };
    const parsedD = JSON.parse(contentD.text);
    // DeletionExecutor checks existence and SHA-256 before deleting; missing item will fail
    expect(parsedD.deletedCount).toBe(0);
    expect(parsedD.failedCount).toBe(1);
    expect(parsedD.items[0].error).toMatch(/ENOENT|missing|not found/i);
  });
});
