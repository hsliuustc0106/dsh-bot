# DSH bridge

This optional runtime boundary launches one trusted DeepSeek Harness process per
run. It requires a separately installed `@deepseek-ai/dsh@0.2.1-alpha.2`; the
installation name, version, and CLI entry point are checked before launch. Core
Rakazo installation does not download DSH.

The private temporary home contains a complete allowlisted profile. It has no
DSH shell, filesystem tools, MCP discovery, subagents, or persistence. The child
receives only that home, a random session ID, and the selected model credential.
Inherited Harness profiles, worker credentials, proxy overrides, and
`NODE_OPTIONS` are excluded. This is process isolation, not an OS sandbox.

Every frame carries protocol version 1, the session ID, and a monotonic sequence
number. Startup is `ready → configure → configured → proceed → started`: the
parent compares the actual scoped tool schemas with the exact caller-supplied
allowlist before releasing the model loop. Each dispatched call returns through
the caller's executor. Unknown tools, malformed or oversized frames, duplicate
calls, wrong identities or versions, startup timeouts, and crashes fail closed.
The bridge never retries a failed run or changes runtime.

Run deterministic boundary tests:

```bash
pnpm exec vitest run packages/runtime-dsh/src/bridge.test.ts
```

The first implementation gate runs the real pinned agent loop against a local
fake model, calls one harmless echo tool, and returns its result. It also verifies
that a model-requested native shell tool cannot execute:

```bash
npm install --prefix /tmp/rakazo-dsh --save-exact @deepseek-ai/dsh@0.2.1-alpha.2
DSH_TEST_CLI_PATH=/tmp/rakazo-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  pnpm exec vitest run packages/runtime-dsh/src/bridge.integration.test.ts
```

The installation is explicit; tests do not download software or call a hosted
model. Without `DSH_TEST_CLI_PATH`, only the actual-DSH cases are skipped.

This package implements the bridge and `AgentRuntime` integration. History is
imported as closed, role-preserving text events; only new tool requests reach
Rakazo’s executor. The initial runtime exposes `read_file` and `list_files` only.
Regenerate the JavaScript boundary declarations with `pnpm --filter @rakazo/runtime-dsh generate:types` after changing their source, then format with Biome.

Durable uncertain
outcome handling and the controlled pilot follow in PRs 4 and 5. The bridge joins
dispatched callbacks during shutdown; killing DSH is not proof that an external
tool stopped. No conversation migration, resume, native subagents, shared daemon,
or mid-run fallback is implemented.
