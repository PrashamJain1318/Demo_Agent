import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CleanupPlanner, PLANNER_VERSION } from '../../src/cleanup/planner/CleanupPlanner.js';
import type { AnalyzerFinding, AnalyzerResult } from '../../src/types/analyzer.js';

describe('CleanupPlanner Unit Tests', () => {
  const planner = new CleanupPlanner();
  const fixedNow = '2026-09-25T14:30:00.000Z';

  function createSampleFinding(overrides?: Partial<AnalyzerFinding>): AnalyzerFinding {
    return {
      id: 'fn-test-1',
      source: 'cache',
      category: 'cache',
      title: 'NPM Cache (.npm)',
      description: 'Package manager cache',
      path: '/app/.npm',
      sizeBytes: 50000,
      risk: 'low',
      confidence: 0.9,
      recommendation: 'review',
      evidence: ['Cache type: npm'],
      reversible: true,
      detectedAt: fixedNow,
      ...overrides,
    };
  }

  function createSampleResult(
    findings: AnalyzerFinding[],
    warnings: string[] = [],
  ): AnalyzerResult {
    return {
      findings,
      totalFindings: findings.length,
      totalBytes: findings.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
      lowRiskCount: findings.filter((f) => f.risk === 'low').length,
      mediumRiskCount: findings.filter((f) => f.risk === 'medium').length,
      highRiskCount: findings.filter((f) => f.risk === 'high').length,
      criticalRiskCount: findings.filter((f) => f.risk === 'critical').length,
      sourceSummary: {
        files: findings.filter((f) => f.source === 'files').length,
        git: findings.filter((f) => f.source === 'git').length,
        dependencies: findings.filter((f) => f.source === 'dependencies').length,
        cache: findings.filter((f) => f.source === 'cache').length,
        docker: findings.filter((f) => f.source === 'docker').length,
      },
      warnings,
    };
  }

  // 1. empty analyzer result
  it('1. empty analyzer result produces empty plan with initialized properties', () => {
    const emptyResult = createSampleResult([]);
    const plan = planner.plan(emptyResult, { now: fixedNow });

    expect(plan.actions).toEqual([]);
    expect(plan.blockedActions).toEqual([]);
    expect(plan.totalEstimatedBytes).toBe(0);
    expect(plan.findingsAnalyzed).toBe(0);
    expect(plan.requiresHumanApproval).toBe(true);
    expect(plan.createdAt).toBe(fixedNow);
    expect(plan.id).toMatch(/^plan-[a-f0-9]{16}$/);
  });

  // 2. known .next/cache generates remove-directory plan action
  it('2. known .next/cache generates remove-directory plan action', () => {
    const finding = createSampleFinding({
      id: 'fn-next-cache',
      source: 'cache',
      category: 'build-artifact',
      title: 'NEXT Cache (.next/cache)',
      path: '/app/.next/cache',
      sizeBytes: 120000,
      risk: 'low',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    const action = plan.actions[0];
    expect(action.type).toBe('remove-directory');
    expect(action.target).toBe('/app/.next/cache');
    expect(action.estimatedBytes).toBe(120000);
    expect(action.reversible).toBe(true);
    expect(action.requiresApproval).toBe(true);
  });

  // 3. node_modules/.vite generates action
  it('3. node_modules/.vite generates action', () => {
    const finding = createSampleFinding({
      id: 'fn-vite-cache',
      source: 'cache',
      category: 'build-artifact',
      title: 'VITE Cache (node_modules/.vite)',
      path: '/app/node_modules/.vite',
      sizeBytes: 45000,
      risk: 'low',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    const action = plan.actions[0];
    expect(action.type).toBe('remove-directory');
    expect(action.target).toBe('/app/node_modules/.vite');
  });

  // 4. __pycache__ generates action
  it('4. __pycache__ generates action', () => {
    const finding = createSampleFinding({
      id: 'fn-pycache',
      source: 'cache',
      category: 'cache',
      title: 'PYTHON Cache (__pycache__)',
      path: '/app/src/__pycache__',
      sizeBytes: 8000,
      risk: 'low',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].type).toBe('remove-directory');
    expect(plan.actions[0].target).toBe('/app/src/__pycache__');
  });

  // 5. package manager cache generates action
  it('5. package manager cache generates action (.npm, .pnpm-store, .yarn/cache, .gradle/caches)', () => {
    const findings = [
      createSampleFinding({
        id: 'fn-npm',
        path: '/app/.npm',
        title: 'NPM Cache (.npm)',
      }),
      createSampleFinding({
        id: 'fn-pnpm',
        path: '/app/.pnpm-store',
        title: 'PNPM Cache (.pnpm-store)',
      }),
    ];

    const plan = planner.plan(createSampleResult(findings));
    expect(plan.actions.length).toBe(2);
    expect(plan.actions.map((a) => a.type)).toEqual(['remove-directory', 'remove-directory']);
  });

  // 6. generic cache is blocked
  it('6. generic cache is blocked with investigation reason', () => {
    const finding = createSampleFinding({
      id: 'fn-generic-cache',
      source: 'cache',
      category: 'cache',
      title: 'GENERIC Cache (cache)',
      path: '/app/cache',
      recommendation: 'investigate',
      risk: 'medium',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Generic cache requires investigation');
  });

  // 7. high-risk finding blocked by default
  it('7. high-risk finding blocked by default', () => {
    const finding = createSampleFinding({
      id: 'fn-high-risk',
      risk: 'high',
      title: 'Custom Cache (custom-cache)',
      path: '/app/custom-cache',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('risk level is high');
  });

  // 8. critical-risk finding blocked by default
  it('8. critical-risk finding blocked by default', () => {
    const finding = createSampleFinding({
      id: 'fn-crit-risk',
      risk: 'critical',
      title: 'Critical Item',
      path: '/app/critical',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('risk level is critical');
  });

  // 9. optional high-risk inclusion works
  it('9. optional high-risk inclusion works when includeHighRisk option is enabled', () => {
    const finding = createSampleFinding({
      id: 'fn-high-risk-cache',
      risk: 'high',
      source: 'cache',
      category: 'cache',
      title: 'NPM Cache (.npm)',
      path: '/app/.npm',
    });

    const plan = planner.plan(createSampleResult([finding]), { includeHighRisk: true });
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].risk).toBe('high');
  });

  // 10. stopped Docker container generates reviewable action
  it('10. stopped Docker container generates reviewable docker-remove-container action', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-stopped-container',
      source: 'docker',
      category: 'docker',
      title: 'Stopped Docker Container (dev-db)',
      description: 'Stopped container',
      resourceId: 'c12345678901',
      sizeBytes: 15000000,
      risk: 'medium',
      confidence: 0.9,
      recommendation: 'review',
      evidence: ['State: exited'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    const action = plan.actions[0];
    expect(action.type).toBe('docker-remove-container');
    expect(action.target).toBe('c12345678901');
    expect(action.reversible).toBe(false);
    expect(action.requiresApproval).toBe(true);
    expect(action.warnings.length).toBeGreaterThan(0);
  });

  // 11. running Docker container is blocked
  it('11. running Docker container is blocked from cleanup planning', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-running-container',
      source: 'docker',
      category: 'docker',
      title: 'Running Docker Container (prod-api)',
      description: 'Running container',
      resourceId: 'c999',
      risk: 'low',
      confidence: 1.0,
      recommendation: 'retain',
      evidence: ['State: running'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Running Docker containers are not eligible');
  });

  // 12. unreferenced image generates action
  it('12. unreferenced image generates docker-remove-image action', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-unreferenced-image',
      source: 'docker',
      category: 'docker',
      title: 'Unreferenced Docker Image (node-app:v1)',
      description: 'Unreferenced image',
      resourceId: 'sha256:img123',
      sizeBytes: 250000000,
      risk: 'medium',
      confidence: 0.85,
      recommendation: 'review',
      evidence: ['Containers using: 0'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    const action = plan.actions[0];
    expect(action.type).toBe('docker-remove-image');
    expect(action.target).toBe('sha256:img123');
    expect(action.reversible).toBe(false);
    expect(action.requiresApproval).toBe(true);
  });

  // 13. referenced image blocked
  it('13. referenced in-use Docker image is blocked', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-in-use-image',
      source: 'docker',
      category: 'docker',
      title: 'In-Use Docker Image (postgres:15)',
      description: 'Referenced image',
      resourceId: 'sha256:pg15',
      risk: 'low',
      confidence: 1.0,
      recommendation: 'retain',
      evidence: ['Containers using: 2'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Referenced or in-use Docker images');
  });

  // 14. unattached Docker volume is ALWAYS blocked
  it('14. unattached Docker volume is ALWAYS blocked from direct removal in Step 9', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-volume-unattached',
      source: 'docker',
      category: 'docker',
      title: 'Unattached Docker Volume (db_data)',
      description: 'Unattached volume with 0 container references',
      resourceId: 'db_data',
      risk: 'high',
      confidence: 0.95,
      recommendation: 'investigate',
      evidence: ['Attached containers: 0'],
      reversible: false,
      detectedAt: fixedNow,
    };

    // Even if includeHighRisk is explicitly true!
    const plan = planner.plan(createSampleResult([finding]), { includeHighRisk: true });
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain(
      'Unattached Docker volumes may contain persistent data',
    );
  });

  // 15. system Docker network blocked
  it('15. system Docker network (bridge/host/none) is always blocked', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-system-net',
      source: 'docker',
      category: 'docker',
      title: 'System Docker Network (bridge)',
      description: 'Default network',
      resourceId: 'bridge',
      risk: 'low',
      confidence: 1.0,
      recommendation: 'retain',
      evidence: ['System network: true'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain(
      'Default Docker system networks cannot be removed',
    );
  });

  // 16. custom unattached network may generate action
  it('16. custom unattached network generates docker-remove-network action', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-unattached-net',
      source: 'docker',
      category: 'docker',
      title: 'Unattached Docker Network (app_backend_net)',
      description: 'Custom network with 0 containers',
      resourceId: 'net-abc-123',
      risk: 'medium',
      confidence: 0.9,
      recommendation: 'review',
      evidence: ['Attached containers: 0'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    const action = plan.actions[0];
    expect(action.type).toBe('docker-remove-network');
    expect(action.target).toBe('net-abc-123');
    expect(action.requiresApproval).toBe(true);
  });

  // 17. Git metadata never generates action
  it('17. Git metadata never generates cleanup action and is always blocked', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-git-meta',
      source: 'git',
      category: 'repository',
      title: 'Git Repository Metadata (main)',
      description: 'Git metadata',
      path: '/app/.git',
      sizeBytes: 15000000,
      risk: 'low',
      confidence: 1.0,
      recommendation: 'retain',
      evidence: ['Branch: main'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Git repository metadata is protected');
  });

  // 18. dependency finding never generates package removal
  it('18. dependency finding never generates package removal in Step 9', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-missing-node-modules',
      source: 'dependencies',
      category: 'dependency',
      title: 'Missing node_modules Directory',
      description: 'Inconsistency',
      path: '/app/node_modules',
      risk: 'medium',
      confidence: 0.8,
      recommendation: 'investigate',
      evidence: ['node_modules present: false'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
    expect(plan.blockedActions[0].reason).toContain('Dependency findings are not eligible');
  });

  // 19. arbitrary large file does not generate action
  it('19. arbitrary large file does not generate cleanup action', () => {
    const finding: AnalyzerFinding = {
      id: 'fn-arbitrary-file',
      source: 'files',
      category: 'unknown',
      title: 'Large Database Dump (db.dump)',
      description: 'Large file',
      path: '/app/db.dump',
      sizeBytes: 5000000000,
      risk: 'low',
      confidence: 0.5,
      recommendation: 'retain',
      evidence: ['File size: 5GB'],
      reversible: false,
      detectedAt: fixedNow,
    };

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions.length).toBe(1);
  });

  // 20. every action requires approval
  it('20. every action requires approval (requiresApproval === true)', () => {
    const findings = [
      createSampleFinding({ id: 'fn-1', path: '/app/.npm', title: 'NPM Cache (.npm)' }),
      createSampleFinding({
        id: 'fn-2',
        path: '/app/.next/cache',
        title: 'NEXT Cache (.next/cache)',
      }),
    ];

    const plan = planner.plan(createSampleResult(findings));
    expect(plan.actions.length).toBeGreaterThan(0);
    for (const action of plan.actions) {
      expect(action.requiresApproval).toBe(true);
    }
  });

  // 21. every plan requires human approval
  it('21. every plan requires human approval (requiresHumanApproval === true)', () => {
    const plan = planner.plan(createSampleResult([]));
    expect(plan.requiresHumanApproval).toBe(true);
  });

  // 22. deterministic action IDs
  it('22. deterministic action IDs: same inputs produce identical action IDs', () => {
    const finding = createSampleFinding({
      id: 'fn-det-action',
      path: '/app/.npm',
      title: 'NPM Cache (.npm)',
    });
    const plan1 = planner.plan(createSampleResult([finding]));
    const plan2 = planner.plan(createSampleResult([finding]));

    expect(plan1.actions[0].id).toBe(plan2.actions[0].id);
    expect(plan1.actions[0].id).toMatch(/^action-[a-f0-9]{16}$/);
  });

  // 23. deterministic plan IDs
  it('23. deterministic plan IDs: same analyzer results produce identical plan IDs', () => {
    expect(PLANNER_VERSION).toBe('1.0.0');
    const finding = createSampleFinding({
      id: 'fn-det-plan',
      path: '/app/.npm',
      title: 'NPM Cache (.npm)',
    });
    const plan1 = planner.plan(createSampleResult([finding]), { now: '2026-09-25T10:00:00Z' });
    const plan2 = planner.plan(createSampleResult([finding]), { now: '2026-09-25T12:00:00Z' });

    expect(plan1.id).toBe(plan2.id);
  });

  // 24. createdAt does not affect plan ID
  it('24. createdAt does not affect plan ID calculation', () => {
    const finding = createSampleFinding({
      id: 'fn-time-independent',
      path: '/app/.npm',
      title: 'NPM Cache (.npm)',
    });
    const planA = planner.plan(createSampleResult([finding]), { now: '2026-01-01T00:00:00Z' });
    const planB = planner.plan(createSampleResult([finding]), { now: '2026-12-31T23:59:59Z' });

    expect(planA.createdAt).not.toBe(planB.createdAt);
    expect(planA.id).toBe(planB.id);
  });

  // 25. overlapping filesystem actions are deduplicated
  it('25. overlapping filesystem actions are deduplicated (nested child path omitted/blocked)', () => {
    const parentFinding = createSampleFinding({
      id: 'fn-parent-cache',
      source: 'cache',
      category: 'build-artifact',
      title: 'NEXT Cache (.next/cache)',
      path: '/app/.next/cache',
      sizeBytes: 1000,
    });

    const childFinding = createSampleFinding({
      id: 'fn-child-cache',
      source: 'cache',
      category: 'build-artifact',
      title: 'NEXT Cache (.next/cache/webpack)',
      path: '/app/.next/cache/webpack',
      sizeBytes: 400,
    });

    const plan = planner.plan(createSampleResult([parentFinding, childFinding]));
    // Only parent action should exist in actions
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].target).toBe('/app/.next/cache');

    // Child must be captured in blockedActions with reason
    const childBlocked = plan.blockedActions.find((b) => b.findingId === 'fn-child-cache');
    expect(childBlocked).toBeDefined();
    expect(childBlocked?.reason).toContain('nested within parent cleanup action');
  });

  // 26. totalEstimatedBytes excludes blocked actions
  it('26. totalEstimatedBytes excludes blocked actions', () => {
    const allowed = createSampleFinding({
      id: 'fn-allowed',
      path: '/app/.npm',
      title: 'NPM Cache (.npm)',
      sizeBytes: 25000,
      risk: 'low',
    });
    const blockedHigh = createSampleFinding({
      id: 'fn-blocked-high',
      path: '/app/high-risk',
      title: 'High Risk Item',
      sizeBytes: 80000,
      risk: 'high',
    });

    const plan = planner.plan(createSampleResult([allowed, blockedHigh]));
    expect(plan.actions.length).toBe(1);
    expect(plan.totalEstimatedBytes).toBe(25000);
  });

  // 27. totalEstimatedBytes avoids overlap
  it('27. totalEstimatedBytes avoids double-counting nested actions', () => {
    const parent = createSampleFinding({
      id: 'fn-p',
      path: '/app/.next/cache',
      title: 'NEXT Cache (.next/cache)',
      sizeBytes: 1000,
    });
    const child = createSampleFinding({
      id: 'fn-c',
      path: '/app/.next/cache/sub',
      title: 'NEXT Cache (.next/cache/sub)',
      sizeBytes: 400,
    });

    const plan = planner.plan(createSampleResult([parent, child]));
    expect(plan.totalEstimatedBytes).toBe(1000);
  });

  // 28. protected root paths blocked
  it('28. protected root paths are strictly blocked from removal', () => {
    const finding = createSampleFinding({
      id: 'fn-root-path',
      path: '/',
      title: 'Root Directory Cache',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions[0].reason).toContain('protected');
  });

  // 29. .git blocked
  it('29. .git path is blocked as protected system directory', () => {
    const finding = createSampleFinding({
      id: 'fn-git-dir',
      path: '/app/.git',
      title: 'Git Directory',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions[0].reason).toContain('protected');
  });

  // 30. node_modules parent blocked
  it('30. entire node_modules parent directory is blocked from cleanup', () => {
    const finding = createSampleFinding({
      id: 'fn-entire-node-modules',
      path: '/app/node_modules',
      title: 'Node Modules Directory',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(0);
    expect(plan.blockedActions[0].reason).toContain('protected');
  });

  // 31. node_modules/.vite allowed
  it('31. known cache subdirectory node_modules/.vite is specifically allowed', () => {
    const finding = createSampleFinding({
      id: 'fn-vite-allowed',
      source: 'cache',
      category: 'build-artifact',
      path: '/app/node_modules/.vite',
      title: 'VITE Cache (node_modules/.vite)',
      sizeBytes: 15000,
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.actions.length).toBe(1);
    expect(plan.actions[0].target).toBe('/app/node_modules/.vite');
  });

  // 32. blocked reason preserved
  it('32. blocked reason is clearly preserved for auditability', () => {
    const finding = createSampleFinding({
      id: 'fn-reason-test',
      risk: 'high',
      title: 'Custom Cache',
      path: '/app/custom',
    });

    const plan = planner.plan(createSampleResult([finding]));
    expect(plan.blockedActions[0].findingId).toBe('fn-reason-test');
    expect(plan.blockedActions[0].reason).toBeDefined();
    expect(plan.blockedActions[0].reason.length).toBeGreaterThan(10);
  });

  // 33. planner is deterministic
  it('33. planner is deterministic: identical output across multiple runs', () => {
    const findings = [
      createSampleFinding({ id: 'fn-b', path: '/app/.npm', title: 'NPM Cache (.npm)' }),
      createSampleFinding({
        id: 'fn-a',
        path: '/app/.next/cache',
        title: 'NEXT Cache (.next/cache)',
      }),
    ];

    const plan1 = planner.plan(createSampleResult(findings), { now: fixedNow });
    const plan2 = planner.plan(createSampleResult(findings), { now: fixedNow });

    expect(plan1).toEqual(plan2);
  });

  // 34. no filesystem access
  it('34. no filesystem access: planner implementation imports no fs APIs', () => {
    const plannerFile = path.resolve('src/cleanup/planner/CleanupPlanner.ts');
    const content = fs.readFileSync(plannerFile, 'utf8');

    expect(content).not.toContain("import * as fs from 'node:fs'");
    expect(content).not.toContain("import fs from 'node:fs'");
    expect(content).not.toContain('fs.promises');
    expect(content).not.toContain('unlink');
    expect(content).not.toContain('rmdir');
    expect(content).not.toContain('writeFile');
  });

  // 35. no Docker command execution
  it('35. no Docker command execution: planner does not invoke DockerClient or docker commands', () => {
    const plannerFile = path.resolve('src/cleanup/planner/CleanupPlanner.ts');
    const content = fs.readFileSync(plannerFile, 'utf8');

    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker rm');
    expect(content).not.toContain('docker rmi');
    expect(content).not.toContain('docker volume rm');
    expect(content).not.toContain('docker system prune');
    expect(content).not.toContain('docker builder prune');
  });

  // 36. no shell execution
  it('36. no shell execution: planner does not import child_process or spawn shell commands', () => {
    const plannerFile = path.resolve('src/cleanup/planner/CleanupPlanner.ts');
    const content = fs.readFileSync(plannerFile, 'utf8');

    expect(content).not.toContain('child_process');
    expect(content).not.toContain('exec(');
    expect(content).not.toContain('execFile');
    expect(content).not.toContain('spawn(');
    expect(content).not.toContain('shell: true');
  });
});
