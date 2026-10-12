# DeepSeek Harness runtime pilot

Rakazo can opt one bot into DeepSeek Harness (DSH), leaving every other bot on Pi.
This is an experimental **source-deployment** integration, tested with
`@deepseek-ai/dsh@0.2.1-alpha.2`. Published Rakazo images do not include DSH.

Rakazo continues to own conversations, long-term memory, scheduling, computers,
permissions, and tool execution. DSH owns the model/tool loop and an ephemeral
execution session. Web, Electron, and mobile use the same worker; no client
configuration changes are needed.

## Enable

Install the pinned CLI in a separate directory accessible to the API and worker:

```bash
npm install --prefix /opt/rakazo-dsh --save-exact @deepseek-ai/dsh@0.2.1-alpha.2
```

In both the API and worker environments, set:

```dotenv
AGENT_RUNTIME=dsh
AGENT_RUNTIME_BOT_ID=your-pilot-bot-id
DSH_CLI_PATH=/opt/rakazo-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
```

Restart both services. Connect a DeepSeek API key through Rakazo's existing model
settings and assign that connection and one model to the pilot bot. The adapter
passes the connection's key, base URL, context window, output limit, and supported
reasoning effort to DSH. No separate model credential environment variables are
required. This initial adapter uses DSH's native DeepSeek **Messages** protocol;
a custom endpoint must support that protocol, not just Chat Completions.

Apply database migrations before enabling DSH. To roll back, stop new pilot work, cancel or settle active runs, set `AGENT_RUNTIME=pi`, and restart both services. A durable no-replay marker prevents an unfinished DSH run from being resumed through either runtime; verify unresolved actions before explicitly creating a new run. Missing pilot
configuration or an unknown runtime prevents worker startup instead of silently
changing execution behavior. The stock Compose configurations explicitly select
Pi; this pilot must be configured in the source worker environment.

## Boundary and limitations

- Only built-in `read_file` and `list_files` are exposed. Every call goes through
  Rakazo's executor. Connector routes, shell, writes, browser actions, catalog
  dispatch, and subagents are denied even if advertised as read-only.
- The dedicated profile loads only the agent kernel, native model adapter, and
  bridge. It does not load DSH's SDK minimal profile, shell, filesystem,
  subprocess, MCP, persistence, or subagent plugins. This restricts the model's
  tools; the trusted CLI/plugin process itself is not an OS sandbox.
- Each run has a fresh process, random session ID, and private temporary Harness
  home that is removed after shutdown. Worker secrets and personal DSH settings
  are not inherited. The selected model key is the only credential passed to the
  child. Conversation history is imported as closed, role-preserving text events. Historical tool text never becomes executable tool calls; no resumable DSH transcript is imported.
- Input is text-only. Images, checkpoint resume, OAuth connections, configured
  fallback models, and unsupported reasoning efforts fail explicitly. There is
  no compaction, live steering, or DSH session resume in this pilot. Writing,
  resume, and subagents are follow-up phases.
- Streamed text and tool activity use existing Rakazo runtime events. Executor
  denials remain failures; approval pauses stop the loop. Cancellation via the
  runtime, upstream signal, or consumer closing the stream stops DSH, with a
  bounded process-termination fallback. Tool signals combine runtime cancellation with the executor’s lease signal. The bridge waits up to five seconds for dispatched tools to settle; remaining calls are recorded as uncertain. Metadata is persisted before dispatch, and confirmed late results can settle that uncertainty without replay. Recovery also marks unresolved calls uncertain after a worker dies. No raw arguments or results are stored in this ledger.
- Usage is recorded per model attempt through the awaited producer callback,
  including usage delivered during graceful cancellation. Missing costs remain
  unknown rather than zero. Hard termination can lose provider usage that has
  not yet reached DSH; this is not a billing estimate.

## Verify and compare

The default tests exercise the subprocess protocol without downloading DSH or
calling a hosted model:

```bash
pnpm exec vitest run packages/runtime-dsh/src packages/adapters/src/agent-runtime.test.ts
```

To run the same read-and-answer, denied-action, unavailable-tool, and cancellation
tasks through Pi and the actual pinned DSH agent loop against an offline local
model server:

```bash
DSH_TEST_CLI_PATH=/opt/rakazo-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  pnpm exec vitest run packages/adapters/src/runtime-conformance.integration.test.ts packages/runtime-dsh/src/runtime.integration.test.ts
```

Without that explicit CLI path, the DSH integration cases are skipped; the Pi cases
still run. The fixture uses Pi's generic Chat Completions connection and DSH's
native Messages connection with the same model ID and task. Boundary tests cover
denied tools, executor failures, approval pauses,
duplicate calls, cancellation, usage, and session isolation. These tests verify
behavior, not model quality or performance. For real comparisons, use the same
model, task set, tools, and inputs and record completion, total token usage,
available cost, and elapsed time. No claim of improved quality, cost, or latency
is established by this pilot.

Upstream references: [Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md),
[tool boundary](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md),
and [SDK minimal profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md).
