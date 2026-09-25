import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../../src/mcp/http.js';
import { TRUEFORGE_READ_ONLY_TOOLS, TRUEFORGE_EXCLUDED_TOOLS } from '../../src/config/trueforge.js';

describe('TrueForge Read-Only Integration MCP Test (Step 15.1)', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-mcp-integration-test-'));

    // Start HTTP server using the TrueForge read-only profile
    server = await createHttpServer(0, { profile: 'trueforge-read-only' });
    const addr = server.address() as AddressInfo;
    serverPort = addr.port;
    serverUrl = `http://localhost:${serverPort}/mcp`;

    client = new Client(
      { name: 'trueforge-integration-tester', version: '0.1.0' },
      { capabilities: {} },
    );
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client.connect(transport);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes exactly the 8 approved read-only tools and no more', async () => {
    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name);

    // Exactly 8 tools
    expect(toolNames).toHaveLength(8);
    expect(toolNames.sort()).toEqual([...TRUEFORGE_READ_ONLY_TOOLS].sort());

    for (const tool of TRUEFORGE_READ_ONLY_TOOLS) {
      expect(toolNames).toContain(tool);
    }
  });

  it('strictly excludes all 6 approval, quarantine, restoration, and deletion tools', async () => {
    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name);

    for (const excludedTool of TRUEFORGE_EXCLUDED_TOOLS) {
      expect(toolNames).not.toContain(excludedTool);
    }
  });

  it('strictly excludes generic filesystem mutation and shell execution tools', async () => {
    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name);

    expect(toolNames).not.toContain('delete');
    expect(toolNames).not.toContain('delete_file');
    expect(toolNames).not.toContain('delete_all');
    expect(toolNames).not.toContain('force_delete');
    expect(toolNames).not.toContain('purge_quarantine');
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('read_file');
    expect(toolNames).not.toContain('move_file');
    expect(toolNames).not.toContain('execute_shell');
    expect(toolNames).not.toContain('run_command');
    expect(toolNames).not.toContain('exec');
    expect(toolNames).not.toContain('spawn');
  });

  it('can successfully invoke allowed read-only tools (health_check, scan_files, analyze_cleanup)', async () => {
    // 1. health_check
    const health = await client.callTool({ name: 'health_check', arguments: {} });
    expect(health.isError).toBeFalsy();
    const healthData = JSON.parse((health.content[0] as { text: string }).text);
    expect(healthData.status).toBe('ok');

    // 2. scan_files
    const sampleFile = path.join(tempDir, 'fixture.txt');
    await fs.writeFile(sampleFile, 'trueforge-test-data');
    const scan = await client.callTool({
      name: 'scan_files',
      arguments: { rootPath: tempDir, maxDepth: 2, maxResults: 10 },
    });
    expect(scan.isError).toBeFalsy();
    const scanData = JSON.parse((scan.content[0] as { text: string }).text);
    expect(scanData.totalEntries).toBeGreaterThanOrEqual(1);

    // 3. analyze_cleanup
    const analysis = await client.callTool({
      name: 'analyze_cleanup',
      arguments: { files: scanData },
    });
    expect(analysis.isError).toBeFalsy();
    const analysisData = JSON.parse((analysis.content[0] as { text: string }).text);
    expect(typeof analysisData.totalFindings).toBe('number');
  });

  it('rejects attempts to invoke excluded tools with tool-not-found error', async () => {
    await expect(
      client.callTool({
        name: 'quarantine_approved',
        arguments: { payload: {}, quarantineRoot: tempDir },
      }),
    ).rejects.toThrow();

    await expect(
      client.callTool({
        name: 'delete_verified',
        arguments: { payload: {}, quarantineRoot: tempDir },
      }),
    ).rejects.toThrow();

    await expect(
      client.callTool({
        name: 'evaluate_cleanup_approval',
        arguments: { plan: {}, request: {} },
      }),
    ).rejects.toThrow();
  });

  it('E. proves no credentials or secrets are required by this local configuration', async () => {
    // Normal connection with empty capabilities and no auth headers succeeds
    const unauthenticatedClient = new Client(
      { name: 'unauthenticated-local-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const unauthTransport = new StreamableHTTPClientTransport(new URL(serverUrl));
    await unauthenticatedClient.connect(unauthTransport);

    const tools = await unauthenticatedClient.listTools();
    expect(tools.tools).toHaveLength(8);

    const health = await unauthenticatedClient.callTool({
      name: 'health_check',
      arguments: {},
    });
    expect(health.isError).toBeFalsy();

    await unauthenticatedClient.close();
  });

  it('B. starting HTTP server without a profile preserves the existing full tool set (14 tools)', async () => {
    // Start fresh server with default settings (no profile specified)
    const defaultServer = await createHttpServer(0);
    const addr = defaultServer.address() as AddressInfo;
    const defaultUrl = `http://localhost:${addr.port}/mcp`;

    const defaultClient = new Client(
      { name: 'default-profile-tester', version: '0.1.0' },
      { capabilities: {} },
    );
    const defaultTransport = new StreamableHTTPClientTransport(new URL(defaultUrl));
    await defaultClient.connect(defaultTransport);

    try {
      const listResult = await defaultClient.listTools();
      const toolNames = listResult.tools.map((t) => t.name);

      // Full server must contain all 14 tools
      expect(toolNames).toHaveLength(14);
      expect(toolNames).toContain('health_check');
      expect(toolNames).toContain('quarantine_approved');
      expect(toolNames).toContain('delete_verified');
      expect(toolNames).toContain('evaluate_cleanup_approval');
      expect(toolNames).toContain('restore_quarantine');
      expect(toolNames).toContain('evaluate_deletion');
      expect(toolNames).toContain('verify_quarantine');
    } finally {
      await defaultClient.close();
      defaultServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        defaultServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('F. starting HTTP server with MCP_PROFILE=trueforge-read-only environment variable exposes exactly 8 tools', async () => {
    const originalEnv = process.env.MCP_PROFILE;
    process.env.MCP_PROFILE = 'trueforge-read-only';

    let envServer: http.Server | undefined;
    let envClient: Client | undefined;

    try {
      envServer = await createHttpServer(0);
      const addr = envServer.address() as AddressInfo;
      const envUrl = `http://localhost:${addr.port}/mcp`;

      envClient = new Client(
        { name: 'env-profile-tester', version: '0.1.0' },
        { capabilities: {} },
      );
      const envTransport = new StreamableHTTPClientTransport(new URL(envUrl));
      await envClient.connect(envTransport);

      const listResult = await envClient.listTools();
      const toolNames = listResult.tools.map((t) => t.name);

      expect(toolNames).toHaveLength(8);
      expect(toolNames.sort()).toEqual([...TRUEFORGE_READ_ONLY_TOOLS].sort());
      for (const excluded of TRUEFORGE_EXCLUDED_TOOLS) {
        expect(toolNames).not.toContain(excluded);
      }
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MCP_PROFILE;
      } else {
        process.env.MCP_PROFILE = originalEnv;
      }
      if (envClient) {
        await envClient.close();
      }
      if (envServer) {
        envServer.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
          envServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  it('G. strictly rejects invalid MCP_PROFILE environment variable with descriptive error', async () => {
    const originalEnv = process.env.MCP_PROFILE;
    process.env.MCP_PROFILE = 'invalid-override-profile';

    try {
      await expect(createHttpServer(0)).rejects.toThrow(
        /Invalid MCP_PROFILE environment variable/i,
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MCP_PROFILE;
      } else {
        process.env.MCP_PROFILE = originalEnv;
      }
    }
  });

  it('C. preserves session isolation under the TrueForge read-only profile', async () => {
    const clientB = new Client(
      { name: 'trueforge-client-b', version: '0.1.0' },
      { capabilities: {} },
    );
    const transportB = new StreamableHTTPClientTransport(new URL(serverUrl));
    await clientB.connect(transportB);

    const [toolsA, toolsB] = await Promise.all([client.listTools(), clientB.listTools()]);
    expect(toolsA.tools).toHaveLength(8);
    expect(toolsB.tools).toHaveLength(8);

    const [healthA, healthB] = await Promise.all([
      client.callTool({ name: 'health_check', arguments: {} }),
      clientB.callTool({ name: 'health_check', arguments: {} }),
    ]);

    expect((healthA.content[0] as { text: string }).text).toBe(
      (healthB.content[0] as { text: string }).text,
    );

    await clientB.close();
  });
});
