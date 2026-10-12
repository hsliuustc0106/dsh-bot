/** Import only closed text messages. Historical content never becomes executable
 * tool-call blocks, queued prompts, usage, or a resumable Harness checkpoint. */
export function historySeed(history, sessionId) {
  const seed = [];
  const append = (type, data, message = false) =>
    seed.push({
      type,
      seq: seed.length,
      time: seed.length,
      ...(message ? { surfaceOp: "append" } : {}),
      data,
    });
  for (const [index, entry] of history.entries()) {
    const turn = index + 1;
    const step = 1;
    const message = {
      id: `${sessionId}:history:${index}`,
      role: entry.role,
      content: [{ type: "text", text: entry.content }],
      source:
        entry.role === "assistant"
          ? { kind: "model", provider: "rakazo-history", model: "imported" }
          : entry.role === "system"
            ? { kind: "system-prompt" }
            : { kind: "user" },
    };
    append("turn/start", { turn });
    append("step/start", { turn, step });
    if (entry.role === "user") append("user/message", message, true);
    else if (entry.role === "assistant")
      append("assistant/message", { turn, step, message, stream: [] }, true);
    else append("system/message", { turn, step, message }, true);
    append("step/end", { turn, step });
    append("turn/end", { turn, reason: { kind: "completed" } });
  }
  return seed;
}

export function systemInstructions(instructions, history) {
  // Messages endpoints normalize system history to a single effective system
  // prompt. Keep those entries in system context, with current instructions last.
  return [
    ...history.filter((entry) => entry.role === "system").map((entry) => entry.content),
    instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}
