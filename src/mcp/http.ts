import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { createServer } from './server.js';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/node';

import type { McpServerProfile } from './server.js';

export interface HttpServerOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
  profile?: McpServerProfile;
  allowedTools?: readonly string[];
}

const VALID_PROFILES = new Set<string>(['full', 'trueforge-read-only']);

export function parseProfile(
  envVal?: string,
  optionVal?: McpServerProfile,
): McpServerProfile | undefined {
  if (optionVal !== undefined) {
    if (!VALID_PROFILES.has(optionVal)) {
      throw new Error(
        `Invalid server profile: '${optionVal}'. Valid profiles are: ${Array.from(VALID_PROFILES).join(', ')}`,
      );
    }
    return optionVal;
  }
  if (envVal !== undefined && envVal.trim() !== '') {
    const trimmed = envVal.trim().toLowerCase();
    if (!VALID_PROFILES.has(trimmed)) {
      throw new Error(
        `Invalid MCP_PROFILE environment variable: '${envVal}'. Valid profiles are: ${Array.from(VALID_PROFILES).join(', ')}`,
      );
    }
    return trimmed as McpServerProfile;
  }
  return undefined;
}

function parseHostnames(inputs: (string | undefined)[]): string[] {
  const hostnames = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  for (const input of inputs) {
    if (!input) continue;
    const items = input.split(',');
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      try {
        if (trimmed.includes('://')) {
          hostnames.add(new URL(trimmed).hostname);
        } else if (trimmed.startsWith('[')) {
          const end = trimmed.indexOf(']');
          hostnames.add(trimmed.slice(0, end + 1));
        } else {
          hostnames.add(trimmed.split(':')[0]);
        }
      } catch {
        hostnames.add(trimmed);
      }
    }
  }
  return Array.from(hostnames);
}

interface SessionEntry {
  transport: NodeStreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
}

export async function createHttpServer(
  port: number,
  options?: HttpServerOptions,
): Promise<http.Server> {
  const activeProfile = parseProfile(process.env.MCP_PROFILE, options?.profile);
  const sessions = new Map<string, SessionEntry>();

  const allowedHosts = parseHostnames([
    process.env.ALLOWED_HOSTS,
    options?.allowedHosts?.join(','),
  ]);
  const allowedOriginHostnames = parseHostnames([
    process.env.ALLOWED_ORIGINS,
    options?.allowedOrigins?.join(','),
  ]);

  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedOriginHostnames);

  const server = http.createServer(async (req, res) => {
    // Validate Host header for DNS rebinding protection
    if (!validateHost(req, res)) {
      return;
    }

    // Validate Origin header if present
    if (!validateOrigin(req, res)) {
      return;
    }

    // Restrict CORS: only echo back validated origin when Origin header is present
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key, MCP-Protocol-Version, Mcp-Method, mcp-session-id',
      );
      res.setHeader(
        'Access-Control-Expose-Headers',
        'MCP-Protocol-Version, Content-Type, mcp-session-id',
      );
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url || (req.url !== '/mcp' && !req.url.startsWith('/mcp?'))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: 'Not Found',
          },
          id: null,
        }),
      );
      return;
    }

    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Session not found',
            },
            id: null,
          }),
        );
        return;
      }

      try {
        await session.transport.handleRequest(req, res);
      } catch (err) {
        console.error('Transport error on existing session:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Internal Server Error',
              },
              id: null,
            }),
          );
        }
      }
      return;
    }

    // No session ID provided
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Bad Request: Mcp-Session-Id header is required',
          },
          id: null,
        }),
      );
      return;
    }

    // New initialization request: create a fresh McpServer and NodeStreamableHTTPServerTransport
    const mcpServer = createServer({
      profile: activeProfile,
      allowedTools: options?.allowedTools,
    });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { transport, server: mcpServer });
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('Transport error on new session initialization:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal Server Error',
            },
            id: null,
          }),
        );
      }
    }
  });

  server.on('close', async () => {
    for (const [id, session] of sessions) {
      sessions.delete(id);
      try {
        await session.transport.close();
        await session.server.close();
      } catch {
        // ignore
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(err);
    });
    server.listen(port, () => {
      resolve(server);
    });
  });
}
