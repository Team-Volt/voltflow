---
name: voltflow
description: Run a lean, risk-scaled software workflow that enforces behavioral TDD, surgical edits, bounded subagent delegation, adversarial review, and a diff-bound deployment gate. Use for implementing, fixing, refactoring, reviewing, validating, or deploying code when Codex should choose proportional planning, task-specific model and reasoning settings, and parallel slices without unnecessary ceremony.
---

# VoltFlow

Deliver the user's outcome with the least process that protects it. The user's request and repository instructions define the result; this skill decides how much planning, delegation, and review that result needs.

The hook injects an exact controller command and session id. Use those values verbatim. Do not guess plugin paths or session ids.

## Classify before editing

Inspect the repository and relevant instructions first. Before choosing a tier, skip VoltFlow entirely when the task is one simple, low-risk edit with no executable behavior, security boundary, or deployment intent—for example a typo, copy change, prose-only file, or inert metadata update. Run the injected controller with `skip --evidence <reason>` before editing. A skipped prompt needs no TDD, validation, fingerprint, or review; deployment remains gated.

Otherwise choose one tier:

- `trivial`: one obvious location, no behavioral ambiguity, low blast radius. Use an inline intent, no planner, and self-review.
- `standard`: a bounded feature or fix across established layers. Use a short checklist and one composite reviewer when code changes.
- `high`: architecture, auth, security, migration, concurrency, destructive data work, or several coupled slices. Use a planning subagent only if discovery leaves real design uncertainty, then use two independent review lanes.

Classify TDD as `required` for observable behavior and `exempt` for prose, generated output, metadata-only edits, or changes with no executable seam. An exemption still needs the closest useful validation; never create a fake text-presence test.

Start the controller with `review=self` for trivial, `review=single` for standard, and `review=split` for high. Upgrade when discovery reveals more risk; do not downgrade to avoid a gate.

## Build and revise the adaptive plan

After starting standard or high work, store a plan with the controller's `plan --spec <JSON>` command. The parent agent owns this workflow-wide record:

```json
{
  "goal": "Ship the requested behavior",
  "steps": [
    {
      "id": "implement",
      "action": "Add the behavior",
      "dependsOn": [],
      "lane": "code",
      "stop": "The focused test passes",
      "status": "pending"
    },
    {
      "id": "review",
      "action": "Review and fix material findings",
      "dependsOn": ["implement"],
      "lane": "review",
      "stop": "Review passes",
      "repeat": { "max": 2, "attempt": 0, "until": "Review passes" }
    }
  ]
}
```

Steps with satisfied dependencies can run in parallel. `lane` groups related work; it does not cap concurrency. Size each wave to the useful independent slices and the host's capacity, using the existing routing rules without adding a separate cost policy.

Revise the plan only when evidence changes the work. Use `plan --step <JSON>` for a single step; it patches an existing step or adds a complete new one, validates the whole plan, increments the revision, and updates linked worktrees. Use `plan --spec <JSON>` only when the goal or several steps change together. A failed test adds or activates the smallest fix step. A review failure advances a bounded fix, validate, review repeat. Mark a step `done` with concise `evidence` when its stop condition holds, and end a repeat early when its `until` condition holds. Never exceed `repeat.max`; stop and report the blocker instead.

The plan coordinates work but does not execute commands or grant approval. It cannot bypass RED, validation, independent review, or the deployment gate, and it never needs a user approval key.

Run `status --workflow` before staffing a wave or when a worker's lifecycle is unclear. It reports ready step IDs and each linked worktree's agent bindings and missing evidence.

## Execute required TDD one behavior at a time

When TDD is required, turn the acceptance criteria into ordered behavior slices before production code. Each slice is one observable behavior that one focused test can prove. Do not batch several tests before implementation or implement behavior reserved for a later slice.

Complete this loop for every TDD-required slice:

1. **RED:** Write one narrow behavioral test against real code, using mocks only at an unavoidable boundary. Run it and confirm that its assertion fails for the expected missing behavior. A passing test or setup error is not RED. The hook records failed test commands; use the controller's `red` command only when no runnable test seam exists.
2. **GREEN:** Make the smallest production edit that passes this test and no later slice. If production code preceded its test, revert that production edit and restart the slice; do not retain it as a reference.
3. **VERIFY:** Rerun the focused test and the smallest relevant regression set. Fix production code when the test remains valid; do not weaken the test to obtain GREEN.
4. **REFACTOR:** Only after GREEN, remove duplication or complexity introduced or exposed by this slice, then rerun the same checks.
5. **NEXT:** Re-read the slice diff, remove anything that does not serve its acceptance criterion, then start the next slice with its next failing test.

Before writing, name the owned paths and expected observable. Do not perform adjacent cleanup, introduce a dependency that the standard library or platform replaces, or add an abstraction with one foreseeable implementation.

Record successful automated or manual validation with the controller. A passing command from before the final edit is stale evidence. Exercise every changed observable layer: a syntax check proves syntax, not browser behavior. When user-facing web files change, run one real browser path at a supported viewport, or report that claim as pending when no browser runtime is available.

## Delegate only useful parallel work

