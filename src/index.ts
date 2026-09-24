/**
 * Digital Janitor - Foundation Entry Point
 *
 * Scaffolding phase: Business logic, MCP server transport, and integrations
 * will be implemented in subsequent phases.
 */

export const APP_NAME = 'digital-janitor';
export const APP_VERSION = '0.1.0';

export function getAppInfo() {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    status: 'foundation-initialized',
  };
}
