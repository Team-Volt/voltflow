---
name: voltflow
description: Run a lean, risk-scaled software workflow that enforces behavioral TDD, surgical edits, bounded subagent delegation, adversarial review, and a diff-bound deployment gate. Use for implementing, fixing, refactoring, reviewing, validating, or deploying code when Codex should choose proportional planning, GPT-5.6 model/reasoning profiles, and parallel slices without unnecessary ceremony.
---

# VoltFlow

Deliver the user's outcome with the least process that protects it. The user's request and repository instructions define the result; this skill decides how much planning, delegation, and review that result needs.

The hook injects an exact controller command and session id. Use those values verbatim. Do not guess plugin paths or session ids.

## Classify before editing

Inspect the repository and relevant instructions first, then choose one tier:

- `trivial`: one obvious location, no behavioral ambiguity, low blast radius. Use an inline intent, no planner, and self-review.
- `standard`: a bounded feature or fix across established layers. Use a short checklist and one composite reviewer when code changes.
- `high`: architecture, auth, security, migration, concurrency, destructive data work, or several coupled slices. Use a planning subagent only if discovery leaves real design uncertainty, then use two independent review lanes.

Classify TDD as `required` for observable behavior and `exempt` for prose, generated output, metadata-only edits, or changes with no executable seam. An exemption still needs the closest useful validation; never create a fake text-presence test.

Start the controller with `review=self` for trivial, `review=single` for standard, and `review=split` for high. Upgrade when discovery reveals more risk; do not downgrade to avoid a gate.

## Execute the smallest proof

For behavioral work:

1. Add or run the narrowest faithful test or reproduction and observe it fail for the expected reason. The hook records failed test commands; use the controller's `red` command only when the proof is manual.
2. Make the smallest production edit that turns the proof green.
3. Refactor only when it removes duplication or complexity introduced or exposed by the change, then rerun the proof.

Before writing, name the owned paths and expected observable. Do not perform adjacent cleanup, introduce a dependency that the standard library or platform replaces, or add an abstraction with one foreseeable implementation. Re-read the diff after each slice and remove code that does not serve an acceptance criterion.

Record successful automated or manual validation with the controller. A passing command from before the final edit is stale evidence.

## Delegate only useful parallel work

Read [references/routing.md](references/routing.md) before spawning. Scale concurrent subagents to the number of useful independent slices and the host's available capacity. Parallel writers need disjoint owned paths; serialize shared files and dependencies.

When the active spawn schema is v2, always set `fork_turns: "none"`. Never use full-history inheritance, including when overriding `model` or `reasoning_effort`.

Each spawn prompt contains five labeled fields and nothing repetitive:

- `WORK LAYER`: discovery, planning, implementation, validation, or review.
- `OUTCOME`: one observable result.
- `SCOPE`: owned paths or review slice, plus explicit exclusions.
- `EVIDENCE`: commands, files, or scenarios that prove the result.
- `STOP`: the condition that ends work or requires escalation.

Treat examples as examples, not hidden requirements. When instructions conflict, follow the user outcome, repository invariants, and the bounded assignment in that order. Return a concise result with evidence; do not invent neighboring work to make the assignment look complete.

## Review in proportion to risk

Review the final diff against the request, not against an imagined ideal rewrite. Cover correctness, regression risk, relevant security boundaries, validation quality, and unnecessary scope.

- `self`: the main agent runs the checklist and records `approve --self` with concrete evidence.
- `single`: one independent reviewer covers the full checklist.
- `split`: two reviewers use non-overlapping lanes: correctness/security and validation/scope.

Before spawning each independent reviewer, run the injected controller with `review --lane <lane>`. Put the returned token in the review prompt. The reviewer ends with `VOLTFLOW_REVIEW: PASS <lane> <token>` only when no blocking finding remains, or `VOLTFLOW_REVIEW: FAIL <lane> <token>` after its findings. Receipts without a current assignment are ignored, a failed lane clears earlier passes, and any edit invalidates every receipt.

### Bound review exploration

Before spawning a reviewer, state the supported product boundary and material completion bar. A finding blocks only when it is reproducible in ordinary documented use and breaks a requested behavior, repository invariant, or material safety boundary. Ask for all such findings in one pass; do not ask for every imaginable bypass.

When failures share one mechanism, fix and test that mechanism once. Do not keep adding syntax-specific patterns after the boundary is characterized. If complete enforcement would require a shell parser, a general solver, or control over an interception surface the host does not provide, keep the local guard conservative, document the limit, and route authoritative enforcement to the controller or project configuration.

After a failed review, group findings by root cause and rerun only affected coverage. If a rerun finds another variant of the same bounded limitation, stop patching variants and reassess the abstraction or accepted boundary. Finish when the original acceptance criteria have current evidence and no material ordinary-use blocker remains. Use Sol high for routine independent review; raise effort only for a named risk that changes the completion bar.

## Gate deployment

Do not run a deployment or release command until the controller reports a passing review for the current Git fingerprint. The fingerprint includes Git state, untracked files, executable mode bits, and configured ignored inputs. If Git or configuration cannot produce it, the gate fails closed. The hook blocks known deployment surfaces; projects can add shell or tool matchers in `.voltflow.json` and place the controller's `gate` command in a same-session local deploy wrapper.

Only the user can create an override through a clear natural-language instruction to deploy or release despite the gate, review, or approval. Questions, hypotheticals, negated instructions, and ordinary deploy requests are not overrides. The override is one-shot and bound to the current diff; never infer one from ambiguous language.

## Finish

Stop when the requested behavior works, the final diff is narrow, fresh validation passes, and the required review receipt exists. Report the result and evidence; if evidence is incomplete, the Stop hook preserves that report while leaving deployment blocked instead of forcing Codex to replace the answer.
