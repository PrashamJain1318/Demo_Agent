/**
 * TrueForge Read-Only Integration Configuration & Tool Profile (Step 15.1)
 *
 * SAFETY INVARIANT:
 * TrueForge integration is strictly limited to read-only discovery, analysis,
 * and proposed plan generation.
 *
 * All approval, quarantine, restoration, and deletion tools are strictly excluded
 * from TrueForge access.
 */

/**
 * Centralized, immutable allowlist of MCP tools permitted for TrueForge read-only orchestration.
 * Contains exactly 8 approved tools.
 */
export const TRUEFORGE_READ_ONLY_TOOLS = Object.freeze([
  'health_check',
  'scan_files',
  'scan_git_repository',
  'scan_dependencies',
  'scan_cache',
  'scan_docker',
  'analyze_cleanup',
  'create_cleanup_plan',
] as const);

export type TrueForgeReadOnlyTool = (typeof TRUEFORGE_READ_ONLY_TOOLS)[number];

/**
 * Explicit list of dangerous, approval, recovery, or mutating tools that MUST NEVER
 * be exposed through the TrueForge integration profile.
 */
export const TRUEFORGE_EXCLUDED_TOOLS = Object.freeze([
  'evaluate_cleanup_approval',
  'quarantine_approved',
  'verify_quarantine',
  'restore_quarantine',
  'evaluate_deletion',
  'delete_verified',
] as const);

export type TrueForgeExcludedTool = (typeof TRUEFORGE_EXCLUDED_TOOLS)[number];

export interface TrueForgeProfileConfig {
  readonly profileName: 'trueforge-read-only';
  readonly readOnly: true;
  readonly allowedTools: readonly TrueForgeReadOnlyTool[];
  readonly excludedTools: readonly TrueForgeExcludedTool[];
}

export const TRUEFORGE_READ_ONLY_PROFILE: TrueForgeProfileConfig = Object.freeze({
  profileName: 'trueforge-read-only',
  readOnly: true,
  allowedTools: TRUEFORGE_READ_ONLY_TOOLS,
  excludedTools: TRUEFORGE_EXCLUDED_TOOLS,
});

/**
 * Checks whether a given tool name is included in the TrueForge read-only allowlist.
 */
export function isTrueForgeAllowedTool(toolName: string): boolean {
  return (TRUEFORGE_READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}
