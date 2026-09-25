import { createHttpServer } from './mcp/http.js';

export const APP_NAME = 'digital-janitor';
export const APP_VERSION = '0.1.0';

export function getAppInfo() {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    status: 'foundation-initialized',
  };
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;

  try {
    await createHttpServer(port);
    const profile = process.env.MCP_PROFILE ? ` [profile: ${process.env.MCP_PROFILE}]` : '';
    console.log(`Digital Janitor MCP server listening on http://localhost:${port}/mcp${profile}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
