import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpServer } from '../../src/mcp/http.js';

describe('MCP Client Integration Test', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;

  beforeAll(async () => {
    // 1. Start actual Digital Janitor HTTP MCP server on ephemeral test port (port 0)
    server = await createHttpServer(0);
    const addr = server.address() as AddressInfo;
    serverPort = addr.port;
    serverUrl = `http://localhost:${serverPort}/mcp`;
  });

  afterAll(async () => {
    // 14. Shut down the HTTP server & 15. Ensure no background process remains
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('connects via real StreamableHTTPClientTransport, negotiates, lists tools, and executes health_check', async () => {
    // 2. Create a real MCP Client from @modelcontextprotocol/client
    const client = new Client(
      {
        name: 'digital-janitor-integration-tester',
        version: '0.1.0',
      },
      {
        capabilities: {},
      },
    );

    // 3. Create StreamableHTTPClientTransport pointing to http://localhost:<test-port>/mcp
    // 4. Connect to http://localhost:<test-port>/mcp
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    // 5. Allow normal SDK negotiation behavior (no hard-coded obsolete version or manual JSON-RPC initialize)
    await client.connect(transport);

    // 9. Call listTools() through MCP client
    const toolsResult = await client.listTools();

    // 10. Verify health_check, scan_files, scan_git_repository, scan_dependencies, scan_cache, and scan_docker exist
    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain('health_check');
    expect(toolNames).toContain('scan_files');
    expect(toolNames).toContain('scan_git_repository');
    expect(toolNames).toContain('scan_dependencies');
    expect(toolNames).toContain('scan_cache');
    expect(toolNames).toContain('scan_docker');

    const healthCheckTool = toolsResult.tools.find((t) => t.name === 'health_check');
    expect(healthCheckTool).toBeDefined();
    expect(healthCheckTool?.name).toBe('health_check');
    expect(healthCheckTool?.description).toBe(
      'Returns the health status of the Digital Janitor MCP server.',
    );

    const scanFilesTool = toolsResult.tools.find((t) => t.name === 'scan_files');
    expect(scanFilesTool).toBeDefined();
    expect(scanFilesTool?.name).toBe('scan_files');
    expect(scanFilesTool?.description).toBe(
      'Performs a safe, read-only filesystem discovery scan under the specified root directory.',
    );

    const scanGitTool = toolsResult.tools.find((t) => t.name === 'scan_git_repository');
    expect(scanGitTool).toBeDefined();
    expect(scanGitTool?.name).toBe('scan_git_repository');
    expect(scanGitTool?.description).toBe(
      'Performs a safe, read-only inspection of a Git repository, collecting branch, commit, and object storage metrics.',
    );

    const scanDepsTool = toolsResult.tools.find((t) => t.name === 'scan_dependencies');
    expect(scanDepsTool).toBeDefined();
    expect(scanDepsTool?.name).toBe('scan_dependencies');
    expect(scanDepsTool?.description).toBe(
      'Performs a safe, read-only inspection of Node.js project dependencies declared in package.json and installed in node_modules.',
    );

    const scanCacheTool = toolsResult.tools.find((t) => t.name === 'scan_cache');
    expect(scanCacheTool).toBeDefined();
    expect(scanCacheTool?.name).toBe('scan_cache');
    expect(scanCacheTool?.description).toBe(
      'Performs a safe, read-only discovery scan for common application, package manager, and framework cache directories.',
    );

    const scanDockerTool = toolsResult.tools.find((t) => t.name === 'scan_docker');
    expect(scanDockerTool).toBeDefined();
    expect(scanDockerTool?.name).toBe('scan_docker');
    expect(scanDockerTool?.description).toBe(
      'Performs a safe, read-only inventory of Docker containers, images, volumes, networks, and build cache.',
    );

    // 11. Call health_check through MCP client
    const callResult = await client.callTool({
      name: 'health_check',
      arguments: {},
    });

    // 12. Verify returned result contains expected status/service/version
    expect(callResult).toBeDefined();
    expect(callResult.content).toBeDefined();
    expect(Array.isArray(callResult.content)).toBe(true);
    expect(callResult.content.length).toBeGreaterThan(0);

    const firstContent = callResult.content[0] as { type: string; text: string };
    expect(firstContent.type).toBe('text');

    const parsed = JSON.parse(firstContent.text);
    expect(parsed).toEqual({
      status: 'ok',
      service: 'digital-janitor-mcp',
      version: '0.1.0',
    });

    // Test scan_files MCP tool over the real HTTP connection
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-fixture-'));
    const testFile = path.join(fixtureDir, 'sample.txt');
    await fs.writeFile(testFile, 'hello world content');

    // Setup minimal Git repository fixture for scan_git_repository test
    const gitDir = path.join(fixtureDir, '.git');
    const objectsDir = path.join(gitDir, 'objects', '12');
    const refsHeads = path.join(gitDir, 'refs', 'heads');
    await fs.mkdir(objectsDir, { recursive: true });
    await fs.mkdir(refsHeads, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(refsHeads, 'main'), '0123456789abcdef0123456789abcdef01234567\n');
    await fs.writeFile(
      path.join(objectsDir, '34567890abcdef0123456789abcdef01234567'),
      'loose-object-data',
    );

    // Setup minimal package.json for scan_dependencies test
    await fs.writeFile(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        dependencies: {
          lodash: '^4.17.21',
        },
      }),
    );

    // Setup cache directories for scan_cache test
    const npmCache = path.join(fixtureDir, '.npm');
    const nextCache = path.join(fixtureDir, '.next', 'cache');
    await fs.mkdir(npmCache, { recursive: true });
    await fs.mkdir(nextCache, { recursive: true });
    await fs.writeFile(path.join(npmCache, 'npm-cache-data.bin'), 'npm-cache-content');
    await fs.writeFile(path.join(nextCache, 'next-cache-data.json'), '{"next": true}');

    try {
      const scanResult = await client.callTool({
        name: 'scan_files',
        arguments: {
          rootPath: fixtureDir,
          maxDepth: 2,
          maxResults: 50,
        },
      });

      expect(scanResult.isError).toBeFalsy();
      expect(scanResult.content).toBeDefined();
      const content = scanResult.content[0] as { type: string; text: string };
      expect(content.type).toBe('text');

      const parsedScan = JSON.parse(content.text);
      expect(parsedScan.rootPath).toBe(path.resolve(fixtureDir));
      expect(parsedScan.truncated).toBe(false);
      expect(parsedScan.totalEntries).toBeGreaterThanOrEqual(1);

      const sampleEntry = parsedScan.entries.find(
        (e: { relativePath: string }) => e.relativePath === 'sample.txt',
      );
      expect(sampleEntry).toBeDefined();
      expect(sampleEntry.type).toBe('file');
      expect(sampleEntry.sizeBytes).toBe('hello world content'.length);
      expect(sampleEntry.extension).toBe('.txt');
      expect(sampleEntry.modifiedAt).toBeDefined();

      // Test scan_git_repository MCP tool over HTTP
      const gitResult = await client.callTool({
        name: 'scan_git_repository',
        arguments: {
          rootPath: fixtureDir,
        },
      });

      expect(gitResult.isError).toBeFalsy();
      expect(gitResult.content).toBeDefined();
      const gitContent = gitResult.content[0] as { type: string; text: string };
      expect(gitContent.type).toBe('text');

      const parsedGit = JSON.parse(gitContent.text);
      expect(parsedGit.isRepository).toBe(true);
      expect(parsedGit.rootPath).toBe(path.resolve(fixtureDir));
      expect(parsedGit.gitDirectoryType).toBe('directory');
      expect(parsedGit.branch).toBe('main');
      expect(parsedGit.head).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(parsedGit.looseObjectCount).toBe(1);
      expect(parsedGit.packCount).toBe(0);
      expect(parsedGit.repositorySizeBytes).toBeGreaterThan(0);
      expect('objectCount' in parsedGit).toBe(false);
      expect(parsedGit.truncated).toBe(false);

      // Test scan_dependencies MCP tool over HTTP verifying both limit parameters
      const depResult = await client.callTool({
        name: 'scan_dependencies',
        arguments: {
          rootPath: fixtureDir,
          maxDependencies: 50,
          maxInstalledDependencies: 50,
        },
      });

      expect(depResult.isError).toBeFalsy();
      expect(depResult.content).toBeDefined();
      const depContent = depResult.content[0] as { type: string; text: string };
      expect(depContent.type).toBe('text');

      const parsedDep = JSON.parse(depContent.text);
      expect(parsedDep.manifestFound).toBe(true);
      expect(parsedDep.manifestType).toBe('package.json');
      expect(parsedDep.totalDependencies).toBe(1);
      expect(parsedDep.dependencies[0]).toEqual({
        name: 'lodash',
        requestedVersion: '^4.17.21',
        dependencyType: 'production',
      });
      expect(parsedDep.truncated).toBe(false);

      // Test scan_cache MCP tool over HTTP
      const cacheResult = await client.callTool({
        name: 'scan_cache',
        arguments: {
          rootPath: fixtureDir,
          maxDepth: 4,
          maxResults: 50,
        },
      });

      expect(cacheResult.isError).toBeFalsy();
      expect(cacheResult.content).toBeDefined();
      const cacheContent = cacheResult.content[0] as { type: string; text: string };
      expect(cacheContent.type).toBe('text');

      const parsedCache = JSON.parse(cacheContent.text);
      expect(parsedCache.rootPath).toBe(path.resolve(fixtureDir));
      expect(parsedCache.caches.length).toBeGreaterThanOrEqual(2);
      expect(parsedCache.totalCacheSizeBytes).toBeGreaterThan(0);
      expect(parsedCache.totalCacheEntries).toBeGreaterThanOrEqual(2);
      expect(parsedCache.truncated).toBe(false);

      const npmEntry = parsedCache.caches.find((c: { type: string }) => c.type === 'npm');
      const nextEntry = parsedCache.caches.find((c: { type: string }) => c.type === 'next');
      expect(npmEntry).toBeDefined();
      expect(nextEntry).toBeDefined();

      // Test scan_docker MCP tool over HTTP
      const dockerResult = await client.callTool({
        name: 'scan_docker',
        arguments: {
          maxContainers: 10,
          maxImages: 10,
        },
      });

      expect(dockerResult.isError).toBeFalsy();
      expect(dockerResult.content).toBeDefined();
      const dockerContent = dockerResult.content[0] as { type: string; text: string };
      expect(dockerContent.type).toBe('text');

      const parsedDocker = JSON.parse(dockerContent.text);
      expect(typeof parsedDocker.dockerAvailable).toBe('boolean');
      expect(Array.isArray(parsedDocker.containers)).toBe(true);
      expect(Array.isArray(parsedDocker.images)).toBe(true);
      expect(Array.isArray(parsedDocker.volumes)).toBe(true);
      expect(Array.isArray(parsedDocker.networks)).toBe(true);
      expect(Array.isArray(parsedDocker.buildCache)).toBe(true);
      expect(typeof parsedDocker.totalReclaimableBytes).toBe('number');
      expect(Array.isArray(parsedDocker.warnings)).toBe(true);
      expect(typeof parsedDocker.truncated).toBe('boolean');

      if (!parsedDocker.dockerAvailable) {
        expect(parsedDocker.warnings.length).toBeGreaterThan(0);
        expect(typeof parsedDocker.warnings[0]).toBe('string');
        expect(parsedDocker.warnings[0].toLowerCase()).toContain('docker');
      }
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }

    // 13. Close the MCP client
    await client.close();
  });

  it('rejects unauthorized Host header for DNS rebinding protection', async () => {
    const res = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'unauthorized-external-domain.com',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => resolve({ statusCode: response.statusCode, body: data }));
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      req.end();
    });

    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toContain('Invalid Host');
  });

  it('rejects untrusted Origin header', async () => {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        Origin: 'https://malicious-site.example',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('Invalid Origin');
  });

  it('allows trusted Origin and echoes only that origin without wildcard *', async () => {
    const res = await fetch(serverUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('supports sequential client connections (Client #1 then Client #2) without "Server already initialized"', async () => {
    // Client #1
    const client1 = new Client({ name: 'client-1', version: '1.0.0' }, { capabilities: {} });
    const transport1 = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client1.connect(transport1);

    const tools1 = await client1.listTools();
    expect(tools1.tools.map((t) => t.name)).toContain('health_check');

    const health1 = await client1.callTool({ name: 'health_check', arguments: {} });
    expect(health1.content[0].type).toBe('text');
    expect(JSON.parse((health1.content[0] as { text: string }).text).status).toBe('ok');

    await client1.close();

    // Client #2 with fresh StreamableHTTPClientTransport
    const client2 = new Client({ name: 'client-2', version: '1.0.0' }, { capabilities: {} });
    const transport2 = new StreamableHTTPClientTransport(new URL(serverUrl));
    await client2.connect(transport2);

    const tools2 = await client2.listTools();
    expect(tools2.tools.map((t) => t.name)).toContain('health_check');

    const health2 = await client2.callTool({ name: 'health_check', arguments: {} });
    expect(health2.content[0].type).toBe('text');
    expect(JSON.parse((health2.content[0] as { text: string }).text).status).toBe('ok');

    await client2.close();
  });

  it('supports two independent clients establishing separate concurrent sessions without collision', async () => {
    const clientA = new Client(
      { name: 'client-concurrent-a', version: '1.0.0' },
      { capabilities: {} },
    );
    const transportA = new StreamableHTTPClientTransport(new URL(serverUrl));
    await clientA.connect(transportA);

    const clientB = new Client(
      { name: 'client-concurrent-b', version: '1.0.0' },
      { capabilities: {} },
    );
    const transportB = new StreamableHTTPClientTransport(new URL(serverUrl));
    await clientB.connect(transportB);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);

    expect(toolsA.tools.map((t) => t.name)).toContain('health_check');
    expect(toolsB.tools.map((t) => t.name)).toContain('health_check');

    const [healthA, healthB] = await Promise.all([
      clientA.callTool({ name: 'health_check', arguments: {} }),
      clientB.callTool({ name: 'health_check', arguments: {} }),
    ]);

    expect(JSON.parse((healthA.content[0] as { text: string }).text).status).toBe('ok');
    expect(JSON.parse((healthB.content[0] as { text: string }).text).status).toBe('ok');

    await Promise.all([clientA.close(), clientB.close()]);
  });
});
