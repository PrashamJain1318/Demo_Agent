import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { createServer } from './server.js';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/node';

export interface HttpServerOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
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

export async function createHttpServer(
  port: number,
  options?: HttpServerOptions,
): Promise<http.Server> {
  const mcpServer = createServer();

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await mcpServer.connect(transport);

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

  const server = http.createServer((req, res) => {
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
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key, MCP-Protocol-Version, Mcp-Method',
      );
      res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Content-Type');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url && (req.url === '/mcp' || req.url.startsWith('/mcp?'))) {
      transport.handleRequest(req, res).catch((err) => {
        console.error('Transport error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
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
