import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MCP_CONFIG_PATH = join(homedir(), ".hermes-agent-gui", "mcp.json");

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

interface McpServerStatus extends McpServerConfig {
  connected: boolean;
}

const clients = new Map<string, Client>();
let configs: McpServerConfig[] = loadConfig();

function loadConfig(): McpServerConfig[] {
  if (!existsSync(MCP_CONFIG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveConfig() {
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(configs, null, 2));
}

export async function connectServer(config: McpServerConfig) {
  if (clients.has(config.name)) {
    await disconnectServer(config.name);
  }
  let transport;
  if (config.transport === "sse" && config.url) {
    transport = new SSEClientTransport(new URL(config.url));
  } else if (config.transport === "stdio" && config.command) {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...config.env } as any,
    });
  } else {
    throw new Error("Invalid MCP transport configuration");
  }
  const client = new Client(
    { name: "hermes-gui", version: "0.5.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  clients.set(config.name, client);
  return client;
}

export async function disconnectServer(name: string) {
  const client = clients.get(name);
  if (client) {
    await client.close();
    clients.delete(name);
  }
}

export async function listMcpServers(): Promise<McpServerStatus[]> {
  return configs.map((c) => ({
    ...c,
    connected: clients.has(c.name),
  }));
}

export async function addMcpServer(config: McpServerConfig) {
  const idx = configs.findIndex((c) => c.name === config.name);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
  }
  saveConfig();
  if (config.enabled !== false) {
    try {
      await connectServer(config);
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }
  return { success: true };
}

export async function removeMcpServer(name: string) {
  const idx = configs.findIndex((c) => c.name === name);
  if (idx >= 0) configs.splice(idx, 1);
  saveConfig();
  await disconnectServer(name);
  return { success: true };
}

export async function listMcpTools() {
  const allTools: any[] = [];
  for (const [name, client] of clients.entries()) {
    try {
      const result = await client.listTools();
      for (const tool of (result as any).tools || []) {
        allTools.push({ ...tool, server: name });
      }
    } catch (e) {
      console.error(`[MCP] Failed to list tools from ${name}:`, e);
    }
  }
  return { tools: allTools };
}

export async function callMcpTool({
  server,
  name,
  arguments: args,
}: {
  server: string;
  name: string;
  arguments: any;
}) {
  const client = clients.get(server);
  if (!client) throw new Error(`MCP server ${server} not connected`);
  return await client.callTool({ name, arguments: args });
}

export async function initMcpManager() {
  configs = loadConfig();
  for (const config of configs) {
    if (config.enabled !== false) {
      try {
        await connectServer(config);
      } catch (e) {
        console.error(`[MCP] Auto-connect failed for ${config.name}:`, e);
      }
    }
  }
}
