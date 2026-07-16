import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handleHook,
  isDeployInvocation,
  loadState,
  runController,
  workspaceFingerprint,
} from "../scripts/voltflow.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-test-"));
  const dataDir = path.join(root, "data");
  let fingerprint = "diff-a";
  const options = {
    dataDir,
    pluginRoot: "/plugin",
    fingerprint: () => fingerprint,
  };
  return {
    root,
    dataDir,
    options,
    setFingerprint(value) {
      fingerprint = value;
    },
  };
}

function input(event, extra = {}) {
  return {
    cwd: extra.cwd ?? "/repo",
    hook_event_name: event,
    model: "gpt-5.6-sol",
    permission_mode: "default",
    session_id: "session-1",
    transcript_path: null,
    turn_id: "turn-1",
    ...extra,
  };
}

function start(fx, { tier = "standard", tdd = "required", review = "single" } = {}) {
  const result = runController(
    [
      "start",
      "--session",
      "session-1",
      "--tier",
      tier,
      "--tdd",
      tdd,
      "--review",
      review,
    ],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(result.exitCode, 0, result.stderr);
}

function failedTest(fx) {
  handleHook(
    input("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_response: { exit_code: 1, output: "expected true, received false" },
    }),
    fx.options,
  );
}

function passedTest(fx) {
  handleHook(
    input("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "node --test" },
      tool_response: { exit_code: 0, output: "pass" },
    }),
    fx.options,
  );
}

function productionPatch() {
  return input("PreToolUse", {
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/app.mjs\n+export const ready = true;\n*** End Patch",
    },
  });
}

function recordProductionEdit(fx) {
  handleHook(
    input("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: productionPatch().tool_input,
      tool_response: "Success. Updated files.",
    }),
    fx.options,
  );
}

function review(fx, agentId, lane) {
  const assigned = runController(
    ["review", "--session", "session-1", "--lane", lane],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(assigned.exitCode, 0, assigned.stderr);
  const token = /token=(\S+)/.exec(assigned.stdout)?.[1];
  assert.ok(token);
  return handleHook(
    input("SubagentStop", {
      agent_id: agentId,
      agent_type: "default",
      last_assistant_message: `VOLTFLOW_REVIEW: PASS ${lane} ${token}`,
      stop_hook_active: false,
    }),
    fx.options,
  );
}

function deploy(fx) {
  return handleHook(
    input("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "npm run deploy" },
    }),
    fx.options,
  );
}

