import type { CleanupPlan } from '../../types/cleanup.js';
import type {
  ApprovalDecision,
  ApprovalGateOptions,
  ApprovalRequest,
  ApprovalResult,
  ApprovedExecutionPayload,
} from '../../types/approval.js';

/**
 * Pure, deterministic execution safety boundary for Digital Janitor.
 *
 * SAFETY INVARIANT:
 * NO APPROVAL -> NO QUARANTINE -> NO DELETE
 *
 * Guarantees:
 * - Pure and side-effect free: zero filesystem writes, zero command execution, zero network access.
 * - Explicit approval only: unrequested actions are never approved.
 * - Enforces risk policy (high and critical risk rejected by default unless explicitly allowed).
 * - Preserves planner blocked items: blocked actions can never be approved.
 * - Validates plan ID matching.
 * - Deduplicates action IDs and guarantees deterministic ordering.
 * - Exposes no backdoor or auto-approval methods.
 */
export class ApprovalGate {
  evaluate(
    plan: CleanupPlan,
    request: ApprovalRequest,
    options?: ApprovalGateOptions,
  ): ApprovalResult {
    const approvedAt = options?.now ?? new Date().toISOString();
    const allowHighRisk = options?.allowHighRisk ?? false;
    const allowCriticalRisk = options?.allowCriticalRisk ?? false;

    // Deduplicate requested action IDs deterministically
    const uniqueRequestedIds = Array.from(new Set(request.actionIds)).sort();
    const rejectionReasons: Record<string, string> = {};

    // 1. Plan ID Validation
    if (request.planId !== plan.id) {
      const mismatchReason = `Plan ID mismatch: requested plan '${request.planId}' does not match target plan '${plan.id}'.`;
      for (const id of uniqueRequestedIds) {
        rejectionReasons[id] = mismatchReason;
      }
      return {
        planId: request.planId,
        decision: 'rejected',
        approvedActionIds: [],
        rejectedActionIds: uniqueRequestedIds,
        blockedActionIds: [],
        approvedAt,
        approvedBy: request.requestedBy,
        reason: mismatchReason,
        rejectionReasons,
      };
    }

    // 2. Explicit Decision Check
    if (request.decision === 'rejected') {
      const rejectReason =
        request.reason || 'Approval request was explicitly rejected by operator.';
      for (const id of uniqueRequestedIds) {
        rejectionReasons[id] = rejectReason;
      }
      return {
        planId: plan.id,
        decision: 'rejected',
        approvedActionIds: [],
        rejectedActionIds: uniqueRequestedIds,
        blockedActionIds: [],
        approvedAt,
        approvedBy: request.requestedBy,
        reason: rejectReason,
        rejectionReasons,
      };
    }

    // Index plan actions and blocked items
    const planActionMap = new Map(plan.actions.map((a) => [a.id, a]));
    const blockedFindingIdSet = new Set(plan.blockedActions.map((b) => b.findingId));

    const approvedActionIds: string[] = [];
    const rejectedActionIds: string[] = [];
    const blockedActionIds: string[] = [];

    for (const actionId of uniqueRequestedIds) {
      // 3. Blocked Actions check
      if (blockedFindingIdSet.has(actionId)) {
        blockedActionIds.push(actionId);
        rejectionReasons[actionId] =
          `Action/Finding '${actionId}' was previously blocked by the planner.`;
        continue;
      }

      const planAction = planActionMap.get(actionId);

      // 4. Unknown Action ID check
      if (!planAction) {
        rejectedActionIds.push(actionId);
        rejectionReasons[actionId] =
          `Action '${actionId}' does not exist in CleanupPlan '${plan.id}'.`;
        continue;
      }

      // Check if sourceFindingId is blocked
      if (blockedFindingIdSet.has(planAction.sourceFindingId)) {
        blockedActionIds.push(actionId);
        rejectionReasons[actionId] =
          `Action '${actionId}' is blocked because its source finding '${planAction.sourceFindingId}' is blocked.`;
        continue;
      }

      // 5. Risk Policy Evaluation
      if (planAction.risk === 'high' && !allowHighRisk) {
        rejectedActionIds.push(actionId);
        rejectionReasons[actionId] =
          `Action '${actionId}' rejected by risk policy: high-risk actions require allowHighRisk=true.`;
        continue;
      }

      if (planAction.risk === 'critical' && !allowCriticalRisk) {
        rejectedActionIds.push(actionId);
        rejectionReasons[actionId] =
          `Action '${actionId}' rejected by risk policy: critical-risk actions require allowCriticalRisk=true.`;
        continue;
      }

      // 6. Action Approved
      approvedActionIds.push(actionId);
    }

    // Deterministic sorting
    approvedActionIds.sort();
    rejectedActionIds.sort();
    blockedActionIds.sort();

    const finalDecision: ApprovalDecision = approvedActionIds.length > 0 ? 'approved' : 'rejected';
    let summaryReason = request.reason;
    if (!summaryReason) {
      if (finalDecision === 'approved') {
        summaryReason = `Approved ${approvedActionIds.length} action(s).`;
      } else {
        summaryReason = 'No actions qualified for approval under current safety policy.';
      }
    }

    return {
      planId: plan.id,
      decision: finalDecision,
      approvedActionIds,
      rejectedActionIds,
      blockedActionIds,
      approvedAt,
      approvedBy: request.requestedBy,
      reason: summaryReason,
      rejectionReasons,
    };
  }

  /**
   * Constructs an ApprovedExecutionPayload by binding a CleanupPlan to an approved ApprovalResult.
   *
   * Enforces the architectural boundary: Future executors must receive an ApprovedExecutionPayload
   * containing only verified approved actions, never an unapproved CleanupPlan directly.
   */
  createExecutionPayload(plan: CleanupPlan, result: ApprovalResult): ApprovedExecutionPayload {
    if (result.decision !== 'approved') {
      throw new Error("Cannot create execution payload: Approval decision is 'rejected'.");
    }

    if (result.planId !== plan.id) {
      throw new Error(
        `Cannot create execution payload: ApprovalResult planId '${result.planId}' does not match CleanupPlan id '${plan.id}'.`,
      );
    }

    const approvedSet = new Set(result.approvedActionIds);
    const approvedActions = plan.actions.filter((action) => approvedSet.has(action.id));

    if (approvedActions.length === 0) {
      throw new Error(
        'Cannot create execution payload: No approved actions found matching CleanupPlan.',
      );
    }

    return {
      planId: plan.id,
      approvedAt: result.approvedAt,
      approvedBy: result.approvedBy,
      approvedActions,
    };
  }
}
