import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Acceptance-only dependency: use the independent SDK already pinned by the provider project. */
export async function officialMcp(root: string) {
  const require = createRequire(join(root, 'package.json'));
  const module = (name: string) => import(pathToFileURL(require.resolve(name)).href);
  const [{ McpServer }, { StreamableHTTPServerTransport }, { Client }, { StdioClientTransport }, { z }] = await Promise.all([
    module('@modelcontextprotocol/sdk/server/mcp.js'), module('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    module('@modelcontextprotocol/sdk/client/index.js'), module('@modelcontextprotocol/sdk/client/stdio.js'), module('zod'),
  ]);
  return { McpServer, StreamableHTTPServerTransport, Client, StdioClientTransport, z };
}