test("prompt injection starts session state and names the exact controller", () => {
  const fx = fixture();
  const output = handleHook(
    input("UserPromptSubmit", { prompt: "Update the parser" }),
    fx.options,
  );

  assert.match(output.hookSpecificOutput.additionalContext, /node ['"]\/plugin\/scripts\/voltflow\.mjs['"]/);
  assert.match(output.hookSpecificOutput.additionalContext, /--session ['"]session-1['"]/);
  assert.match(output.hookSpecificOutput.additionalContext, /external permission/i);
  assert.equal(loadState(fx.dataDir, "session-1").tier, "unclassified");
});

test("simple work can skip workflow ceremony without granting deployment approval", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix one typo" }), fx.options);

  const skipped = runController(
    ["skip", "--session", "session-1", "--evidence", "single prose edit with no deployment intent"],
    { ...fx.options, cwd: "/repo", fingerprint: () => null },
  );
  assert.equal(skipped.exitCode, 0, skipped.stderr);
  assert.equal(loadState(fx.dataDir, "session-1").active, false);
  assert.equal(productionPatchDecision(fx), null);
  assert.equal(handleHook(input("Stop", { last_assistant_message: "Done" }), fx.options), null);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");

  handleHook(input("UserPromptSubmit", { prompt: "Make another change" }), fx.options);
  start(fx, { tier: "trivial", tdd: "exempt", review: "self" });
  recordProductionEdit(fx);
  const late = runController(
    ["skip", "--session", "session-1", "--evidence", "too late"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(late.exitCode, 1);

  const failedMutation = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix one typo" }), failedMutation.options);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/a/b/ README.md" },
      tool_response: { exit_code: 1 },
    }),
    { ...failedMutation.options, fingerprint: () => "diff-b" },
  );
  const failedMutationSkip = runController(
    ["skip", "--session", "session-1", "--evidence", "too late"],
    { ...failedMutation.options, cwd: "/repo", fingerprint: () => "diff-b" },
  );
  assert.equal(failedMutationSkip.exitCode, 1);
});

test("subagent contract limits per-slice TDD to required work", () => {
  const output = handleHook(input("SubagentStart"));
  assert.match(output.hookSpecificOutput.additionalContext, /when TDD is required/i);
  assert.match(output.hookSpecificOutput.additionalContext, /one behavior/i);
  assert.match(output.hookSpecificOutput.additionalContext, /one focused test/i);
  assert.match(output.hookSpecificOutput.additionalContext, /finish RED.*GREEN before starting the next slice/i);
  assert.match(output.hookSpecificOutput.additionalContext, /TDD-exempt work.*do not create tests/i);
  assert.match(output.hookSpecificOutput.additionalContext, /every changed observable layer/i);
  assert.match(output.hookSpecificOutput.additionalContext, /syntax checks do not prove runtime behavior/i);
});

test("active v2 spawns require isolated context", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Implement the parser" }), fx.options);
  const spawn = (toolInput) => handleHook(
    input("PreToolUse", { tool_name: "agentsspawn_agent", tool_input: toolInput }),
    fx.options,
  );

  assert.equal(spawn({ task_name: "worker", message: "work", fork_turns: "all" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(spawn({ task_name: "worker", message: "work" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(spawn({ task_name: "worker", message: "work", fork_turns: "none" }), null);
  assert.equal(handleHook(
    input("PreToolUse", {
      tool_name: "multi_agent_v1.spawn_agent",
      tool_input: { message: "work", fork_context: false },
    }),
    fx.options,
  ), null);
});

test("classification and a real RED precede production edits", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);

  assert.equal(productionPatchDecision(fx), "deny");
  start(fx);
  assert.equal(productionPatchDecision(fx), "deny");

  const testPatch = input("PreToolUse", {
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Add File: test/parser.test.mjs\n+assert.equal(parse('x'), true);\n*** End Patch",
    },
  });
  assert.equal(handleHook(testPatch, fx.options), null);

  failedTest(fx);
  assert.equal(productionPatchDecision(fx), null);
});

test("review pass is bound to the validated fingerprint", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Implement the parser" }), fx.options);
  start(fx);
  failedTest(fx);
  recordProductionEdit(fx);
  passedTest(fx);
  review(fx, "reviewer-1", "composite");

  assert.equal(deploy(fx), null);
  fx.setFingerprint("diff-b");
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("split review requires both named lanes from distinct agents", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Change the auth boundary" }), fx.options);
  start(fx, { tier: "high", review: "split" });
  failedTest(fx);
  recordProductionEdit(fx);
  passedTest(fx);

  review(fx, "reviewer-1", "correctness-security");
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
  review(fx, "reviewer-2", "validation-scope");
  assert.equal(deploy(fx), null);
});

test("user override is diff-bound and consumed by one deployment", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Deploy the current build" }), fx.options);
  const armed = handleHook(
    input("UserPromptSubmit", { prompt: "Deploy this build anyway despite the missing final review." }),
    fx.options,
  );

  assert.match(armed.hookSpecificOutput.additionalContext, /armed/i);
  assert.equal(deploy(fx), null);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("override questions and negations do not arm deployment", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Deploy the current build" }), fx.options);

  handleHook(input("UserPromptSubmit", { prompt: "How can I override the deployment gate?" }), fx.options);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");

  handleHook(input("UserPromptSubmit", { prompt: "Should we override deployment?" }), fx.options);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");

  handleHook(input("UserPromptSubmit", { prompt: "Do not bypass the deployment gate." }), fx.options);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("self review requires validation and becomes stale after an edit", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Update the flag" }), fx.options);
  start(fx, { tier: "trivial", tdd: "exempt", review: "self" });
  recordProductionEdit(fx);

  const early = runController(
    ["approve", "--self", "--session", "session-1", "--evidence", "diff inspected"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(early.exitCode, 1);

  const validated = runController(
    ["validate", "--session", "session-1", "--evidence", "manual scenario passed"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(validated.exitCode, 0);
  assert.equal(
    runController(
      ["approve", "--self", "--session", "session-1", "--evidence", "diff inspected"],
      { ...fx.options, cwd: "/repo" },
    ).exitCode,
    0,
  );
  assert.equal(deploy(fx), null);

  recordProductionEdit(fx);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("deployment detection covers defaults and project matchers", () => {
  const fx = fixture();
  assert.equal(isDeployInvocation("Bash", { command: "terraform apply" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --dry-run" }, fx.root), false);
  assert.equal(isDeployInvocation("mcp__cloud__get_release", {}, fx.root), false);

  writeFileSync(
    path.join(fx.root, ".voltflow.json"),
    JSON.stringify({ deployPatterns: ["^make promote$"], deployTools: ["^mcp__cloud__promote$"] }),
  );
  assert.equal(isDeployInvocation("Bash", { command: "make promote" }, fx.root), true);
  assert.equal(isDeployInvocation("mcp__cloud__promote", {}, fx.root), true);
});

test("incomplete Stop reports pending evidence without replacing the response", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  failedTest(fx);
  recordProductionEdit(fx);

  const first = handleHook(input("Stop", { last_assistant_message: "Done" }), fx.options);
  assert.equal(first.decision, undefined);
  assert.match(first.systemMessage, /deployment remains blocked/i);
  const second = handleHook(input("Stop", { last_assistant_message: "Still done" }), fx.options);
  assert.equal(second, null);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("a production write observed before RED cannot be repaired by late evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  recordProductionEdit(fx);
  failedTest(fx);
  passedTest(fx);

  assert.equal(loadState(fx.dataDir, "session-1").tddViolation, true);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("reverting a pre-RED production edit clears the violation", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/a/b/ src/app.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "diff-b" },
  );
  assert.equal(loadState(fx.dataDir, "session-1").tddViolation, true);

  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/b/a/ src/app.mjs" },
      tool_response: { exit_code: 0 },
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").tddViolation, false);
  const red = runController(
    ["red", "--session", "session-1", "--evidence", "expected failure"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(red.exitCode, 0, red.stderr);
});

test("partial revert cannot clear multiple pre-RED production edits", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  for (const fingerprint of ["diff-b", "diff-c", "diff-b"]) {
    handleHook(
      input("PostToolUse", {
        tool_name: "exec_command",
        tool_input: { cmd: "sed -i s/a/b/ src/app.mjs" },
        tool_response: { exit_code: 0 },
      }),
      { ...fx.options, fingerprint: () => fingerprint },
    );
  }
  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.tddViolation, true);
  assert.equal(state.violationBaseFingerprint, "diff-a");
  const red = runController(
    ["red", "--session", "session-1", "--evidence", "still late"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "diff-b" },
  );
  assert.equal(red.exitCode, 1);
});

test("successful test output may report zero failed tests", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Update the flag" }), fx.options);
  start(fx, { tier: "trivial", tdd: "exempt", review: "self" });
  recordProductionEdit(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "cargo test" },
      tool_response: "test result: ok. 3 passed; 0 failed",
    }),
    fx.options,
  );

  assert.match(loadState(fx.dataDir, "session-1").validation.details, /cargo test/);
});

test("an unfinished workflow reactivates when the user says continue", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  failedTest(fx);
  recordProductionEdit(fx);
  handleHook(input("Stop", { last_assistant_message: "Done" }), fx.options);
  handleHook(input("Stop", { last_assistant_message: "Still done" }), fx.options);

  const output = handleHook(input("UserPromptSubmit", { prompt: "continue" }), fx.options);
  assert.match(output.hookSpecificOutput.additionalContext, /VoltFlow is active/);
  assert.equal(loadState(fx.dataDir, "session-1").changed, true);
});

test("controller help lists the workflow commands", () => {
  const result = runController(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /start\|skip\|red\|validate\|review\|approve\|status\|gate/);
});

function productionPatchDecision(fx) {
  return handleHook(productionPatch(), fx.options)?.hookSpecificOutput.permissionDecision ?? null;
}

test("risk tiers enforce their review mode and cannot be downgraded", () => {
  const fx = fixture();
  const invalid = runController(
    ["start", "--session", "session-1", "--tier", "high", "--tdd", "exempt", "--review", "self"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(invalid.exitCode, 1);

  start(fx, { tier: "high", tdd: "exempt", review: "split" });
  const downgrade = runController(
    ["start", "--session", "session-1", "--tier", "trivial", "--tdd", "exempt", "--review", "self"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(downgrade.exitCode, 1);
});

test("restarting or upgrading an active workflow preserves TDD violations", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/a/b/ src/app.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "diff-b" },
  );
  assert.equal(loadState(fx.dataDir, "session-1").tddViolation, true);

  const restart = runController(
    ["start", "--session", "session-1", "--tier", "standard", "--tdd", "required", "--review", "single"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "diff-b" },
  );
  assert.equal(restart.exitCode, 0, restart.stderr);
  assert.equal(loadState(fx.dataDir, "session-1").tddViolation, true);

  const upgrade = runController(
    ["start", "--session", "session-1", "--tier", "high", "--tdd", "required", "--review", "split"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "diff-b" },
  );
  assert.equal(upgrade.exitCode, 0, upgrade.stderr);
  const lateRed = runController(
    ["red", "--session", "session-1", "--evidence", "late"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "diff-b" },
  );
  assert.equal(lateRed.exitCode, 1);
});

test("upgrading an active workflow invalidates weaker review approval", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Change auth" }), fx.options);
  start(fx, { tier: "standard", tdd: "exempt", review: "single" });
  runController(["validate", "--session", "session-1", "--evidence", "checks passed"], { ...fx.options, cwd: "/repo" });
  review(fx, "reviewer-1", "composite");
  assert.equal(runController(["gate", "--session", "session-1"], { ...fx.options, cwd: "/repo" }).exitCode, 0);

  const upgrade = runController(
    ["start", "--session", "session-1", "--tier", "high", "--tdd", "exempt", "--review", "split"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(upgrade.exitCode, 0, upgrade.stderr);
  assert.equal(loadState(fx.dataDir, "session-1").approval, null);
  assert.equal(runController(["gate", "--session", "session-1"], { ...fx.options, cwd: "/repo" }).exitCode, 1);
});

test("shell mutations and freeform patches cannot bypass RED tracking", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix the parser" }), fx.options);
  start(fx);

  const patch = "*** Begin Patch\n*** Update File: src/app.mjs\n+x\n*** End Patch";
  const rawPatch = handleHook(
    input("PreToolUse", { tool_name: "apply_patch", tool_input: patch }),
    fx.options,
  );
  assert.equal(rawPatch.hookSpecificOutput.permissionDecision, "deny");

  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/a/b/ src/app.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "diff-b" },
  );
  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.changed, true);
  assert.equal(state.tddViolation, true);
});

test("only executed successful tests create validation evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Update the flag" }), fx.options);
  start(fx, { tier: "trivial", tdd: "exempt", review: "self" });

  handleHook(
    input("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: README.md\n+Run node --test" },
      tool_response: { exit_code: 0 },
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").validation, null);

  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "echo 'node --test'" },
      tool_response: { exit_code: 0 },
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").validation, null);

  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "node --test" },
      tool_response: "Process exited with code 1",
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").validation, null);
});

