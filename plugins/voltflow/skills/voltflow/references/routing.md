# Model and reasoning routing

Choose the model and reasoning effort for the concrete assignment from the capabilities available in the current Codex installation. This is a selection rubric, not a fixed profile table; rerun the eval suite when model behavior, availability, or quota accounting changes.

Inspect the active spawn schema before delegating. Treat its model descriptions and supported reasoning efforts as authoritative, and do not infer capability from a model name alone.

| Task characteristics | Model tendency | Reasoning tendency |
| --- | --- | --- |
| Mechanical, read-heavy, repetitive, or easy to verify | Fastest capable model | Low or medium |
| Bounded implementation with fast deterministic checks and a cost goal | `gpt-5.6-luna` when the active schema offers it | Max when the extra reasoning is cheaper than a stronger model route |
| Bounded implementation with clear acceptance checks | Balanced coding model | Medium or high |
| External planning chosen after discovery | `gpt-5.6-sol` | At least the effort the plan's ambiguity and risk require |
| Difficult debugging or cross-cutting integration | Strongest suitable model | High or xhigh |
| Adversarial or holistic review | Capable reviewer, preferably configured differently from the author | Scale with ambiguity and the strength of deterministic checks |
| Named high-risk boundary where a miss is expensive | Strongest suitable model | High or xhigh; max only under rule 5 |

## Routing rules

1. Choose by task difficulty, ambiguity, risk, and verifiability rather than role title. A mechanical security-file edit can use a fast model at medium effort; a subtle one-file race can need the strongest model at high effort.
2. The main session owns the selection. Set `model` and `reasoning_effort` directly when the spawn schema exposes them, and omit `service_tier` unless the user requests one.
3. For independent review, prefer a model or reasoning configuration different from the author when available. Raise capability or effort only when the review scope, uncertainty, or named risk justifies it.
4. Named high-risk boundaries include authorization, private data, payments, bookings, destructive or data-integrity migrations, and cross-cutting architecture. They establish a higher selection floor without prescribing one model family.
5. Reserve `max` reasoning for work that benefits from it. One valid cost route is Luna max for bounded implementation with strong deterministic checks. Do not infer fixed capability parity between Luna, Sol, or Terra from model names or anecdotes.
6. Never select `ultra` reasoning for a subagent. If the user explicitly requests it, report the policy conflict instead of substituting another effort.
7. Honor any other explicit user selection. If the requested model or effort is unavailable, report that instead of silently substituting or downgrading it.
8. If only `agent_type` is available, select the closest matching profile whose effort is known and not `ultra`. If no override surface exists, inherit the parent only when its effort is known and not `ultra`; state `routing degraded` once in the result. If neither compliant route exists, refuse the spawn and state `routing blocked`.
9. Record the selected model, reasoning effort, and short task-based rationale in the assignment or result so routing decisions remain reviewable.
10. Size each wave to the useful independent slices and the host's available concurrency. Do not create slices solely to increase agent count.

## Spawn schema

Inspect the active tool schema before spawning and use only fields it declares.

- Multi-agent v1: call `multi_agent_v1.spawn_agent` with `message`, the chosen `model` and `reasoning_effort`, and `fork_context` only as needed. Planning may inherit context; isolated work should not.
- Multi-agent v2: call the flat `spawn_agent` with `task_name`, `message`, and the context needed for that assignment. Use `fork_turns: "10"` for an external planner when recent decisions matter and `"none"` for isolated work. Pass model settings only when the schema declares them; otherwise use a verified non-ultra profile or parent and report `routing degraded`.

The hook workflow observes subagent lifecycle events rather than calling either API, so review collection does not depend on the spawn schema.

## Slicing

- Discovery: split by subsystem, data flow, or risk boundary. Each agent is read-only and returns file-backed facts.
- Implementation: split only on disjoint write sets. The main agent owns integration and shared files.
- Review: standard work gets one composite lane. High-risk work gets two lanes: `correctness-security` and `validation-scope`.

Review prompts name the supported boundary, materiality threshold, and stop rule. Require reviewers to batch ordinary-use blockers in one pass. Do not ask them to enumerate every syntactic variant; when a finding family would require a full parser or control over an unavailable host boundary, document the limit and evaluate the authoritative fallback instead of continuing variant-by-variant patches.

Do not spawn an agent when the main agent's next action depends immediately on its result, when the assignment is smaller than the handoff, or when two workers would touch the same file. Create each parallel writer's linked worktree before spawning it, include the absolute path in its assignment, and require its first controller status command to run there.

After spawning, continue independent parent work. When none remains, use bounded waits instead of short polls. Expected runtime rises with reasoning effort, and high or xhigh work can take materially longer than low or medium work. Do not use a fixed elapsed-time threshold or an unchanged wait snapshot as evidence of a stall. Keep waiting while the agent remains within its stated stop condition and reports no blocker. Send a follow-up only when the agent asks for help, reports an error, or exceeds that stop condition; reduce scope only when the original outcome is no longer achievable, never merely to end a long-running task. Interrupt only when the agent is blocking completion and a follow-up did not recover it.
