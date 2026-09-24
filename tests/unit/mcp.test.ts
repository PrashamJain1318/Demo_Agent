import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/mcp/server.js';
import { InMemoryTransport, JSONRPCMessage } from '@modelcontextprotocol/server';

describe('MCP Server', () => {
  it('can be constructed', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it('health_check tool exists and returns expected response', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const responses: JSONRPCMessage[] = [];
    clientTransport.onmessage = (msg: JSONRPCMessage) => {
      responses.push(msg);
    };

    // Simulate initialize request
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'notifications/initialized',
      params: {},
    });

    // Simulate calling the health_check tool
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'health_check',
        arguments: {},
      },
    });

    // Wait a short moment for promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Find the tool response
    const toolResponse = responses.find((msg) => 'id' in msg && msg.id === 3) as
      { result: { content: { type: string; text: string }[] } } | undefined;
    expect(toolResponse).toBeDefined();
    expect(toolResponse?.result).toBeDefined();
    expect(toolResponse?.result.content).toHaveLength(1);
    expect(toolResponse?.result.content[0].type).toBe('text');

    const contentText = toolResponse?.result.content[0].text;
    const parsed = contentText ? JSON.parse(contentText) : null;
    expect(parsed).toEqual({
      status: 'ok',
      service: 'digital-janitor-mcp',
      version: '0.1.0',
    });
  });
});