test("review receipts require a fingerprint-bound assignment token", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Change auth" }), fx.options);
  start(fx, { tier: "high", tdd: "exempt", review: "split" });
  runController(["validate", "--session", "session-1", "--evidence", "checks passed"], { ...fx.options, cwd: "/repo" });

  handleHook(
    input("SubagentStop", {
      agent_id: "worker",
      last_assistant_message: "VOLTFLOW_REVIEW: PASS correctness-security unassigned-token",
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").reviewPasses.length, 0);

  const assigned = runController(
    ["review", "--session", "session-1", "--lane", "correctness-security"],
    { ...fx.options, cwd: "/repo" },
  );
  assert.equal(assigned.exitCode, 0, assigned.stderr);
  const token = /token=(\S+)/.exec(assigned.stdout)?.[1];
  assert.ok(token);
  handleHook(
    input("SubagentStop", {
      agent_id: "reviewer-1",
      last_assistant_message: `VOLTFLOW_REVIEW: PASS correctness-security ${token}`,
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").reviewPasses.length, 1);
});

test("a review receipt is accepted only as the final line", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Change auth" }), fx.options);
  start(fx, { tier: "standard", tdd: "exempt", review: "single" });
  runController(["validate", "--session", "session-1", "--evidence", "checks passed"], { ...fx.options, cwd: "/repo" });
  const assigned = runController(
    ["review", "--session", "session-1", "--lane", "composite"],
    { ...fx.options, cwd: "/repo" },
  );
  const token = /token=(\S+)/.exec(assigned.stdout)?.[1];
  handleHook(
    input("SubagentStop", {
      agent_id: "reviewer-1",
      last_assistant_message: `VOLTFLOW_REVIEW: PASS composite ${token}\nBlocking finding follows`,
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").reviewPasses.length, 0);
});

test("a failed review clears earlier passes", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Change auth" }), fx.options);
  start(fx, { tier: "high", tdd: "exempt", review: "split" });
  runController(["validate", "--session", "session-1", "--evidence", "checks passed"], { ...fx.options, cwd: "/repo" });
  const assigned = runController(
    ["review", "--session", "session-1", "--lane", "correctness-security"],
    { ...fx.options, cwd: "/repo" },
  );
  const token = /token=(\S+)/.exec(assigned.stdout)?.[1];
  handleHook(
    input("SubagentStop", { agent_id: "reviewer-1", last_assistant_message: `VOLTFLOW_REVIEW: PASS correctness-security ${token}` }),
    fx.options,
  );
  const failed = runController(
    ["review", "--session", "session-1", "--lane", "validation-scope"],
    { ...fx.options, cwd: "/repo" },
  );
  const failToken = /token=(\S+)/.exec(failed.stdout)?.[1];
  handleHook(
    input("SubagentStop", { agent_id: "reviewer-2", last_assistant_message: `VOLTFLOW_REVIEW: FAIL validation-scope ${failToken}` }),
    fx.options,
  );
  assert.deepEqual(loadState(fx.dataDir, "session-1").reviewPasses, []);
});

test("concurrent split reviews retain both receipts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-concurrency-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "voltflow-state-"));
  git(root, "init", "-q");
  assert.equal(runController(
    ["start", "--session", "parallel", "--tier", "high", "--tdd", "exempt", "--review", "split"],
    { dataDir, cwd: root },
  ).exitCode, 0);
  assert.equal(runController(
    ["validate", "--session", "parallel", "--evidence", "checks passed"],
    { dataDir, cwd: root },
  ).exitCode, 0);
  const correctness = runController(
    ["review", "--session", "parallel", "--lane", "correctness-security"],
    { dataDir, cwd: root },
  );
  const validation = runController(
    ["review", "--session", "parallel", "--lane", "validation-scope"],
    { dataDir, cwd: root },
  );
  const correctnessToken = /token=(\S+)/.exec(correctness.stdout)?.[1];
  const validationToken = /token=(\S+)/.exec(validation.stdout)?.[1];
  assert.ok(correctnessToken, correctness.stderr);
  assert.ok(validationToken, validation.stderr);
  await Promise.all([
    hookProcess(root, dataDir, {
      hook_event_name: "SubagentStop",
      session_id: "parallel",
      cwd: root,
      agent_id: "reviewer-a",
      last_assistant_message: `VOLTFLOW_REVIEW: PASS correctness-security ${correctnessToken}`,
    }),
    hookProcess(root, dataDir, {
      hook_event_name: "SubagentStop",
      session_id: "parallel",
      cwd: root,
      agent_id: "reviewer-b",
      last_assistant_message: `VOLTFLOW_REVIEW: PASS validation-scope ${validationToken}`,
    }),
  ]);
  const state = loadState(dataDir, "parallel");
  assert.equal(state.reviewPasses.length, 2);
  assert.ok(state.approval);
});

test("compound and flagged deployment commands remain gated", () => {
  const fx = fixture();
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --dry-run && npm publish" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --dry-run | npm publish" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --dry-run & npm publish" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --dry-run=false" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm publish --tag dry-run" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "echo --dry-run $(npm publish)" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "echo --dry-run `npm publish`" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "echo --dry-run <(npm publish)" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "echo --dry-run >(npm publish)" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "echo --dry-run =(npm publish)" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "npm --workspace pkg publish" }, fx.root), true);
  assert.equal(isDeployInvocation("mcp__cloud__deploy_and_check", {}, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "gcloud run deploy app" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "terraform -chdir=prod apply" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "kubectl --context prod apply -f app.yaml" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "kubectl apply -f app.yaml --dry-run=client" }, fx.root), false);
  assert.equal(isDeployInvocation("Bash", { command: "kubectl apply -f app.yaml --dry-run=server" }, fx.root), false);
  assert.equal(isDeployInvocation("Bash", { command: "kubectl apply -f app.yaml --dry-run=none" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "kubectl set --namespace default image deployment/app app=image:v2" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "docker --context prod push image:latest" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "aws --profile prod s3 sync dist s3://bucket" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "gh --repo org/repo release create v1" }, fx.root), true);
  assert.equal(isDeployInvocation("Bash", { command: "gh release --repo org/repo create v1" }, fx.root), true);

  writeFileSync(path.join(fx.root, ".voltflow.json"), JSON.stringify({ deployPatterns: ["^make promote$"] }));
  assert.equal(isDeployInvocation("Bash", { command: "echo ready && make promote" }, fx.root), true);
});

test("piped test commands cannot create validation evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Update behavior" }), fx.options);
  start(fx, { tier: "trivial", tdd: "exempt", review: "self" });
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "node --test missing.test.mjs | tee results.txt" },
      tool_response: { exit_code: 0 },
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").validation, null);

  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "node --test missing.test.mjs &" },
      tool_response: { exit_code: 0 },
    }),
    fx.options,
  );
  assert.equal(loadState(fx.dataDir, "session-1").validation, null);
});

