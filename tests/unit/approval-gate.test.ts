import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApprovalGate } from '../../src/cleanup/approval/ApprovalGate.js';
import type { CleanupAction, CleanupPlan } from '../../src/types/cleanup.js';
import type { ApprovalRequest } from '../../src/types/approval.js';

describe('ApprovalGate Unit Tests', () => {
  const gate = new ApprovalGate();
  const fixedNow = '2026-09-25T14:40:00.000Z';

  function createSampleAction(overrides?: Partial<CleanupAction>): CleanupAction {
    return {
      id: 'action-test-1',
      type: 'remove-directory',
      target: '/app/.next/cache',
      sourceFindingId: 'fn-next-cache',
      title: 'Remove Cache Directory (.next/cache)',
      reason: 'Proposed cleanup of regenerable cache',
      risk: 'low',
      estimatedBytes: 50000,
      reversible: true,
      requiresApproval: true,
      prerequisites: ['Operator approval required'],
      warnings: [],
      ...overrides,
    };
  }

  function createSamplePlan(overrides?: Partial<CleanupPlan>): CleanupPlan {
    const defaultAction = createSampleAction();
    return {
      id: 'plan-abc1234567890123',
      createdAt: fixedNow,
      findingsAnalyzed: 1,
      actions: [defaultAction],
      totalEstimatedBytes: 50000,
      requiresHumanApproval: true,
      warnings: [],
      blockedActions: [],
      ...overrides,
    };
  }

  function createSampleRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
    return {
      planId: 'plan-abc1234567890123',
      actionIds: ['action-test-1'],
      decision: 'approved',
      requestedAt: fixedNow,
      requestedBy: 'operator-alice',
      reason: 'Regular scheduled maintenance',
      ...overrides,
    };
  }

  // 1. approves explicitly requested low-risk action
  it('1. approves explicitly requested low-risk action', () => {
    const action = createSampleAction({ id: 'action-low-1', risk: 'low' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-low-1'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual(['action-low-1']);
    expect(result.rejectedActionIds).toEqual([]);
    expect(result.blockedActionIds).toEqual([]);
    expect(result.approvedAt).toBe(fixedNow);
  });

  // 2. approves explicitly requested medium-risk action
  it('2. approves explicitly requested medium-risk action', () => {
    const action = createSampleAction({ id: 'action-med-1', risk: 'medium' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-med-1'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual(['action-med-1']);
    expect(result.rejectedActionIds).toEqual([]);
  });

  // 3. rejects high-risk action by default
  it('3. rejects high-risk action by default (allowHighRisk=false)', () => {
    const action = createSampleAction({ id: 'action-high-1', risk: 'high' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-high-1'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('rejected');
    expect(result.approvedActionIds).toEqual([]);
    expect(result.rejectedActionIds).toEqual(['action-high-1']);
    expect(result.rejectionReasons?.['action-high-1']).toContain(
      'high-risk actions require allowHighRisk=true',
    );
  });

  // 4. allows high-risk action when allowHighRisk=true
  it('4. allows high-risk action when allowHighRisk=true is explicitly specified', () => {
    const action = createSampleAction({ id: 'action-high-1', risk: 'high' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-high-1'] });

    const result = gate.evaluate(plan, request, { allowHighRisk: true, now: fixedNow });

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual(['action-high-1']);
    expect(result.rejectedActionIds).toEqual([]);
  });

  // 5. rejects critical-risk action by default
  it('5. rejects critical-risk action by default (allowCriticalRisk=false)', () => {
    const action = createSampleAction({ id: 'action-crit-1', risk: 'critical' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-crit-1'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('rejected');
    expect(result.approvedActionIds).toEqual([]);
    expect(result.rejectedActionIds).toEqual(['action-crit-1']);
    expect(result.rejectionReasons?.['action-crit-1']).toContain(
      'critical-risk actions require allowCriticalRisk=true',
    );
  });

  // 6. allows critical-risk action when allowCriticalRisk=true
  it('6. allows critical-risk action when allowCriticalRisk=true is explicitly specified', () => {
    const action = createSampleAction({ id: 'action-crit-1', risk: 'critical' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-crit-1'] });

    const result = gate.evaluate(plan, request, { allowCriticalRisk: true, now: fixedNow });

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual(['action-crit-1']);
  });

  // 7. rejected decision approves nothing
  it('7. rejected decision approves nothing even if low-risk action is requested', () => {
    const action = createSampleAction({ id: 'action-low-1', risk: 'low' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({
      actionIds: ['action-low-1'],
      decision: 'rejected',
      reason: 'Deployment in progress, cleanup aborted',
    });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('rejected');
    expect(result.approvedActionIds).toEqual([]);
    expect(result.rejectedActionIds).toEqual(['action-low-1']);
    expect(result.reason).toContain('Deployment in progress, cleanup aborted');
  });

  // 8. partial approval only approves explicitly requested IDs
  it('8. partial approval only approves explicitly requested IDs', () => {
    const actionA = createSampleAction({ id: 'action-A', risk: 'low' });
    const actionB = createSampleAction({ id: 'action-B', risk: 'low' });
    const actionC = createSampleAction({ id: 'action-C', risk: 'low' });
    const plan = createSamplePlan({ actions: [actionA, actionB, actionC] });

    // Request only action-B
    const request = createSampleRequest({ actionIds: ['action-B'] });
    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('approved');
    expect(result.approvedActionIds).toEqual(['action-B']);
    expect(result.approvedActionIds).not.toContain('action-A');
    expect(result.approvedActionIds).not.toContain('action-C');
  });

  // 9. blocked action cannot be approved
  it('9. blocked action cannot be approved (routed to blockedActionIds)', () => {
    const action = createSampleAction({
      id: 'action-blocked-1',
      sourceFindingId: 'fn-blocked-root',
    });
    const plan = createSamplePlan({
      actions: [action],
      blockedActions: [
        {
          findingId: 'fn-blocked-root',
          reason: 'Target path is protected',
          risk: 'high',
          category: 'cache',
        },
      ],
    });

    const request = createSampleRequest({ actionIds: ['action-blocked-1'] });
    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.approvedActionIds).toEqual([]);
    expect(result.blockedActionIds).toEqual(['action-blocked-1']);
    expect(result.decision).toBe('rejected');
  });

  // 10. unknown action ID cannot be approved
  it('10. unknown action ID cannot be approved and is rejected', () => {
    const plan = createSamplePlan({ actions: [createSampleAction({ id: 'action-existing' })] });
    const request = createSampleRequest({ actionIds: ['action-unknown-999'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.approvedActionIds).toEqual([]);
    expect(result.rejectedActionIds).toEqual(['action-unknown-999']);
    expect(result.decision).toBe('rejected');
    expect(result.rejectionReasons?.['action-unknown-999']).toContain(
      'does not exist in CleanupPlan',
    );
  });

  // 11. plan ID mismatch approves nothing
  it('11. plan ID mismatch approves nothing and rejects the entire request', () => {
    const plan = createSamplePlan({ id: 'plan-correct-id' });
    const request = createSampleRequest({
      planId: 'plan-wrong-id',
      actionIds: ['action-test-1'],
    });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.decision).toBe('rejected');
    expect(result.approvedActionIds).toEqual([]);
    expect(result.rejectedActionIds).toEqual(['action-test-1']);
    expect(result.reason).toContain('Plan ID mismatch');
  });

  // 12. duplicate action IDs are deduplicated
  it('12. duplicate action IDs in request are deduplicated deterministically', () => {
    const action = createSampleAction({ id: 'action-dup', risk: 'low' });
    const plan = createSamplePlan({ actions: [action] });
    const request = createSampleRequest({ actionIds: ['action-dup', 'action-dup', 'action-dup'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.approvedActionIds).toEqual(['action-dup']);
    expect(result.approvedActionIds.length).toBe(1);
  });

  // 13. result ordering is deterministic
  it('13. result ordering is deterministic (alphabetically sorted)', () => {
    const actionZ = createSampleAction({ id: 'action-z', risk: 'low' });
    const actionA = createSampleAction({ id: 'action-a', risk: 'low' });
    const actionM = createSampleAction({ id: 'action-m', risk: 'low' });
    const plan = createSamplePlan({ actions: [actionZ, actionA, actionM] });

    const request = createSampleRequest({ actionIds: ['action-z', 'action-a', 'action-m'] });
    const result1 = gate.evaluate(plan, request, { now: fixedNow });
    const result2 = gate.evaluate(plan, request, { now: fixedNow });

    expect(result1.approvedActionIds).toEqual(['action-a', 'action-m', 'action-z']);
    expect(result1).toEqual(result2);
  });

  // 14. no automatic approval of unrequested actions
  it('14. no automatic approval of unrequested actions', () => {
    const action1 = createSampleAction({ id: 'action-1', risk: 'low' });
    const action2 = createSampleAction({ id: 'action-2', risk: 'low' });
    const plan = createSamplePlan({ actions: [action1, action2] });

    // Empty actionIds request
    const request = createSampleRequest({ actionIds: [] });
    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.approvedActionIds).toEqual([]);
    expect(result.decision).toBe('rejected');
  });

  // 15. blocked IDs never appear in approved IDs
  it('15. blocked IDs never appear in approved IDs under any circumstance', () => {
    const blockedAction = createSampleAction({ id: 'action-b1', sourceFindingId: 'fn-b1' });
    const normalAction = createSampleAction({ id: 'action-ok', risk: 'low' });
    const plan = createSamplePlan({
      actions: [blockedAction, normalAction],
      blockedActions: [
        { findingId: 'fn-b1', reason: 'Blocked volume', risk: 'high', category: 'docker' },
      ],
    });

    const request = createSampleRequest({ actionIds: ['action-b1', 'action-ok'] });
    const result = gate.evaluate(plan, request, { allowHighRisk: true, now: fixedNow });

    expect(result.approvedActionIds).toEqual(['action-ok']);
    expect(result.blockedActionIds).toEqual(['action-b1']);
    expect(result.approvedActionIds).not.toContain('action-b1');
  });

  // 16. approval result contains useful rejection reasons
  it('16. approval result contains useful rejection reasons', () => {
    const highRiskAction = createSampleAction({ id: 'action-high', risk: 'high' });
    const plan = createSamplePlan({ actions: [highRiskAction] });
    const request = createSampleRequest({ actionIds: ['action-high', 'action-not-in-plan'] });

    const result = gate.evaluate(plan, request, { now: fixedNow });

    expect(result.rejectionReasons).toBeDefined();
    expect(result.rejectionReasons?.['action-high']).toContain(
      'high-risk actions require allowHighRisk=true',
    );
    expect(result.rejectionReasons?.['action-not-in-plan']).toContain(
      'does not exist in CleanupPlan',
    );
  });

  // 17. no filesystem access
  it('17. no filesystem access: ApprovalGate does not invoke or import fs write APIs', () => {
    const gateFile = path.resolve('src/cleanup/approval/ApprovalGate.ts');
    const content = fs.readFileSync(gateFile, 'utf8');

    expect(content).not.toContain("import * as fs from 'node:fs'");
    expect(content).not.toContain("import fs from 'node:fs'");
    expect(content).not.toContain('fs.promises');
    expect(content).not.toContain('writeFile');
    expect(content).not.toContain('unlink');
    expect(content).not.toContain('rmdir');
    expect(content).not.toContain('mkdir');
  });

  // 18. no child_process
  it('18. no child_process: ApprovalGate contains zero child_process imports', () => {
    const gateFile = path.resolve('src/cleanup/approval/ApprovalGate.ts');
    const content = fs.readFileSync(gateFile, 'utf8');

    expect(content).not.toContain('child_process');
    expect(content).not.toContain('exec(');
    expect(content).not.toContain('execFile');
    expect(content).not.toContain('spawn(');
  });

  // 19. no Docker client
  it('19. no Docker client: ApprovalGate does not reference or import DockerClient', () => {
    const gateFile = path.resolve('src/cleanup/approval/ApprovalGate.ts');
    const content = fs.readFileSync(gateFile, 'utf8');

    expect(content).not.toContain('DockerClient');
    expect(content).not.toContain('docker rm');
    expect(content).not.toContain('docker rmi');
    expect(content).not.toContain('docker stop');
  });

  // 20. no mutation commands
  it('20. no mutation commands or bypass methods exist on ApprovalGate', () => {
    const gateFile = path.resolve('src/cleanup/approval/ApprovalGate.ts');
    const content = fs.readFileSync(gateFile, 'utf8');

    expect(content).not.toContain('approveAll');
    expect(content).not.toContain('autoApprove');
    expect(content).not.toContain('approveUnsafe');
    expect(content).not.toContain('forceApprove');
    expect(content).not.toContain('bypass');
    expect(content).not.toContain('overrideSafety');
  });

  // 21. architectural execution boundary: createExecutionPayload enforces verified approval
  it('21. architectural execution boundary: createExecutionPayload produces valid payload only from approved result', () => {
    const actionA = createSampleAction({ id: 'action-A', risk: 'low' });
    const actionB = createSampleAction({ id: 'action-B', risk: 'low' });
    const plan = createSamplePlan({ actions: [actionA, actionB] });

    // Successful approval of action-A only
    const request = createSampleRequest({ actionIds: ['action-A'] });
    const approvalResult = gate.evaluate(plan, request, { now: fixedNow });

    const payload = gate.createExecutionPayload(plan, approvalResult);
    expect(payload.planId).toBe(plan.id);
    expect(payload.approvedActions.length).toBe(1);
    expect(payload.approvedActions[0].id).toBe('action-A');

    // Attempting to create execution payload from rejected result throws an error
    const rejectedResult = gate.evaluate(plan, { ...request, decision: 'rejected' });
    expect(() => gate.createExecutionPayload(plan, rejectedResult)).toThrow(
      /Approval decision is 'rejected'/,
    );
  });
});
