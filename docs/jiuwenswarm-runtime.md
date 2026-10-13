# JiuwenSwarm runtime: initial process integration

This implements the runtime-selection, Process SDK and host-tool foundation. It
does not complete the single-agent safety pilot or team milestones. Pi remains
the default. The selected bot accepts text and exposes tools only through
Rakazo’s scoped executor. Native tools, MCP, skills and team delegation remain unavailable. Other bots continue using Pi.
Web, Electron and mobile all reach the same backend selection through the API and
worker; there is no platform-specific runtime switch or new UI.

## Installation and selection

Install JiuwenSwarm's Python dependencies in a separate virtual environment from a
clean checkout of revision `8315c183a5d02fdab1674ab5120449c1d4b6728c`. Follow that
revision's installation instructions. Use `GIT_LFS_SKIP_SMUDGE=1` for a source-only
checkout; the SDK does not need upstream video assets. Keep the virtual environment
outside the checkout. The TypeScript SDK is vendored compiler output from that
same revision, built with its npm lockfile; see the package's `vendor/README.md`.
No upstream npm release is assumed and Pi does not need a Python installation.

Give **both the API and worker** the same configuration:

```sh
AGENT_RUNTIME=jiuwenswarm
AGENT_RUNTIME_BOT_ID=selected-test-bot-id
JIUWENSWARM_PYTHON_PATH=/opt/jiuwenswarm-venv/bin/python
JIUWENSWARM_SOURCE_DIR=/opt/jiuwenswarm-source
```

API and worker must share the same durable `DATA_DIR` filesystem. JiuwenSwarm
session storage lives under its `jiuwenswarm` directory, separately from temporary
configuration and credentials. Keep this application data private.

Replace the example bot ID with one existing disposable test bot. These settings
select an adapter installation, not model credentials. The model and credential
come from Rakazo's existing connection settings. This initial stage accepts an
OpenAI API-key connection at the standard endpoint only. It rejects OAuth,
custom endpoints, explicit reasoning settings, images, checkpoint resumes and
fallback models until their translation and security behavior are verified.
It never silently switches the selected bot to another runtime.

Startup checks absolute paths, exact source revision, a clean checkout and the
configuration-independent Process CLI capability query (schema 0.1, revision 1,
empty tool allowlists, host callbacks and stable event fields). Python uses isolated import mode.
The executor records the selected adapter ID and version in `runtimeId` and
`runtimeVersion` under the active run lease before execution. For JiuwenSwarm the
version includes the SDK version and exact source revision.

## Process and safety boundary

Each invocation creates a private temporary home and config. Each conversation
session generation has a private persistent data directory and workspace. The
configuration contains references to invocation-local model environment values.
The SDK merges environment variables, so the adapter explicitly unsets every
inherited variable before adding the small process environment. It does not
mutate the API/worker environment. Temporary data is removed after child cleanup.
This is application-level tool restriction, not an operating-system sandbox.
Only a trusted pinned installation should be used.

The backend maps each bot/thread/runtime to a durable session. It serializes
acquisition with the invocation claim under the thread lock. Busy sessions wait
without consuming an invocation; abandoned active sessions are never stolen.
A successful terminal stores the upstream session ID and delivered history keys.
Later turns send the new prompt, follow-ups and only newly arrived history. Changed
instructions, tool definitions, model settings, context strategy or cleared history
start a new session generation because upstream agent definitions are immutable.
Routine and creation runs remain isolated from ordinary conversation sessions.

At process startup, the adapter atomically claims queued follow-ups through the
existing lease-scoped callback and includes them once, removing their copies from
conversation history. Messages arriving after that boundary wait for a continuation
run. Failed claims and image follow-ups cannot launch a model process or produce a
successful completion. `agent.tools` contains only namespaced host tools. Skills and MCP remain empty;
native tool observations and native permission requests fail closed. Tool callbacks
preserve the original route and pass through `executeTool`, so Rakazo owns user/run
identity, validation, permission checks and audit. Matching repeated call IDs share
one promise and one audit; reusing an ID with changed arguments fails the run.
Callbacks from another run/session or after cancellation cannot dispatch.

Host approval and protected-input pauses stop the child. `ask_user` and supported
single-question SDK interactions map to the existing ask UI; its existing
run/space/message/action checks govern replies. No answer or native permission is
fabricated for the cancelled process. A later turn gets the user’s answer through
Rakazo history in a fresh session generation: a cancelled upstream conversation
may contain an unfinished interaction. The old owner releases its session only
after child cleanup, using a unique token so late cleanup cannot overwrite a newer
owner. Subagent and
native takeover tools remain unavailable in this single-agent adapter.

Invocations permit one model call without tools or at most 32 with host tools,
with a two-minute host deadline and bounded process shutdown grace. Host callback
metadata and results are bounded (128 unique calls, 8 MiB cumulative arguments,
512 KiB per result and 8 MiB cumulative results). This is not a strict monetary spending limit. Unknown cost and
usage stay null; ambiguous upstream cache counts are not fabricated into token
buckets. There are no automatic process retries.

The SDK validates JSONL framing, identities, sequence, terminal status and the
matching process exit. `chat.final` and EOF cannot finish a run successfully.
The adapter bounds pending events and response bytes. Iterator return/throw,
request cancellation and explicit abort terminate the owned process and await
cleanup. Runtime cancellation is forwarded into the executor’s existing run signal.
Stopping the child does not establish that a remote host action stopped. Before
host dispatch, the executor records intent under the current worker lease in a
durable ledger. The ledger stores tool name and lease fence, with a hashed call
identity; it never stores arguments or outputs. Cancellation or process completion
marks outstanding calls uncertain without waiting for the remote action. A known
late result can settle that record. Repeated call identities cannot dispatch again,
and unresolved calls block subsequent dispatch in the run. The job reconciler marks
abandoned intent records uncertain after terminal state or lease expiry. Unresolved
conversation actions block further session acquisition. After confirmed process
cleanup and settled tool outcomes, fresh user input can start a new session;
the interrupted invocation itself remains non-replayable. An upstream
`SESSION_BUSY` result fails closed without an automatic process retry.

Before model startup, a separate durable invocation claim prevents retries from
starting the same model invocation again, even when a new worker would generate
new callback IDs. Only a validated answer to a pending question or approval
increments the run’s input generation and permits another invocation. Lease
renewal or worker replacement does not reset this protection. An interrupted
invocation requires checking unfinished actions before starting a new run.

## Verification and remaining gates

Offline tests use real child processes and the pinned SDK. They cover success,
unknown usage, malformed and oversized output, foreign identity, crash, final
text without a terminal, mismatched exit, failure status, host/native tool
attempts, timeout, slow consumers, duplicate run IDs, abort, disconnect, scrubbed
environment and temporary-directory cleanup. Shared-factory tests cover selection,
startup failure and keeping other bots on Pi.

A live model run is not part of these tests. Before a pilot, verify
permissions and question routing with the live installation; verify
connection/reasoning conformance and budget boundaries. Do not reuse the
DSH pilot implementation as JiuwenSwarm evidence. Gateway/team mode remains disabled
until member permissions, cancellation, usage and terminal outcomes are proved.
