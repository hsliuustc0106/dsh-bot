# JiuwenSwarm single-agent pilot

The adapter harness compares Pi and the pinned JiuwenSwarm Process runtime on
three controlled repository tasks. It is one part of the single-agent pilot;
a passing fixture report does not establish that the selected bot's production
authorization, approval, cancellation and recovery flows are ready.

## Tasks and evidence

Each adapter receives an independent disposable copy of
`packages/adapters/src/agent-runtime.ts`, the same instructions and the same
read/write tool contracts. The real repository is never a model write target.
No model-authored code is executed.

- Repository Q&A: identify the default, selected and other-bot runtimes with
  exact source quotations. Answers without a source read fail verification.
- Read-only review: identify a seeded regression that changes the unspecified
  runtime from Pi to scripted. The verifier requires the actual faulty statement
  and rejects missing or extra findings. Writes are denied.
- Disposable change: repair that regression while preserving every other byte.
  The verifier compares the saved file to the original snapshot; a claim of
  completion cannot pass by itself.

Each case allows eight forwarded model requests, 32 host tool attempts, a
120-second deadline and one MiB of answer text. Failed model requests consume
calls. These are request and output limits, not a monetary ceiling. Cancellation
aborts the request and waits for runtime cleanup. The tools enforce exact file
names, reject foreign routes and duplicate execution IDs, and stop after
cancellation. These fixture tools do not replace the product permission executor.

Both adapters use the same compatible connection and explicit token settings.
A host relay checks actual model, reasoning effort and output limit before
forwarding. Requests that Pi shrinks to fit context capacity fail the comparison.
`xhigh` and `max` are rejected because the generic Pi connection maps them to
`high`. The default for a declared reasoning connection is `medium`.

Reports include source and artifact hashes, independent correctness, completion,
permission violations, denied attempts, tool/model counts, manual interventions,
end-to-end latency and reported total tokens. Missing or incomplete usage stays
unknown. Compatible models have no verified price catalog in this harness, so
cost stays `null`; placeholder catalog zeroes are not evidence of free inference.
Reports omit credentials, endpoint addresses, local paths and transcripts.

## Running

Prepare a private JSON configuration outside the checkout using the existing
shared model connection fields. For a local model, its shape is:

```json
{
  "model": {
    "provider": "openai-compatible",
    "id": "configured-model-id",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "reasoning": false,
    "maxTokens": 4096,
    "contextWindow": 32768
  },
  "installation": {
    "pythonPath": "/opt/jiuwenswarm-venv/bin/python",
    "sourceDir": "/opt/jiuwenswarm-source"
  }
}
```

A keyed connection can include its existing `apiKey` in that private file. Use
the normal compatible connection URL policy. The installation must match the
pinned revision documented in `jiuwenswarm-runtime.md`.

```sh
pnpm exec tsx packages/adapters/src/pilot/cli.ts "$PILOT_CONFIG" "$PILOT_REPORT"
```

The report destination must be new; reports are created with private permissions.
A failed fixture gate sets a nonzero exit status. Review measurements before
sharing a report. Repeated quality comparisons must account for task order and
provider cache effects; one six-case run is not a quality benchmark.

## Remaining rollout gates

Run the selected disposable bot through repository Q&A, read-only review and a
small approved change with the chosen live model. Verify real user/tenant scopes,
denied actions without side effects, approval and question answers, cancellation,
and uncertain-action reconciliation. Repeat quality runs and independently check
the resulting artifacts. Record correctness, interventions, permissions, latency,
usage and either trusted cost provenance or an explicit unknown cost.

The opt-in Python tests use a local model emulator to test the harness and actual
adapter protocols. They cannot satisfy live model quality or selected-bot gates.
They also verify signal cancellation, explicit abort and consumer disconnect with
an outstanding model stream; cleanup must finish within five seconds without a
successful terminal. An outstanding host action may settle after process cleanup,
with one audit and no model retry. Approval, protected-input and question pauses
stop the real process before a second model call. These establish adapter protocol
behavior, not production authorization or remote-action reconciliation.
Team mode remains disabled and is covered by later PRs.