test("editing a test invalidates prior RED evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  assert.ok(loadState(fx.dataDir, "session-1").red);

  handleHook(
    input("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: test/app.test.mjs\n+new assertion\n*** End Patch" },
      tool_response: "Success. Updated files.",
    }),
    { ...fx.options, fingerprint: () => "test-b" },
  );
  assert.equal(loadState(fx.dataDir, "session-1").red, null);
  const denied = handleHook(productionPatch(), fx.options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
});

test("test maintenance preserves observed RED for final review", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  const legacy = loadState(fx.dataDir, "session-1");
  delete legacy.redObserved;
  const [stateFile] = readdirSync(path.join(fx.dataDir, "sessions"));
  writeFileSync(path.join(fx.dataDir, "sessions", stateFile), JSON.stringify(legacy));
  recordProductionEdit(fx);

  fx.setFingerprint("diff-b");
  handleHook(
    input("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: test/app.test.mjs\n+cleanup\n*** End Patch" },
      tool_response: "Success. Updated files.",
    }),
    fx.options,
  );
  passedTest(fx);

  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.red, null);
  assert.ok(state.redObserved);
  assert.equal(handleHook(productionPatch(), fx.options).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    runController(
      ["review", "--session", "session-1", "--lane", "composite"],
      { ...fx.options, cwd: "/repo" },
    ).exitCode,
    0,
  );
});