Read [references/routing.md](references/routing.md) before spawning. Scale concurrent subagents to the number of useful independent slices and the host's available capacity. Parallel writers need disjoint owned paths; serialize shared files and dependencies.

The `SubagentStart` hook supplies the exact controller prefix, including protected data, session, and agent arguments. Run its `status` command from the assigned worktree before other commands; this binds host events that report the parent cwd to the worker state. Assigned paths may be new unless the assignment explicitly requires existing files.

Before merging a worker commit, run `integrate --from <worker-worktree>` from the integration worktree. It adopts evidence only from a linked worktree in the same workflow with current validation and no TDD violation; the merge then invalidates validation and review normally, so validate and review the integrated result.

When the active spawn schema is v2, always set `fork_turns: "none"`. Never use full-history inheritance, including when overriding `model` or `reasoning_effort`.

Never select `ultra` reasoning for a subagent. Do not use a pinned profile or inherit the parent unless its effort is known and not `ultra`; refuse the spawn when no compliant route exists. If the user explicitly requests `ultra`, report the policy conflict instead of substituting another effort.

Each spawn prompt contains five labeled fields and nothing repetitive:

- `WORK LAYER`: discovery, planning, implementation, validation, or review.
- `OUTCOME`: one observable result.
- `SCOPE`: owned paths or review slice, plus explicit exclusions.
- `EVIDENCE`: begin with one sentence in the form `ROUTE: <model>, <reasoning effort>, because <rationale>.`, followed by commands, files, or scenarios that prove the result.
- `STOP`: the condition that ends work or requires escalation.

Treat examples as examples, not hidden requirements. When instructions conflict, follow the user outcome, repository invariants, and the bounded assignment in that order. Return a concise result with evidence; do not invent neighboring work to make the assignment look complete.

Before every spawn, tell the user which model and reasoning effort you selected and why in one sentence. Before any tool call or other commentary, the subagent's first user-visible update copies the `ROUTE` sentence verbatim from `EVIDENCE`, so its session stays understandable even when the host hides spawn metadata.

## Review in proportion to risk

Review the final diff against the request, not against an imagined ideal rewrite. Cover correctness, regression risk, relevant security boundaries, validation quality, and unnecessary scope.

- `self`: the main agent runs the checklist and records `approve --self` with concrete evidence.
- `single`: one independent reviewer covers the full checklist.
- `split`: two reviewers use non-overlapping lanes: correctness/security and validation/scope.

Before spawning each independent reviewer, remove generated validation artifacts and confirm the worktree fingerprint is stable, then run the injected controller with `review --lane <lane>`. Put the returned token in the review prompt. The reviewer ends with `VOLTFLOW_REVIEW: PASS <lane> <token>` only when no blocking finding remains, or `VOLTFLOW_REVIEW: FAIL <lane> <token>` after its findings. Receipts without a current assignment are ignored, a failed lane clears earlier passes, and any edit invalidates every receipt.

Serialize reviewers that share a worktree. Their lanes remain independent, but concurrent validation can change generated artifacts between assignment and receipt, which correctly makes both fingerprint-bound tokens stale.

Reviewers must remove only generated artifacts created by their validation, or prevent them with the project's existing no-write option, before returning the receipt. Validation and approval remain worktree-local, so perform final validation and review in the worktree that will pass the deployment gate.

### Bound review exploration

Before spawning a reviewer, state the supported product boundary and material completion bar. A finding blocks only when it is reproducible in ordinary documented use and breaks a requested behavior, repository invariant, or material safety boundary. Ask for all such findings in one pass; do not ask for every imaginable bypass.

When failures share one mechanism, fix and test that mechanism once. Do not keep adding syntax-specific patterns after the boundary is characterized. If complete enforcement would require a shell parser, a general solver, or control over an interception surface the host does not provide, keep the local guard conservative, document the limit, and route authoritative enforcement to the controller or project configuration.

After a failed review, group findings by root cause and rerun only affected coverage. If a rerun finds another variant of the same bounded limitation, stop patching variants and reassess the abstraction or accepted boundary. Finish when the original acceptance criteria have current evidence and no material ordinary-use blocker remains. Select each reviewer's model and reasoning effort from the current task and live capabilities under [references/routing.md](references/routing.md). Prefer a configuration different from the author when available, and raise capability or effort only when the review scope, uncertainty, or a named high-risk boundary changes the completion bar.

## Gate deployment

Do not run a deployment or release command until the controller reports a passing review for the current Git fingerprint. The fingerprint covers workspace file content, executable mode bits, and configured ignored inputs while ignoring staging and commit representation. If Git or configuration cannot produce it, the gate fails closed. The hook blocks known deployment surfaces; projects can add shell or tool matchers in `.voltflow.json` and place the controller's `gate` command in a same-session local deploy wrapper.

Only the user can create an override through a clear natural-language instruction to deploy or release despite the gate, review, or approval. Questions, hypotheticals, negated instructions, and ordinary deploy requests are not overrides. The override is one-shot and bound to the current diff; never infer one from ambiguous language.

## Finish

Stop when the requested behavior works, the final diff is narrow, fresh validation passes, and the required review receipt exists. Report the result and evidence; if evidence is incomplete, the Stop hook preserves that report while leaving deployment blocked instead of forcing Codex to replace the answer.
