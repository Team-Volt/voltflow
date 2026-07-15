# GPT-5.6 routing

Use the smallest profile that clears the task. These profiles seed VoltFlow's routing table; rerun the eval suite when model behavior or quota accounting changes.

| Profile | Route work here |
| --- | --- |
| `gpt-5.6-luna`, `high` | Read-heavy discovery, focused test execution, mechanical edits, and simple pattern-following work. |
| `gpt-5.6-terra`, `max` | Standard implementation inside established architecture and bounded multi-file changes. |
| `gpt-5.6-terra`, `high` | Routine independent review, adversarial correctness checks, and bounded security review without a named high-risk boundary. |
| `gpt-5.6-sol`, `medium` | Planning and integration that need global coherence without max-cost reasoning. |
| `gpt-5.6-sol`, `max` | High-risk architecture, security, concurrency, migrations, and ambiguous work where a missed constraint is expensive. |

## Routing rules

1. Choose by difficulty, not by role title. A mechanical security-file edit can use Luna; a subtle one-file race can require Sol max.
2. Set `model` and `reasoning_effort` directly when the spawn schema exposes them. Omit `service_tier`.
3. If only `agent_type` is available, select a profile that pins the required model and effort. If neither override surface exists, inherit the parent and state `routing degraded` once in the result.
4. Use Terra high for routine review-only agents. The controller requires it explicitly, so do not inherit the parent model. Use Sol only with a named high-risk exception (authorization, private data, payments, bookings, destructive/data-integrity migrations, or cross-cutting architecture) or when the user explicitly requests it.
5. Size each wave to the useful independent slices and the host's available concurrency. Do not create slices solely to increase agent count.

## Spawn schema

Inspect the active tool schema before spawning and use only fields it declares.

- Multi-agent v1: call `multi_agent_v1.spawn_agent` with `message`, `fork_context: false`, and the chosen `model` and `reasoning_effort`. Add `agent_type` only when a matching role improves the assignment.
- Multi-agent v2: always call the flat `spawn_agent` with `task_name`, `message`, and `fork_turns: "none"`. Never use full-history inheritance. Pass model settings only when the schema declares them; otherwise use a matching pinned profile or inherit the parent and report `routing degraded`.

The hook workflow observes subagent lifecycle events rather than calling either API, so review collection does not depend on the spawn schema.

## Slicing

- Discovery: split by subsystem, data flow, or risk boundary. Each agent is read-only and returns file-backed facts.
- Implementation: split only on disjoint write sets. The main agent owns integration and shared files.
- Review: standard work gets one composite lane. High-risk work gets two lanes: `correctness-security` and `validation-scope`.

Review prompts name the supported boundary, materiality threshold, and stop rule. Require reviewers to batch ordinary-use blockers in one pass. Do not ask them to enumerate every syntactic variant; when a finding family would require a full parser or control over an unavailable host boundary, document the limit and evaluate the authoritative fallback instead of continuing variant-by-variant patches.

Do not spawn an agent when the main agent's next action depends immediately on its result, when the assignment is smaller than the handoff, or when two workers would touch the same file.

After spawning, continue independent parent work. When none remains, use one bounded wait instead of repeated short polls; after two unchanged waits, send one scope-reducing follow-up, then interrupt only when the agent is blocking completion and has exceeded its stated stop condition.
