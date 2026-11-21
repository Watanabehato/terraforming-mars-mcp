import {randomUUID, timingSafeEqual} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import express, {type NextFunction, type Request, type Response} from 'express';
import {config} from './config.js';
import {SessionContext, registerTools} from './tools.js';

const sessions = new Map<string, StreamableHTTPServerTransport>();

function sessionIdOf(req: Request): string | undefined {
  const value = req.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {code: -32000, message},
    id: null,
  });
}

function authorized(req: Request): boolean {
  if (config.authToken === undefined) {
    return true;
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const expected = `Bearer ${config.authToken}`;
  return header.length === expected.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function createSession(): Promise<StreamableHTTPServerTransport> {
  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
    },
    enableJsonResponse: true,
  });
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId !== undefined) {
      sessions.delete(sessionId);
    }
  };

  const server = new McpServer({
    name: 'terraforming-mars-mcp',
    version: '0.1.0',
  });
  registerTools(server, new SessionContext(config));
  await server.connect(transport);
  return transport;
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({limit: '2mb'}));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size,
    tm_server_url: config.tmServerUrl,
    tm_public_url: config.tmPublicUrl,
    mcp_endpoint: config.mcpPath,
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'terraforming-mars-mcp',
    transport: 'streamable-http',
    endpoint: config.mcpPath,
    auth: config.authToken === undefined ? 'none' : 'bearer',
  });
});

app.use(config.mcpPath, (req, res, next) => {
  if (!authorized(req)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {code: -32001, message: 'Unauthorized'},
      id: null,
    });
    return;
  }
  next();
});

app.post(config.mcpPath, async (req, res) => {
  const sessionId = sessionIdOf(req);
  let transport = sessionId === undefined ? undefined : sessions.get(sessionId);
  if (transport === undefined) {
    if (sessionId !== undefined) {
      rpcError(res, 404, 'MCP session not found or expired. Start a new initialize request.');
      return;
    }
    if (!isInitializeRequest(req.body)) {
      rpcError(res, 400, 'Bad Request: no valid MCP session ID and not an initialize request.');
      return;
    }
    try {
      transport = await createSession();
    } catch (error) {
      console.error('Failed to initialize MCP session', error);
      rpcError(res, 500, 'Failed to initialize MCP session.');
      return;
    }
  }
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP POST failed', error);
    if (!res.headersSent) {
      rpcError(res, 500, 'MCP request failed.');
    } else {
      res.end();
    }
  }
});

app.get(config.mcpPath, async (req, res) => {
  const sessionId = sessionIdOf(req);
  const transport = sessionId === undefined ? undefined : sessions.get(sessionId);
  if (transport === undefined) {
    rpcError(res, 400, 'MCP session ID is required for GET.');
    return;
  }
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('MCP GET failed', error);
    if (!res.headersSent) {
      rpcError(res, 500, 'MCP stream failed.');
    }
  }
});

app.delete(config.mcpPath, async (req, res) => {
  const sessionId = sessionIdOf(req);
  const transport = sessionId === undefined ? undefined : sessions.get(sessionId);
  if (transport === undefined) {
    rpcError(res, 404, 'MCP session not found or expired.');
    return;
  }
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('MCP DELETE failed', error);
    if (!res.headersSent) {
      rpcError(res, 500, 'MCP session close failed.');
    }
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('HTTP request error', error);
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = (error as {status?: unknown}).status;
  const clientError = typeof status === 'number' && status >= 400 && status < 500;
  rpcError(res, clientError ? status : 500, clientError ? 'Invalid request body.' : 'Internal server error.');
});

const httpServer = app.listen(config.mcpPort, config.mcpHost, () => {
  console.log(
    `terraforming-mars-mcp on http://${config.mcpHost}:${config.mcpPort}${config.mcpPath} ` +
    `(TM ${config.tmServerUrl}, auth ${config.authToken === undefined ? 'off' : 'bearer'})`,
  );
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0));
});
