# VoltFlow

VoltFlow is a Codex workflow plugin for teams that want TDD, small diffs, useful subagents, and a deployment gate without turning every change into a ceremony.

It has one skill and one dependency-free Node hook. Session state lives in `PLUGIN_DATA`; it doesn't add ledgers or workflow files to the target repository.

## Install

VoltFlow requires Node 20 or newer and Git. Add the Team Volt marketplace, then install the plugin:

```sh
codex plugin marketplace add Team-Volt/voltflow
codex plugin add voltflow@team-volt
```

Start a new Codex task, run `/hooks`, inspect the VoltFlow hook commands, and trust them. A new task is required for Codex to load the installed skill and hooks.

## What it enforces

VoltFlow classifies work as `trivial`, `standard`, or `high`. Each tier has a minimum review mode: self-review for trivial work, one composite reviewer for standard work, and two independent lanes for high-risk work. An active workflow can be upgraded, but it cannot be downgraded to bypass its gate.

Behavioral changes follow RED, GREEN, REFACTOR. The hook allows test edits before RED but blocks production edits until it has observed a failing test or the agent records a manual reproduction. It also detects file changes made through shell commands after they run, so changing the tool name does not bypass evidence invalidation. Only a successful, directly executed test command records automated validation. Prose, generated output, and metadata-only work use `tdd=exempt` with the closest useful validation.

Review receipts use one-time lane assignments and are tied to a Git fingerprint containing HEAD, staged and unstaged diffs, untracked-file content, executable mode bits, and configured ignored inputs. A failed lane or later edit invalidates earlier passes. If Git cannot produce a complete fingerprint, the gate fails closed instead of reusing a partial value.

The user can overrule the gate in ordinary language by clearly directing VoltFlow to deploy or release despite the missing gate, review, or approval. Questions, hypotheticals, negated instructions, and ordinary deploy requests do not arm an override. An override works once and only for the current fingerprint, and the agent can't create one through the controller CLI.

## Model routing

The bootstrap router uses five profiles:

| Work | Model and effort |
| --- | --- |
| Discovery, tests, mechanical edits | Luna high |
| Standard implementation | Terra max |
| Planning, integration, composite review | Sol medium |
| Routine adversarial or correctness review | Sol high |
| Security, architecture, migrations, difficult ambiguity | Sol max |

Direct `model` and `reasoning_effort` overrides are used when the active spawn schema supports them. Otherwise VoltFlow selects a matching agent profile when possible; if neither route exists, it inherits the parent and reports `routing degraded` instead of pretending the requested profile ran.

This table starts from the community [Codex quota frontier analysis](https://www.reddit.com/r/codex/comments/1ut3bnp/the_codex_pareto_frontier_luna_high_terra_max_sol/), checked against the different [Artificial Analysis API-cost frontier](https://artificialanalysis.ai/articles/gpt-5-6-intelligence-vs-cost-across-sol-terra-luna). It is a prior, not a permanent benchmark result. OpenAI's [GPT-5.6 prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6) supplies the prompt shape: one outcome, explicit constraints, evidence, and a stopping condition, with each rule stated once.

## Multi-agent compatibility

VoltFlow does not call a subagent API from its Node runtime. The main Codex agent uses whichever host schema is available:

- Multi-agent v1 uses the namespaced `multi_agent_v1.spawn_agent` fields, including direct `model` and `reasoning_effort` overrides.
- Multi-agent v2 uses the flat `spawn_agent` shape with `task_name`, `message`, and `fork_turns: "none"`. VoltFlow never uses full-history inheritance for a v2 spawn. It passes model settings only when that schema exposes them; otherwise it uses a pinned agent profile or reports degraded routing.

The lifecycle hooks consume `SubagentStart` and `SubagentStop`, so review receipts are independent of the spawn API version. Both host schemas are supported; the active schema still determines whether direct model and reasoning overrides are available.

### Enable multi-agent v2

To use v2 with per-subagent model and reasoning controls, add this to `~/.codex/config.toml`:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
tool_namespace = "agents"
```

If the file has a top-level `model_catalog_json` entry that points to a v1 catalog, remove that entry. Restart Codex and open a new task after changing the configuration. VoltFlow will set `fork_turns: "none"` on every v2 spawn so explicit `model` and `reasoning_effort` values are valid.

## Controller

The prompt hook supplies the real plugin path, data path, and session id. These examples show the shape:

```sh
node <plugin-root>/scripts/voltflow.mjs start \
  --data-dir <plugin-data> --session <session-id> \
  --tier standard --tdd required --review single

node <plugin-root>/scripts/voltflow.mjs red \
  --data-dir <plugin-data> --session <session-id> \
  --evidence "targeted reproduction failed for the expected reason"

node <plugin-root>/scripts/voltflow.mjs validate \
  --data-dir <plugin-data> --session <session-id> \
  --evidence "npm test"

node <plugin-root>/scripts/voltflow.mjs review \
  --data-dir <plugin-data> --session <session-id> \
  --lane composite

node <plugin-root>/scripts/voltflow.mjs approve --self \
  --data-dir <plugin-data> --session <session-id> \
  --evidence "final diff checked against the request"

node <plugin-root>/scripts/voltflow.mjs gate \
  --data-dir <plugin-data> --session <session-id>
```

Give the token returned by `review` to that reviewer. Its final line must be `VOLTFLOW_REVIEW: PASS <lane> <token>` or `VOLTFLOW_REVIEW: FAIL <lane> <token>`.

Put the final `gate` command immediately before the provider's deploy command in the same local session or deploy wrapper. Plugin hooks are useful guardrails, but `PreToolUse` cannot intercept every possible side effect. VoltFlow does not yet provide a portable signed receipt for a separate remote CI machine, so do not describe the local state file as an authoritative remote boundary.

## Project-specific deploy surfaces

Built-in matching covers common package publishing, cloud deploy, infrastructure apply, release, and container push commands. Add project commands or MCP tools with `.voltflow.json`:

```json
{
  "deployPatterns": ["^make promote$"],
  "deployTools": ["^mcp__cloud__promote$"],
  "fingerprintPaths": ["dist/release-manifest.json"]
}
```

Deploy values are case-insensitive regular expressions. `fingerprintPaths` contains exact relative paths for ignored material inputs; directories and globs are not expanded. Invalid configuration is reported in the workflow context and command execution fails closed until it is fixed.

Incomplete workflow evidence never replaces the answer Codex already wrote. The Stop hook reports the missing evidence as a system message, marks the task inactive, and leaves deployment denied until a later task validates and reviews the current fingerprint.

## Development

```sh
npm test
```

## License

[MIT](LICENSE)
