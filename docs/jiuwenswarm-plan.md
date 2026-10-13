# JiuwenSwarm implementation series

The series branches from the shared runtime factory (`codex/dsh-runtime-selection`,
PR #1), independently of DSH-specific PRs #2–5. Keep Pi as the default. Each PR
must pass focused offline checks and finish CI and automated review before the
next PR is published. Do not merge without explicit approval.

| Order | Change | Completion evidence |
| --- | --- | --- |
| 1 | Runtime selection and pinned Process SDK adapter | Shared API/worker selection, per-run identity, fail-closed startup, subprocess success/failure/cancellation and reproducible SDK build |
| 2 | Host tools, permissions and approvals | Identity and stable call IDs, denied calls without side effects, tenant isolation, duplicate callbacks, stale/foreign answers, no native/MCP bypass |
| 3 | Sessions, stopping and recovery | One conversation/session mapping, serialized turns, busy sessions, uncertain writes, no unsafe retries, queued follow-ups, restart/late-result/duplicate-wake/cancellation/budget tests |
| 4 | Single-agent pilot and Pi comparison | Equivalent models, actual reasoning, tools and budgets; repository Q&A, read-only review and a disposable change; measured correctness/interventions/permissions/cancellation/latency/cost |
| 5 | Gateway/team protocol proof | Authenticated leader plus two workers; reconnect/terminal outcomes; every member's host permissions; cancellation and aggregate usage; team mode disabled if upstream hooks are missing |
| 6 | Team limits and recovery | JiuwenSwarm owns delegation, child/concurrency/deadline/shared-budget enforcement, sibling-failure and orphan recovery, independently verified delegated result |
| 7 | Subtask status and verified artifacts | Shared web/Electron and applicable native mobile workflow; minimal copy; CI screenshot and meaningful UI verification |

The live single-agent safety pilot and live team gates cannot be replaced by fake
process tests. Record missing upstream capabilities explicitly and keep the
corresponding capability disabled until proven. Unknown usage and cost remain
unknown. A process exit cannot establish that an in-flight remote write stopped.
