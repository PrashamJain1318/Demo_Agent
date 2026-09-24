import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FileScanner } from '../scanner/files/FileScanner.js';
import { GitScanner } from '../scanner/git/GitScanner.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'Digital Janitor',
    version: '0.1.0',
  });

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
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
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
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: message }),
            },
          ],
        };
      }
    },
  );

  return server;
}
