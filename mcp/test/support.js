// Re-exported for the sandbox tests in demo/test, which drive this server
// over stdio from outside this package.
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
