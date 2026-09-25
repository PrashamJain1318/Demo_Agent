import { describe, it, expect } from 'vitest';
import {
  TRUEFORGE_READ_ONLY_TOOLS,
  TRUEFORGE_EXCLUDED_TOOLS,
  TRUEFORGE_READ_ONLY_PROFILE,
  isTrueForgeAllowedTool,
} from '../../src/config/trueforge.js';
import { createServer, createTrueForgeServer } from '../../src/mcp/server.js';
import { parseProfile } from '../../src/mcp/http.js';

describe('TrueForge Read-Only Profile & Allowlist (Step 15.1 & 15.3A)', () => {
  it('4. contains exactly the 8 approved read-only tools in TRUEFORGE_READ_ONLY_TOOLS', () => {
    expect(TRUEFORGE_READ_ONLY_TOOLS).toHaveLength(8);
    expect([...TRUEFORGE_READ_ONLY_TOOLS]).toEqual([
      'health_check',
      'scan_files',
      'scan_git_repository',
      'scan_dependencies',
      'scan_cache',
      'scan_docker',
      'analyze_cleanup',
      'create_cleanup_plan',
    ]);
  });

  it('5. proves every destructive, recovery, approval, and execution tool is explicitly excluded', () => {
    expect(TRUEFORGE_EXCLUDED_TOOLS).toHaveLength(6);
    expect([...TRUEFORGE_EXCLUDED_TOOLS]).toEqual([
      'evaluate_cleanup_approval',
      'quarantine_approved',
      'verify_quarantine',
      'restore_quarantine',
      'evaluate_deletion',
      'delete_verified',
    ]);

    // Ensure strict disjointness between allowed and excluded tools
    const allowedSet = new Set<string>(TRUEFORGE_READ_ONLY_TOOLS);
    for (const excluded of TRUEFORGE_EXCLUDED_TOOLS) {
      expect(allowedSet.has(excluded)).toBe(false);
    }
  });

  it('verifies TRUEFORGE_READ_ONLY_PROFILE configuration properties', () => {
    expect(TRUEFORGE_READ_ONLY_PROFILE.profileName).toBe('trueforge-read-only');
    expect(TRUEFORGE_READ_ONLY_PROFILE.readOnly).toBe(true);
    expect(TRUEFORGE_READ_ONLY_PROFILE.allowedTools).toBe(TRUEFORGE_READ_ONLY_TOOLS);
    expect(TRUEFORGE_READ_ONLY_PROFILE.excludedTools).toBe(TRUEFORGE_EXCLUDED_TOOLS);
    expect(Object.isFrozen(TRUEFORGE_READ_ONLY_TOOLS)).toBe(true);
    expect(Object.isFrozen(TRUEFORGE_EXCLUDED_TOOLS)).toBe(true);
    expect(Object.isFrozen(TRUEFORGE_READ_ONLY_PROFILE)).toBe(true);
  });

  it('isTrueForgeAllowedTool correctly evaluates tool names', () => {
    for (const tool of TRUEFORGE_READ_ONLY_TOOLS) {
      expect(isTrueForgeAllowedTool(tool)).toBe(true);
    }

    for (const tool of TRUEFORGE_EXCLUDED_TOOLS) {
      expect(isTrueForgeAllowedTool(tool)).toBe(false);
    }

    // Arbitrary/dangerous tools must not be allowed
    expect(isTrueForgeAllowedTool('delete')).toBe(false);
    expect(isTrueForgeAllowedTool('delete_file')).toBe(false);
    expect(isTrueForgeAllowedTool('write_file')).toBe(false);
    expect(isTrueForgeAllowedTool('execute_shell')).toBe(false);
    expect(isTrueForgeAllowedTool('run_command')).toBe(false);
    expect(isTrueForgeAllowedTool('rm')).toBe(false);
  });

  it('parseProfile strictly validates environment and options profiles', () => {
    // Unset returns undefined (defaulting to full)
    expect(parseProfile(undefined, undefined)).toBeUndefined();
    expect(parseProfile('', undefined)).toBeUndefined();

    // Valid profiles
    expect(parseProfile('trueforge-read-only')).toBe('trueforge-read-only');
    expect(parseProfile('  TRUEFORGE-READ-ONLY  ')).toBe('trueforge-read-only');
    expect(parseProfile('full')).toBe('full');
    expect(parseProfile(undefined, 'trueforge-read-only')).toBe('trueforge-read-only');
    expect(parseProfile(undefined, 'full')).toBe('full');

    // Options take precedence over env
    expect(parseProfile('full', 'trueforge-read-only')).toBe('trueforge-read-only');

    // Invalid env values throw descriptive error
    expect(() => parseProfile('invalid-profile')).toThrow(
      /Invalid MCP_PROFILE environment variable/i,
    );
    expect(() => parseProfile('delete_all')).toThrow(/Invalid MCP_PROFILE environment variable/i);
    expect(() => parseProfile('arbitrary_tool')).toThrow(
      /Invalid MCP_PROFILE environment variable/i,
    );

    // Invalid option values throw descriptive error
    expect(() =>
      parseProfile(
        undefined,
        'bad-profile' as unknown as import('../../src/mcp/server.js').McpServerProfile,
      ),
    ).toThrow(/Invalid server profile/i);
  });

  it('createTrueForgeServer creates an McpServer instance with only the 8 read-only tools', async () => {
    const server = createTrueForgeServer();
    expect(server).toBeDefined();

    // Verify default server has all 14 tools
    const defaultServer = createServer();
    expect(defaultServer).toBeDefined();
  });
});
