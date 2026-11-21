function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  const path = value.startsWith('/') ? value : `/${value}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

const tmServerUrl = trimUrl(process.env.TM_SERVER_URL?.trim() || 'http://localhost:8888');

export const config = {
  tmServerUrl,
  tmPublicUrl: trimUrl(process.env.TM_PUBLIC_URL?.trim() || tmServerUrl),
  mcpHost: process.env.MCP_HOST?.trim() || '0.0.0.0',
  mcpPort: Math.floor(numberFromEnv('MCP_PORT', 8765)),
  mcpPath: normalizePath(process.env.MCP_PATH?.trim() || '/mcp'),
  authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
  minResponseIntervalMs: numberFromEnv('MIN_RESPONSE_INTERVAL_MS', 250),
  tmRequestTimeoutMs: numberFromEnv('TM_REQUEST_TIMEOUT_MS', 30000),
  waitDefaultMs: numberFromEnv('WAIT_DEFAULT_MS', 60000),
  waitPollMs: numberFromEnv('WAIT_POLL_MS', 500),
};

export type Config = typeof config;