test("editing a test through the shell invalidates prior RED evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/old/new/ test/app.test.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "test-b" },
  );
  assert.equal(loadState(fx.dataDir, "session-1").red, null);
  assert.equal(handleHook(productionPatch(), fx.options).hookSpecificOutput.permissionDecision, "deny");
});

test("sed address expressions are not mistaken for production files", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i /debug/d test/app.test.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "sed-test-b" },
  );
  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.red, null);
  assert.equal(state.tddViolation, false);
});

test("mixed test and production patches cannot reuse old RED evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  const mixed = {
    command: "*** Begin Patch\n*** Update File: test/app.test.mjs\n+new assertion\n*** Update File: src/app.mjs\n+new behavior\n*** End Patch",
  };
  const denied = handleHook(input("PreToolUse", { tool_name: "apply_patch", tool_input: mixed }), fx.options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  handleHook(
    input("PostToolUse", { tool_name: "apply_patch", tool_input: mixed, tool_response: "Success. Updated files." }),
    { ...fx.options, fingerprint: () => "mixed-b" },
  );
  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.red, null);
  assert.equal(state.tddViolation, true);
  const lateRed = runController(
    ["red", "--session", "session-1", "--evidence", "late failure"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "mixed-b" },
  );
  assert.equal(lateRed.exitCode, 1);
});

