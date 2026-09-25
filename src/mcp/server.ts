import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FileScanner } from '../scanner/files/FileScanner.js';
import { GitScanner } from '../scanner/git/GitScanner.js';
import { DependencyScanner } from '../scanner/dependencies/DependencyScanner.js';
import { CacheScanner } from '../scanner/cache/CacheScanner.js';
import { DockerScanner } from '../scanner/docker/DockerScanner.js';
import { Analyzer } from '../analyzer/Analyzer.js';
import { CleanupPlanner } from '../cleanup/planner/CleanupPlanner.js';
import { ApprovalGate } from '../cleanup/approval/ApprovalGate.js';
import { QuarantineExecutor } from '../cleanup/quarantine/QuarantineExecutor.js';
import { QuarantineVerifier } from '../cleanup/quarantine/QuarantineVerifier.js';
import { QuarantineRestorer } from '../cleanup/quarantine/QuarantineRestorer.js';
import { DeletionGate } from '../cleanup/deletion/DeletionGate.js';
import { DeletionExecutor } from '../cleanup/deletion/DeletionExecutor.js';
import type { AnalyzerInput, AnalyzerResult } from '../types/analyzer.js';
import type { CleanupPlan } from '../types/cleanup.js';
import type { ApprovalRequest, ApprovedExecutionPayload } from '../types/approval.js';
import type { QuarantineManifest } from '../types/quarantine.js';
import type { VerificationReport } from '../types/verification.js';
import type { DeletionRequest, ValidatedDeletionPayload } from '../types/deletion.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'Digital Janitor',
    version: '0.1.0',
  });

  // =========================================================================
  // HEALTH CHECK
  // =========================================================================

  server.registerTool(
    'health_check',
    { description: 'Returns the health status of the Digital Janitor MCP server.' },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'ok',
                service: 'digital-janitor-mcp',
                version: '0.1.0',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // =========================================================================
  // READ-ONLY SCANNER TOOLS
  // =========================================================================

  server.registerTool(
    'scan_files',
    {
      description:
        'Performs a safe, read-only filesystem discovery scan under the specified root directory.',
      inputSchema: {
        rootPath: z.string().describe('The root directory path to scan'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Maximum directory depth to recurse (default: 3)'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of entries to return (default: 500)'),
      },
    },
    async (args) => {
      try {
        const scanner = new FileScanner();
        const result = await scanner.scan({
          rootPath: args.rootPath,
          maxDepth: args.maxDepth,
          maxResults: args.maxResults,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.registerTool(
    'scan_git_repository',
    {
      description:
        'Performs a safe, read-only inspection of a Git repository, collecting branch, commit, and object storage metrics.',
      inputSchema: {
        rootPath: z.string().describe('The root directory containing the Git repository to scan'),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of Git directory entries to inspect (default: 10000)'),
      },
    },
    async (args) => {
      try {
        const scanner = new GitScanner();
        const result = await scanner.scan({
          rootPath: args.rootPath,
          maxEntries: args.maxEntries,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.registerTool(
    'scan_dependencies',
    {
      description:
        'Performs a safe, read-only inspection of Node.js project dependencies declared in package.json and installed in node_modules.',
      inputSchema: {
        rootPath: z.string().describe('The root directory containing package.json to scan'),
        maxDependencies: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of declared dependency records to discover (default: 1000)'),
        maxInstalledDependencies: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Maximum number of installed node_modules packages to discover (default: 1000)',
          ),
      },
    },
    async (args) => {
      try {
        const scanner = new DependencyScanner();
        const result = await scanner.scan({
          rootPath: args.rootPath,
          maxDependencies: args.maxDependencies,
          maxInstalledDependencies: args.maxInstalledDependencies,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.registerTool(
    'scan_cache',
    {
      description:
        'Performs a safe, read-only discovery scan for common application, package manager, and framework cache directories.',
      inputSchema: {
        rootPath: z.string().describe('The root directory path to scan for caches'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Maximum directory depth to recurse (default: 6)'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of cache entries to return (default: 100)'),
      },
    },
    async (args) => {
      try {
        const scanner = new CacheScanner();
        const result = await scanner.scan({
          rootPath: args.rootPath,
          maxDepth: args.maxDepth,
          maxResults: args.maxResults,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.registerTool(
    'scan_docker',
    {
      description:
        'Performs a safe, read-only inventory of Docker containers, images, volumes, networks, and build cache.',
      inputSchema: {
        includeStopped: z
          .boolean()
          .optional()
          .describe('Include stopped containers in scan (default: true)'),
        maxContainers: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of container records to return (default: 100)'),
        maxImages: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of image records to return (default: 100)'),
        maxVolumes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of volume records to return (default: 100)'),
        maxNetworks: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of network records to return (default: 100)'),
        maxBuildCacheEntries: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of build cache records to return (default: 100)'),
      },
    },
    async (args) => {
      try {
        const scanner = new DockerScanner();
        const result = await scanner.scan({
          includeStopped: args.includeStopped,
          maxContainers: args.maxContainers,
          maxImages: args.maxImages,
          maxVolumes: args.maxVolumes,
          maxNetworks: args.maxNetworks,
          maxBuildCacheEntries: args.maxBuildCacheEntries,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // ANALYSIS TOOL
  // =========================================================================

  server.registerTool(
    'analyze_cleanup',
    {
      description:
        'Analyzes scan results (files, git, dependencies, cache, docker) to generate structured, deterministic findings with conservative recommendations and risk assessments. Read-only analysis; performs zero mutations.',
      inputSchema: {
        files: z.record(z.string(), z.unknown()).optional().describe('FileScanner result object'),
        git: z.record(z.string(), z.unknown()).optional().describe('GitScanner result object'),
        dependencies: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('DependencyScanner result object'),
        cache: z.record(z.string(), z.unknown()).optional().describe('CacheScanner result object'),
        docker: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('DockerScanner result object'),
      },
    },
    async (args) => {
      try {
        const analyzer = new Analyzer();
        const input: AnalyzerInput = {
          files: args.files as AnalyzerInput['files'],
          git: args.git as AnalyzerInput['git'],
          dependencies: args.dependencies as AnalyzerInput['dependencies'],
          cache: args.cache as AnalyzerInput['cache'],
          docker: args.docker as AnalyzerInput['docker'],
        };
        const result = analyzer.analyze(input);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // PLANNING TOOL
  // =========================================================================

  server.registerTool(
    'create_cleanup_plan',
    {
      description:
        'Transforms structured analyzer findings into a proposed cleanup plan. Distinguishes proposed actions from blocked items (e.g. Git metadata, Docker volumes, protected system paths). Does not execute or approve any action; every proposed action enforces mandatory approval.',
      inputSchema: {
        analyzerResult: z
          .object({
            findings: z.array(z.record(z.string(), z.unknown())),
            totalFindings: z.number(),
            totalBytes: z.number(),
            lowRiskCount: z.number(),
            mediumRiskCount: z.number(),
            highRiskCount: z.number(),
            criticalRiskCount: z.number(),
            sourceSummary: z.record(z.string(), z.number()),
            warnings: z.array(z.string()),
          })
          .passthrough()
          .describe('AnalyzerResult object produced by analyze_cleanup'),
        includeLowRisk: z
          .boolean()
          .optional()
          .describe('Include low risk findings (default: true)'),
        includeMediumRisk: z
          .boolean()
          .optional()
          .describe('Include medium risk findings (default: true)'),
        includeHighRisk: z
          .boolean()
          .optional()
          .describe('Include high risk findings (default: false)'),
        includeCriticalRisk: z
          .boolean()
          .optional()
          .describe('Include critical risk findings (default: false)'),
      },
    },
    async (args) => {
      try {
        const planner = new CleanupPlanner();
        const plan = planner.plan(args.analyzerResult as unknown as AnalyzerResult, {
          includeLowRisk: args.includeLowRisk,
          includeMediumRisk: args.includeMediumRisk,
          includeHighRisk: args.includeHighRisk,
          includeCriticalRisk: args.includeCriticalRisk,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // APPROVAL TOOL
  // =========================================================================

  server.registerTool(
    'evaluate_cleanup_approval',
    {
      description:
        'Evaluates an explicit approval request against a proposed cleanup plan. Enforces risk policy (high/critical risk rejected by default), preserves planner blocked items, validates plan ID, and produces an ApprovedExecutionPayload for approved items. Pure, read-only approval gate.',
      inputSchema: {
        plan: z
          .object({
            id: z.string(),
            createdAt: z.string(),
            findingsAnalyzed: z.number(),
            actions: z.array(z.record(z.string(), z.unknown())),
            totalEstimatedBytes: z.number(),
            requiresHumanApproval: z.boolean(),
            warnings: z.array(z.string()),
            blockedActions: z.array(z.record(z.string(), z.unknown())),
          })
          .passthrough()
          .describe('Proposed CleanupPlan object'),
        request: z
          .object({
            planId: z.string(),
            actionIds: z.array(z.string()),
            decision: z.enum(['approved', 'rejected']),
            requestedAt: z.string(),
            requestedBy: z.string().optional(),
            reason: z.string().optional(),
          })
          .describe('Explicit ApprovalRequest object with specific action IDs and decision'),
        allowHighRisk: z.boolean().optional().describe('Allow high risk actions (default: false)'),
        allowCriticalRisk: z
          .boolean()
          .optional()
          .describe('Allow critical risk actions (default: false)'),
      },
    },
    async (args) => {
      try {
        const gate = new ApprovalGate();
        const result = gate.evaluate(
          args.plan as unknown as CleanupPlan,
          args.request as unknown as ApprovalRequest,
          {
            allowHighRisk: args.allowHighRisk,
            allowCriticalRisk: args.allowCriticalRisk,
          },
        );

        let payload: ApprovedExecutionPayload | undefined;
        if (result.decision === 'approved' && result.approvedActionIds.length > 0) {
          payload = gate.createExecutionPayload(args.plan as unknown as CleanupPlan, result);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ result, executionPayload: payload }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // QUARANTINE TOOL
  // =========================================================================

  server.registerTool(
    'quarantine_approved',
    {
      description:
        'Moves explicitly approved file and directory cleanup actions into an isolated quarantine vault. Requires an ApprovedExecutionPayload from evaluate_cleanup_approval (strictly rejects unapproved plans or raw paths). Refuses Docker actions, symlinks, protected system paths, and path traversals. Controlled safe relocation only; permanent deletion is NOT performed.',
      inputSchema: {
        payload: z
          .object({
            planId: z.string(),
            approvedAt: z.string(),
            approvedBy: z.string().optional(),
            approvedActions: z.array(z.record(z.string(), z.unknown())),
          })
          .passthrough()
          .describe(
            'ApprovedExecutionPayload produced by evaluate_cleanup_approval. Raw CleanupPlan is strictly rejected.',
          ),
        quarantineRoot: z.string().describe('Target quarantine vault directory path'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Dry run mode: validate without moving files (default: false)'),
      },
    },
    async (args) => {
      try {
        const executor = new QuarantineExecutor();
        const manifest = await executor.execute(
          args.payload as unknown as ApprovedExecutionPayload,
          {
            quarantineRoot: args.quarantineRoot,
            dryRun: args.dryRun,
          },
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // VERIFICATION TOOL
  // =========================================================================

  server.registerTool(
    'verify_quarantine',
    {
      description:
        'Performs safe, read-only verification of items recorded in a QuarantineManifest against their current quarantine state. Calculates streamed SHA-256 hashes and deterministic directory trees to detect modified, missing, or intact items. Read-only; performs zero mutations or deletions.',
      inputSchema: {
        manifest: z
          .object({
            manifestId: z.string(),
            createdAt: z.string(),
            items: z.array(z.record(z.string(), z.unknown())),
            successfulCount: z.number(),
            failedCount: z.number(),
            skippedCount: z.number(),
          })
          .passthrough()
          .describe('QuarantineManifest object to verify'),
        quarantineRoot: z
          .string()
          .optional()
          .describe('Expected quarantine root directory path for boundary validation'),
      },
    },
    async (args) => {
      try {
        const verifier = new QuarantineVerifier();
        const report = await verifier.verify(args.manifest as unknown as QuarantineManifest, {
          quarantineRoot: args.quarantineRoot,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // RESTORE TOOL
  // =========================================================================

  server.registerTool(
    'restore_quarantine',
    {
      description:
        'Restores explicitly specified action IDs from a valid QuarantineManifest back to their original filesystem locations. Strictly prevents overwriting existing destination files, rejects symlinks and protected paths, and executes post-restore integrity verification. Does not delete any file.',
      inputSchema: {
        manifest: z
          .object({
            manifestId: z.string(),
            createdAt: z.string(),
            items: z.array(z.record(z.string(), z.unknown())),
            successfulCount: z.number(),
            failedCount: z.number(),
            skippedCount: z.number(),
          })
          .passthrough()
          .describe('Valid QuarantineManifest object'),
        actionIds: z.array(z.string()).min(1).describe('Explicit list of action IDs to restore'),
        quarantineRoot: z
          .string()
          .describe('Quarantine root directory path containing the quarantined items'),
      },
    },
    async (args) => {
      try {
        const restorer = new QuarantineRestorer();
        const report = await restorer.restore(
          args.manifest as unknown as QuarantineManifest,
          args.actionIds,
          { quarantineRoot: args.quarantineRoot },
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // DELETION APPROVAL TOOL
  // =========================================================================

  server.registerTool(
    'evaluate_deletion',
    {
      description:
        'Pure, side-effect free final deletion gate. Evaluates a QuarantineManifest, VerificationReport, and DeletionRequest to determine if items are eligible for permanent deletion. Requires explicit approval, matching manifest IDs, and that latest verification status is intact with matching hashes. Read-only gate; performs zero deletion.',
      inputSchema: {
        manifest: z
          .object({
            manifestId: z.string(),
            createdAt: z.string(),
            items: z.array(z.record(z.string(), z.unknown())),
            successfulCount: z.number(),
            failedCount: z.number(),
            skippedCount: z.number(),
          })
          .passthrough()
          .describe('QuarantineManifest object'),
        verification: z
          .object({
            manifestId: z.string(),
            verifiedAt: z.string(),
            status: z.string(),
            items: z.array(z.record(z.string(), z.unknown())),
            intactCount: z.number(),
            missingCount: z.number(),
            modifiedCount: z.number(),
            inaccessibleCount: z.number(),
            invalidCount: z.number(),
          })
          .passthrough()
          .describe('VerificationReport object (must be intact for requested items)'),
        request: z
          .object({
            manifestId: z.string(),
            actionIds: z.array(z.string()).min(1),
            decision: z.enum(['approved', 'rejected']),
            requestedAt: z.string(),
            requestedBy: z.string().optional(),
            reason: z.string().optional(),
          })
          .describe('Explicit final DeletionRequest object'),
        quarantineRoot: z
          .string()
          .optional()
          .describe('Quarantine vault directory path for boundary verification'),
      },
    },
    async (args) => {
      try {
        const gate = new DeletionGate();
        const payload = gate.evaluate(
          args.manifest as unknown as QuarantineManifest,
          args.verification as unknown as VerificationReport,
          args.request as unknown as DeletionRequest,
          { quarantineRoot: args.quarantineRoot },
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  // =========================================================================
  // DELETION TOOL
  // =========================================================================

  server.registerTool(
    'delete_verified',
    {
      description:
        'Permanently deletes explicitly verified and approved quarantine items using Node filesystem APIs (unlink for files, rm for directories). Requires a ValidatedDeletionPayload from evaluate_deletion (strictly rejects raw plans, manifests, or arbitrary paths). Performs a mandatory last-moment SHA-256 integrity check immediately before deletion to prevent race-condition deletions. Operates strictly inside quarantineRoot; refuses Docker actions, symlinks, and protected paths.',
      inputSchema: {
        payload: z
          .object({
            manifestId: z.string(),
            decision: z.enum(['approved', 'rejected']),
            approvedActionIds: z.array(z.string()),
            rejectedActionIds: z.array(z.string()),
            eligibleItems: z.array(z.record(z.string(), z.unknown())),
            rejectionReasons: z.record(z.string(), z.string()),
            validatedAt: z.string(),
            requestedBy: z.string().optional(),
          })
          .passthrough()
          .describe(
            'ValidatedDeletionPayload produced by evaluate_deletion. Raw plans or unvalidated manifests are strictly rejected.',
          ),
        quarantineRoot: z.string().describe('Quarantine vault root directory path'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Dry run mode: validate without deleting files (default: false)'),
      },
    },
    async (args) => {
      try {
        const executor = new DeletionExecutor();
        const report = await executor.execute(args.payload as unknown as ValidatedDeletionPayload, {
          quarantineRoot: args.quarantineRoot,
          dryRun: args.dryRun,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  return server;
}
