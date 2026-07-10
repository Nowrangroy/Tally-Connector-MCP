process.on('uncaughtException', (err) => {
    console.error('[Tally MCP] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
    console.error('[Tally MCP] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMcpServer } from './mcp.mjs';
const mcpServer = await registerMcpServer();
const transport = new StdioServerTransport(); // Start receiving messages on stdin and sending messages on stdout
await mcpServer.connect(transport); // Connect to the MCP server
// Keep process alive after fast/empty tool responses in Claude Desktop extension host.
setInterval(() => {}, 1 << 30);
//# sourceMappingURL=index.mjs.map