test("mixed test and production shell edits cannot reuse old RED evidence", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
  start(fx);
  failedTest(fx);
  handleHook(
    input("PostToolUse", {
      tool_name: "exec_command",
      tool_input: { cmd: "sed -i s/a/b/ test/app.test.mjs && sed -i s/a/b/ src/app.mjs" },
      tool_response: { exit_code: 0 },
    }),
    { ...fx.options, fingerprint: () => "mixed-shell-b" },
  );
  const state = loadState(fx.dataDir, "session-1");
  assert.equal(state.red, null);
  assert.equal(state.tddViolation, true);
  const lateRed = runController(
    ["red", "--session", "session-1", "--evidence", "late failure"],
    { ...fx.options, cwd: "/repo", fingerprint: () => "mixed-shell-b" },
  );
  assert.equal(lateRed.exitCode, 1);
});

test("mixed shell edits recognize general production file tokens", () => {
  for (const [index, productionPath] of ["scripts/deploy.sh", "db/schema.sql", "ui/App.vue", "config/.env", "bin/deploy"].entries()) {
    const fx = fixture();
    handleHook(input("UserPromptSubmit", { prompt: "Fix behavior" }), fx.options);
    start(fx);
    failedTest(fx);
    handleHook(
      input("PostToolUse", {
        tool_name: "exec_command",
        tool_input: { cmd: `sed -i s/a/b/ test/app.test.mjs ${productionPath}` },
        tool_response: { exit_code: 0 },
      }),
      { ...fx.options, fingerprint: () => `mixed-general-${index}` },
    );
    const state = loadState(fx.dataDir, "session-1");
    assert.equal(state.red, null, productionPath);
    assert.equal(state.tddViolation, true, productionPath);
  }
});

