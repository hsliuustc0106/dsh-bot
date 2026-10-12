import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DSH_VERSION, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "../../../protocol.mjs";

let seq = 0;
let request;
const input = createInterface({ input: process.stdin });
const send = (message) =>
  process.stdout.write(
    `${JSON.stringify({ v: PROTOCOL_VERSION, sessionId: process.env.RAKAZO_RUN_ID, seq: seq++, ...message })}\n`,
  );
const tool = (callId = "echo-1", name = "echo") =>
  send({ type: "tool", callId, name, args: { text: "example" } });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "cancel") {
    if (request?.prompt === "late") tool("late-call");
    return;
  }
  if (message.type === "configure") {
    request = message;
    if (request.prompt === "malformed") {
      process.stdout.write("private-diagnostic-not-json\n");
      return;
    }
    if (request.prompt === "oversize") {
      process.stdout.write("x".repeat(MAX_FRAME_BYTES + 1));
      return;
    }
    if (request.prompt === "hang-startup") return;
    if (request.prompt === "early-tool") {
      tool();
      return;
    }
    const tools =
      request.prompt === "toolset"
        ? [...request.tools, { name: "shell", description: "Forbidden", inputSchema: {} }]
        : request.tools;
    if (request.prompt === "schema") tools[0].inputSchema = { type: "string" };
    send({
      type: "configured",
      tools,
      ...(request.prompt === "version" ? { v: 2 } : {}),
      ...(request.prompt === "session" ? { sessionId: "another-session" } : {}),
    });
  } else if (message.type === "proceed") {
    if (request.prompt === "crash") process.exit(9);
    send({ type: "started" });
    if (request.prompt === "inspect") {
      send({
        type: "text",
        text: JSON.stringify({
          home: process.env.DSH_HOME,
          history: request.history,
          tools: request.tools,
          inherited: ["DATABASE_URL", "NODE_OPTIONS", "HTTPS_PROXY"].some(
            (key) => process.env[key] !== undefined,
          ),
          plugins: JSON.parse(
            readFileSync(`${process.env.DSH_HOME}/profiles/rakazo/cordis.patch.yml`, "utf8"),
          )[0].insert.map((entry) => entry.name),
        }),
      });
      send({ type: "done" });
      return;
    }
    if (request.prompt === "wait") return;
    if (request.prompt === "read") {
      send({ type: "tool", callId: "read-1", name: "read_file", args: { path: "README.md" } });
      return;
    }
    if (request.prompt === "unknown") {
      tool("shell-1", "shell");
      return;
    }
    tool();
    if (request.prompt === "duplicate") tool();
  } else if (message.type === "tool-result") {
    send({ type: "text", text: String(message.result) });
    send({ type: "usage", callId: "attempt-1", usage: { inputTokens: 8, outputTokens: 3 } });
    send({ type: "done" });
  }
});
send({ type: "ready", runtimeVersion: DSH_VERSION });
