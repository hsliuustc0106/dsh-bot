import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_VERSION } from "./protocol.mjs";

export async function validateDshInstallation(cliPath: string): Promise<string> {
  if (!isAbsolute(cliPath)) throw new Error("DSH_CLI_PATH must be absolute");
  try {
    const path = await realpath(cliPath);
    const root = dirname(dirname(path));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (
      manifest.name !== "@deepseek-ai/dsh" ||
      manifest.version !== DSH_VERSION ||
      path !== join(root, "lib", "bin.js") ||
      !(await stat(path)).isFile()
    )
      throw new Error();
    return path;
  } catch {
    throw new Error(`DSH_CLI_PATH must point to @deepseek-ai/dsh ${DSH_VERSION} lib/bin.js`);
  }
}

export interface DshConnection {
  apiKey: string;
  baseUrl?: string;
  contextWindow?: number;
}

export function dshProfile(connection: DshConnection) {
  const plugin = (id: string, name: string, config?: Record<string, unknown>) => ({
    id,
    name,
    ...(config ? { config } : {}),
  });
  return [
    {
      insert: [
        plugin("llm", "@deepseek-ai/dsh-llm"),
        plugin("deepseek-extensions", "@deepseek-ai/dsh-deepseek-llm-api-extensions"),
        plugin("session-log-deepseek", "@deepseek-ai/dsh-session-log-deepseek"),
        plugin("llm-deepseek", "@deepseek-ai/dsh-llm-deepseek-api-key", {
          apiKeyEnv: "RAKAZO_MODEL_KEY",
          ...(connection.baseUrl ? { baseURL: connection.baseUrl } : {}),
          ...(connection.contextWindow ? { defaultContextWindow: connection.contextWindow } : {}),
        }),
        plugin("session", "@deepseek-ai/dsh-session"),
        plugin("session-projection", "@deepseek-ai/dsh-session-projection"),
        plugin("tools", "@deepseek-ai/dsh-tools"),
        plugin("system-prompt", "@deepseek-ai/dsh-system-prompt", {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
        }),
        plugin("agent", "@deepseek-ai/dsh-agent"),
        plugin("agent-loop", "@deepseek-ai/dsh-agent-loop", {
          agents: [],
          maxParallelToolCalls: 1,
        }),
        plugin("rakazo-bridge", fileURLToPath(new URL("./plugin.mjs", import.meta.url))),
      ],
    },
  ];
}