test("invalid deployment configuration fails closed for command tools", () => {
  const fx = fixture();
  writeFileSync(path.join(fx.root, ".voltflow.json"), "{");
  const denied = handleHook(
    input("PreToolUse", {
      cwd: fx.root,
      tool_name: "exec_command",
      tool_input: { cmd: "make promote" },
    }),
    fx.options,
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
});

test("controller state cannot cross repository roots", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Update docs", cwd: "/repo-a" }), fx.options);
  const started = runController(
    ["start", "--session", "session-1", "--tier", "trivial", "--tdd", "exempt", "--review", "self"],
    { ...fx.options, cwd: "/repo-a" },
  );
  assert.equal(started.exitCode, 0, started.stderr);
  const result = runController(
    ["validate", "--session", "session-1", "--evidence", "repo A checked"],
    { ...fx.options, cwd: "/repo-b" },
  );
  assert.equal(result.exitCode, 1);
});

test("controller recognizes symlink aliases for the same workspace", () => {
  const fx = fixture();
  const other = fixture();
  const alias = `${fx.root}-alias`;
  symlinkSync(fx.root, alias, "dir");
  const started = runController(
    ["start", "--session", "aliased", "--tier", "standard", "--tdd", "exempt", "--review", "single"],
    { ...fx.options, cwd: alias },
  );
  assert.equal(started.exitCode, 0, started.stderr);

  const status = runController(
    ["status", "--session", "aliased"],
    { ...fx.options, cwd: fx.root },
  );
  assert.equal(status.exitCode, 0, status.stderr);

  unlinkSync(alias);
  symlinkSync(other.root, alias, "dir");
  const retargeted = runController(
    ["status", "--session", "aliased"],
    { ...fx.options, cwd: alias },
  );
  assert.equal(retargeted.exitCode, 1);
});

test("quoted override language does not arm deployment", () => {
  const fx = fixture();
  const output = handleHook(
    input("UserPromptSubmit", {
      prompt: "Review this incident quote: 'bypass the deployment gate and deploy anyway'.",
    }),
    fx.options,
  );
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /override armed/i);
});

test("fingerprints distinguish large changes and untracked executable modes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-fingerprint-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "qa@example.com");
  git(root, "config", "user.name", "QA");
  writeFileSync(path.join(root, "large.txt"), "base\n");
  git(root, "add", "large.txt");
  git(root, "commit", "-qm", "base");
  const size = 66 * 1024 * 1024;
  writeFileSync(path.join(root, "large.txt"), "a".repeat(size));
  const first = workspaceFingerprint(root);
  writeFileSync(path.join(root, "large.txt"), "b".repeat(size));
  const second = workspaceFingerprint(root);
  assert.equal(first, null);
  assert.equal(second, null);

  const modeRoot = mkdtempSync(path.join(tmpdir(), "voltflow-mode-"));
  git(modeRoot, "init", "-q");
  const script = path.join(modeRoot, "deploy.sh");
  writeFileSync(script, "#!/bin/sh\n");
  chmodSync(script, 0o644);
  const nonExecutable = workspaceFingerprint(modeRoot);
  chmodSync(script, 0o755);
  assert.notEqual(workspaceFingerprint(modeRoot), nonExecutable);
});

