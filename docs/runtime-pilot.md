# Pi / DSH controlled pilot

Status: the offline driver passes all six paired fixtures. A live comparison has
not been run. This is not evidence that either harness improves completion,
latency or cost. Pi remains the deployment default. Do not enable DSH broadly on
these results.

The opt-in runner executes one model against three shared tasks:

| Task | Evidence required | Actions |
| --- | --- | --- |
| Repository answer | Correct environment variable and default, README line citation | Read fixture files |
| Read-only PR review | Zero-limit regression, affected file/line and nullish correction | Read patch and code |
| Small change and tests | Correct settings and passing fixed tests after the final write | Edit settings JSON, run fixed tests |

Each run gets the same initial files, instructions, tools, model ID, output limit,
reasoning setting and budgets. Ordering alternates between harnesses. Pi uses
Chat Completions and DSH uses Messages; protocol serialization and provider cache
behavior differ. One trial per task is a smoke pilot, not a statistically reliable
benchmark. The JSON-change task does not establish arbitrary coding ability.

The report contains answers for manual review, an automated correctness rubric,
denied actions, human interventions (zero: there is no human-in-the-loop step),
latency, token usage and cost estimates when supplied pricing is available.
Unknown costs remain null. Offline token counts come from a scripted emulator;
offline timings measure fixture execution, not hosted-model performance.

## Offline gate

Install the pinned CLI as described in [the runtime guide](./dsh-runtime.md), then:

```bash
pnpm exec tsx packages/testkit/src/cli/runtime-pilot.ts \
  --offline \
  --dsh-cli /opt/rakazo-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --output /tmp/runtime-pilot-offline.json
```

Both actual harnesses run against one local scripted model endpoint. The model
answers are predetermined; this verifies tool routing, result round trips, metrics
and rubric wiring. The normal unit tests cover denied paths, connector routing,
read-only policy, executable-file protection and budget termination.

## Authorized live run

Choose one authorized connection/model and a spending limit before running.
Create a private, untracked connection JSON file using the same model credential
as Rakazo. The two endpoints must be on the same HTTPS origin and expose the
respective protocols. Values below are fake placeholders, not working endpoints:

```json
{
  "model": {
    "id": "selected-model",
    "apiKey": "PRIVATE_LOCAL_VALUE",
    "contextWindow": 16384,
    "maxTokens": 1024
  },
  "chatBaseUrl": "https://model.example.invalid/v1",
  "messagesBaseUrl": "https://model.example.invalid/messages-api",
  "budget": {
    "timeoutMs": 120000,
    "maxToolCalls": 8,
    "maxModelCalls": 8,
    "maxTokens": 16000
  }
}
```

Optional `pricing` contains `inputPerMillion`, `outputPerMillion`,
`cacheReadPerMillion` and `cacheWritePerMillion`, all in USD. Use verified rates
for the selected model. Costs are estimates, not provider invoices. Token/call
budgets stop after observed usage and may overshoot by one in-flight request;
they are not a hard dollar cap. Set a provider-side spending cap when a hard
limit is required.

```bash
pnpm exec tsx packages/testkit/src/cli/runtime-pilot.ts \
  --connection /private/runtime-pilot-connection.json \
  --dsh-cli /opt/rakazo-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --output /private/runtime-pilot-live.json
```

Reports omit the credential and connection URLs. They include model responses;
review before publishing. Keep the connection file out of Git.

## Execution policy and rollback

The production factory continues to allow only read_file/list_files. Only the
standalone pilot explicitly selects `toolAccess: "disposable-pilot"`. Its executor
permits writes to settings.json only, never generated executable code. The tests
are immutable, have a fixed command, and run with a restricted environment. No
arbitrary shell or connector invocation is offered.

The pilot touches temporary fixture directories only and removes them afterward.
It does not change production runtime settings. Deployment rollback is described
in [the runtime guide](./dsh-runtime.md): disable new DSH work and settle or cancel
active work. Durable run markers prevent unfinished DSH runs from replaying through
Pi or DSH. Verify uncertain tool outcomes before explicitly starting fresh work.

Remaining gates: a live model comparison, PostgreSQL migration/product-journey
validation, and CI plus automated review on the stacked PRs. No deployment or
merge is implied by passing this offline pilot.
