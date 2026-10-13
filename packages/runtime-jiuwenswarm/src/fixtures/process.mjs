import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const marker = process.argv[3];
const lines = createInterface({ input: process.stdin });
let request;
let sequence = 0;
let callbacks = 0;
const emit = (value) =>
  process.stdout.write(
    `${JSON.stringify({
      schema_version: "0.1",
      request_id: request.request_id,
      session_id: "session",
      sequence: sequence++,
      ...value,
    })}\n`,
  );
const event = (event_type, payload) => emit({ type: "event", event_type, payload });
const errors = { "session-busy": "SESSION_BUSY", "session-missing": "SESSION_NOT_FOUND", "turn-limit": "TURN_LIMIT_EXCEEDED", "cost-limit": "BUDGET_EXCEEDED" };
const finish = (code = 0) => {
  emit({
    type: "result",
    status: code ? "failed" : "completed",
    exit_code: code,
    error: code ? { code: errors[mode] ?? "FAILED", message: "fixture failure" } : null,
    output: "hello",
    output_json: null,
    usage: mode === "turn-limit" || mode === "cost-limit"
      ? { input_tokens: 10, output_tokens: 2, cache_tokens: 0, total_tokens: 12, total_cost: 0.02 }
      : {},
  });
  lines.close();
  process.exit(code);
};
lines.on("line", (line) => {
  if (request) {
    const response = JSON.parse(line);
    if (response.type === "cancel") process.exit(130);
    if (mode.startsWith("host-") && response.type === "tool_result") {
      if (mode === "host-duplicate" && callbacks++ === 0) {
        event("host_tool.requested", {
          call_id: "call",
          name: request.host_tools[0].name,
          arguments: { path: "example.txt" },
        });
      } else finish();
    }
    if (mode === "cancel" || mode === "pending") process.exit(130);
    return;
  }
  request = JSON.parse(line);
  if (marker)
    writeFileSync(
      marker,
      JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env, request, config: JSON.parse(readFileSync(`${process.env.JIUWENSWARM_CONFIG_DIR}/config.yaml`, "utf8")) }),
    );
  if (mode.startsWith("host-")) {
    event("host_tool.requested", {
      call_id: "call",
      name: request.host_tools[0].name,
      arguments:
        mode === "host-question"
          ? { question: "Which file?", options: ["A", "B"] }
          : { path: "example.txt" },
    });
    return;
  }
  if (mode === "hang" || mode === "pending") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("{broken\n");
    return;
  }
  if (mode === "crash") process.exit(1);
  if (mode === "oversize") {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
    return;
  }
  if (mode === "foreign") request.request_id = "foreign";
  event("chat.delta", { text: "hello" });
  if (mode === "cancel") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "tool")
    event("host_tool.requested", { call_id: "call", name: "write_file", arguments: {} });
  if (mode === "native-tool") event("chat.tool_call", { tool: { name: "write_file" } });
  if (mode === "flood") {
    for (let i = 0; i < 600; i++) event("chat.delta", { text: "x" });
  }
  if (mode === "eof") {
    event("chat.final", { text: "hello" });
    process.exit(0);
  }
  if (mode === "wrong-exit") {
    emit({
      type: "result",
      status: "completed",
      exit_code: 0,
      error: null,
      output: "hello",
      usage: {},
    });
    process.exit(1);
  }
  finish(mode === "failed" || errors[mode] ? 1 : 0);
});