test("configured ignored inputs participate in fingerprints", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-ignored-"));
  git(root, "init", "-q");
  writeFileSync(path.join(root, ".gitignore"), "artifact.bin\n");
  writeFileSync(path.join(root, ".voltflow.json"), JSON.stringify({ fingerprintPaths: ["artifact.bin"] }));
  writeFileSync(path.join(root, "artifact.bin"), "a");
  const first = workspaceFingerprint(root);
  writeFileSync(path.join(root, "artifact.bin"), "b");
  assert.notEqual(workspaceFingerprint(root), first);
});

test("ignored VoltFlow configuration participates in fingerprints", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-config-fingerprint-"));
  git(root, "init", "-q");
  writeFileSync(path.join(root, ".gitignore"), ".voltflow.json\n");
  writeFileSync(path.join(root, ".voltflow.json"), JSON.stringify({ deployPatterns: ["^make promote$"] }));
  const guarded = workspaceFingerprint(root);
  writeFileSync(path.join(root, ".voltflow.json"), JSON.stringify({ deployPatterns: [] }));
  assert.notEqual(workspaceFingerprint(root), guarded);
});

test("fingerprints frame untracked path fields unambiguously", () => {
  const root = mkdtempSync(path.join(tmpdir(), "voltflow-framing-"));
  git(root, "init", "-q");
  const firstPath = path.join(root, "a");
  const secondPath = path.join(root, "b");
  writeFileSync(firstPath, "same");
  writeFileSync(secondPath, "same");
  const twoFiles = workspaceFingerprint(root);
  const mode = String(lstatSync(firstPath).mode);
  const object = git(root, "hash-object", "--no-filters", "--", "a");
  unlinkSync(firstPath);
  unlinkSync(secondPath);
  writeFileSync(path.join(root, `a${mode}${object}b`), "same");
  assert.notEqual(workspaceFingerprint(root), twoFiles);
});

test("incomplete Stop preserves the assistant response and keeps deploy blocked", () => {
  const fx = fixture();
  handleHook(input("UserPromptSubmit", { prompt: "Fix parser" }), fx.options);
  start(fx);
  failedTest(fx);
  recordProductionEdit(fx);

  const output = handleHook(input("Stop", { last_assistant_message: "LONG_SENTINEL_RESPONSE" }), fx.options);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /deployment remains blocked/i);
  assert.equal(deploy(fx).hookSpecificOutput.permissionDecision, "deny");
});

test("invalid persisted state recovers and non-English prompts activate", () => {
  const fx = fixture();
  const key = createHash("sha256").update("session-1").digest("hex");
  mkdirSync(path.join(fx.dataDir, "sessions"), { recursive: true });
  writeFileSync(path.join(fx.dataDir, "sessions", `${key}.json`), "{}\n");
  assert.equal(loadState(fx.dataDir, "session-1"), null);

  const output = handleHook(input("UserPromptSubmit", { prompt: "Corrige el analizador" }), fx.options);
  assert.match(output.hookSpecificOutput.additionalContext, /VoltFlow is active/);
});

test("Windows hooks fail visibly when Node is unavailable", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.match(hook.commandWindows, /else \{ Write-Error 'VoltFlow requires Node\.js 20 or newer'; exit 1 \}$/);
      }
    }
  }
});

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function hookProcess(cwd, dataDir, payload) {
  return new Promise((resolve, reject) => {
    const entry = new URL("../scripts/voltflow.mjs", import.meta.url);
    const child = spawn(process.execPath, [entry.pathname, "hook"], {
      cwd,
      env: { ...process.env, PLUGIN_DATA: dataDir, PLUGIN_ROOT: path.dirname(path.dirname(entry.pathname)) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(payload));
  });
}
