#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TIERS = new Set(["trivial", "standard", "high"]);
const TDD_MODES = new Set(["required", "exempt"]);
const REVIEW_MODES = new Set(["self", "single", "split"]);
const MUTATING_COMMANDS = new Set(["start", "skip", "red", "validate", "review", "approve", "status"]);
const SPLIT_LANES = new Set(["correctness-security", "validation-scope"]);
const REVIEW_RANK = { self: 0, single: 1, split: 2 };
const TIER_RANK = { trivial: 0, standard: 1, high: 2 };
const REQUIRED_REVIEW = { trivial: "self", standard: "single", high: "split" };
const VALUE_WARNING =
  "VoltFlow value check: You have reopened a validated diff twice. Stop searching for further imperfections. Continue only for a concrete, reproducible, material blocker to the user's requested outcome, a repository invariant, or a safety boundary; otherwise validate the current change once and finish.";
const DEFAULT_DEPLOY_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\b(?:run\s+)?deploy\b/i,
  /\b(?:npm|pnpm|yarn|bun|cargo)\b[^\n;&|]*\bpublish\b/i,
  /\b(?:vercel|netlify)\b[^\n]*(?:--prod|--production)\b/i,
  /\b(?:firebase|fly|wrangler)\b[^\n;&|]*\b(?:deploy|publish)\b/i,
  /\bgcloud\b[^\n;&|]*\bdeploy\b/i,
  /\baws\b[^\n;&|]*\bs3\b[^\n;&|]*\b(?:cp|mv|sync)\b/i,
  /\brailway\b[^\n;&|]*\bup\b/i,
  /\bterraform\b[^\n;&|]*\bapply\b/i,
  /\bpulumi\b[^\n;&|]*\bup\b/i,
  /\bkubectl\b[^\n;&|]*(?:\b(?:apply|rollout)\b|\bset\b[^\n;&|]*\bimage\b)/i,
  /\bhelm\b[^\n;&|]*\b(?:install|upgrade)\b/i,
  /\bdocker\b[^\n;&|]*\bpush\b/i,
  /\bdocker\b[^\n;&|]*\bbuildx\b[^\n;&|]*\bbuild\b[^\n;&|]*\s--push\b/i,
  /\btwine\b[^\n;&|]*\bupload\b/i,
  /\bgh\b[^\n;&|]*\brelease\b[^\n;&|]*\bcreate\b/i,
];
const TEST_COMMAND = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^node\s+--test\b|^(?:pytest|vitest|jest|rspec|phpunit)\b|^python(?:3)?\s+-m\s+(?:pytest|unittest)\b|^(?:go|cargo|dotnet|swift|mix)\s+test\b|^(?:mvn|gradle|gradlew|xcodebuild)\b[^\n]*\btest\b/i;
const NON_EXECUTING_COMMANDS = /^(?:echo|printf|rg|grep|sed|cat|head|tail|less|man|type|which|whereis)$/i;
const TEST_OUTPUT = /(?:^|\n)(?:TAP version|(?:not )?ok \d+\s+-|Ran \d+ tests?|FAILED \(|OK\s*$|=+ .* (?:passed|failed|error)|test result:|Tests run:|(?:Test Files|Tests):\s+.*(?:passed|failed)|(?:PASS|FAIL)\s+\S+\.(?:test|spec)\.)/im;
const OVERRIDE_INTENT = /^\s*(?:(?:voltflow[:,]?\s+)?(?:please\s+)?(?:override|bypass|waive)\s+(?:the\s+)?(?:deployment\s+)?(?:gate|review|approval)\b[^\n]*\b(?:deploy|release|ship)\b|(?:voltflow[:,]?\s+)?(?:please\s+)?(?:deploy|release|ship)\b[^\n]{0,160}\b(?:anyway|regardless|despite|without\s+(?:a\s+|the\s+)?(?:review|approval|gate))\b[^\n]*)[.!]?\s*$/i;
const OVERRIDE_QUESTION = /^\s*(?:how|what|when|where|why|who|(?:can|could|should|would|do)\s+(?:i|we)|is\s+it)\b/i;
const OVERRIDE_NEGATION = /\b(?:do\s+not|don't|dont|never)\s+(?:\w+\s+){0,2}(?:override|bypass|ignore|overrule|waive|deploy|release|ship)\b/i;
const USAGE = [
  "Usage: voltflow.mjs start|skip|red|validate|review|approve|status|gate --session <id>",
  "start: --tier trivial|standard|high --tdd required|exempt --review self|single|split",
  "skip: --evidence <reason> (simple work only, before any change)",
  "red|validate: --evidence <text>",
  "review: --lane composite|correctness-security|validation-scope",
  "approve: --self --evidence <text>",
].join("\n");

export function handleHook(input, options = {}) {
  if (!isRecord(input) || typeof input.hook_event_name !== "string") return null;
  const context = hookContext(input, options);

  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return onUserPrompt(input, context);
    case "PreToolUse":
      return onPreToolUse(input, context);
    case "PostToolUse":
      return onPostToolUse(input, context);
    case "SubagentStart":
      return onSubagentStart(input, context);
    case "SubagentStop":
      return onSubagentStop(input, context);
    case "Stop":
      return onStop(input, context);
    default:
      return null;
  }
}

export function runController(argv, options = {}) {
  const { command, flags } = parseArguments(argv);
  if (["--help", "-h", "help"].includes(command)) return success(USAGE);
  const cwd = options.cwd ?? process.cwd();
  const dataDir = flags["data-dir"] ?? options.dataDir ?? process.env.PLUGIN_DATA ?? path.join(cwd, ".git", "voltflow");
  const sessionId = flags.session;
  const fingerprint = options.fingerprint ?? workspaceFingerprint;

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return failure("--session is required");
  }
  if (options.locked !== true && MUTATING_COMMANDS.has(command)) {
    return withStateLock(dataDir, sessionId, () => runController(argv, { ...options, locked: true }));
  }
  const currentFingerprint = fingerprint(cwd);
  const loaded = loadState(dataDir, sessionId, cwd);
  const related = relatedState(dataDir, sessionId, cwd);
  if (loaded === null && related === null && loadSessionStates(dataDir, sessionId).length > 0) {
    return failure("session belongs to a different Git repository");
  }
  const state = newerWorkflow(related, loaded)
    ? inheritedState(sessionId, cwd, related, currentFingerprint)
    : loaded ?? inheritedState(sessionId, cwd, related, currentFingerprint);

  if (command === "start") {
    if (!TIERS.has(flags.tier) || !TDD_MODES.has(flags.tdd) || !REVIEW_MODES.has(flags.review)) {
      return failure("start requires --tier trivial|standard|high, --tdd required|exempt, and --review self|single|split");
    }
    if (REVIEW_RANK[flags.review] < REVIEW_RANK[REQUIRED_REVIEW[flags.tier]]) {
      return failure(`${flags.tier} work requires review=${REQUIRED_REVIEW[flags.tier]} or stronger`);
    }
    if (TIERS.has(state.tier) && state.active === true) {
      if (TIER_RANK[flags.tier] < TIER_RANK[state.tier]) {
        return failure(`cannot downgrade an active workflow from ${state.tier} to ${flags.tier}`);
      }
      if (REVIEW_RANK[flags.review] < REVIEW_RANK[state.reviewMode]) {
        return failure(`cannot downgrade an active workflow from review=${state.reviewMode} to review=${flags.review}`);
      }
      if (flags.tdd !== state.tdd) {
        return failure(`cannot change an active workflow from tdd=${state.tdd} to tdd=${flags.tdd}`);
      }
      if (flags.tier !== state.tier || flags.review !== state.reviewMode) {
        state.reviewAssignments = [];
        state.reviewPasses = [];
        state.reviewFailure = null;
        state.approval = null;
      }
      state.tier = flags.tier;
      state.reviewMode = flags.review;
      state.updatedAt = timestamp();
      saveState(dataDir, state);
      return success(`VoltFlow updated: ${flags.tier}, tdd=${flags.tdd}, review=${flags.review}`);
    }
    Object.assign(state, {
      active: true,
      tier: flags.tier,
      tdd: flags.tdd,
      reviewMode: flags.review,
      changed: false,
      tddViolation: false,
      violationBaseFingerprint: null,
      red: null,
      redObserved: null,
      validation: null,
      reviewAssignments: [],
      reviewPasses: [],
      reviewFailure: null,
      approval: null,
      override: null,
      skip: null,
      lastFingerprint: currentFingerprint,
      stopBlocks: 0,
      reworkCycles: 0,
      valueWarningIssued: false,
      updatedAt: timestamp(),
    });
    saveState(dataDir, state);
    return success(`VoltFlow started: ${flags.tier}, tdd=${flags.tdd}, review=${flags.review}`);
  }

  if (command === "skip") {
    if (!textFlag(flags.evidence)) return failure("skip requires --evidence");
    if (state.changed) return failure("cannot skip VoltFlow after changes have started");
    Object.assign(state, {
      active: false,
      tier: "unclassified",
      tdd: "unclassified",
      reviewMode: "unclassified",
      red: null,
      redObserved: null,
      validation: null,
      reviewAssignments: [],
      reviewPasses: [],
      reviewFailure: null,
      approval: null,
      override: null,
      skip: evidence(flags.evidence, currentFingerprint),
      updatedAt: timestamp(),
    });
    saveState(dataDir, state);
    return success("VoltFlow skipped for this prompt; deployment remains gated");
  }

  if (command === "red") {
    if (state.tdd !== "required") return failure("red evidence is only valid when TDD is required");
    recoverRevertedViolation(state, currentFingerprint);
    if (state.tddViolation === true) return failure("production changed before RED; revert that edit before recording evidence");
    if (!textFlag(flags.evidence)) return failure("red requires --evidence");
    state.red = evidence(flags.evidence, currentFingerprint);
    state.redObserved = state.red;
    saveState(dataDir, state);
    return success("VoltFlow RED recorded");
  }

  if (command === "validate") {
    if (!textFlag(flags.evidence)) return failure("validate requires --evidence");
    if (currentFingerprint === null) return failure("Git fingerprint unavailable");
    state.validation = evidence(flags.evidence, currentFingerprint);
    saveState(dataDir, state);
    return success("VoltFlow validation recorded");
  }

  if (command === "review") {
    const allowed = state.reviewMode === "single" ? new Set(["composite"]) : SPLIT_LANES;
    if (!allowed.has(flags.lane)) return failure(`review lane is invalid for review=${state.reviewMode}`);
    const blocker = evidenceBlocker(state, currentFingerprint);
    if (blocker !== null) return failure(blocker);
    const token = randomUUID();
    state.reviewAssignments = state.reviewAssignments.filter((entry) => entry.lane !== flags.lane);
    state.reviewAssignments.push({ lane: flags.lane, token, fingerprint: currentFingerprint, at: timestamp() });
    saveState(dataDir, state);
    return success(`VoltFlow review assigned: ${flags.lane} token=${token}`);
  }

  if (command === "approve") {
    if (flags.self !== true) return failure("approve requires --self");
    if (state.reviewMode !== "self") return failure("self approval is only valid for review=self");
    if (!textFlag(flags.evidence)) return failure("approve requires --evidence");
    const blocker = evidenceBlocker(state, currentFingerprint);
    if (blocker !== null) return failure(blocker);
    state.approval = approval(currentFingerprint, "self", flags.evidence);
    saveState(dataDir, state);
    return success("VoltFlow self-review approved for the current diff");
  }

  if (command === "status") {
    if (state !== loaded) saveState(dataDir, state);
    return success(JSON.stringify(state, null, 2));
  }

  if (command === "gate") {
    const current = fingerprint(cwd);
    const gate = gateStatus(state, current);
    return gate.allowed ? success(`VoltFlow gate passed: ${gate.source}`) : failure(gate.reason);
  }

  return failure(USAGE);
}

export function loadState(dataDir, sessionId, cwd) {
  const primary = loadStateFile(statePath(dataDir, sessionId), sessionId);
  if (cwd === undefined || primary !== null && sameWorkspace(primary.cwd, cwd)) return primary;
  return loadStateFile(worktreeStatePath(dataDir, sessionId, cwd), sessionId);
}

function loadStateFile(file, sessionId) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return validState(value, sessionId) ? value : null;
  } catch {
    return null;
  }
}

export function isDeployInvocation(toolName, toolInput, cwd) {
  if (isEditTool(toolName)) return false;
  const command = commandFrom(toolInput);
  const config = loadProjectConfig(cwd);
  if (command !== null) {
    for (const segment of shellSegments(command)) {
      if (isDryRunSegment(segment)) continue;
      if (DEFAULT_DEPLOY_PATTERNS.some((pattern) => pattern.test(segment))) return true;
      if (config.deployPatterns.some((pattern) => pattern.test(segment))) return true;
    }
  }

  if (config.deployTools.some((pattern) => pattern.test(toolName))) return true;

  if (/(?:^|__|\.)(?:deploy|publish|promote|rollout|release_create|create_release)(?:$|__|\.|_)/i.test(toolName)) return true;
  return false;
}

export function workspaceFingerprint(cwd) {
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) return null;
  const root = rootResult.stdout.trim();
  const hash = createHash("sha256");
  hashField(hash, "root", root);

  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  hashField(hash, "head", head.ok ? head.stdout : "unborn");
  for (const args of [
    ["diff", "--binary", "--no-ext-diff"],
    ["diff", "--binary", "--cached", "--no-ext-diff"],
  ]) {
    const result = git(root, args);
    if (!result.ok) return null;
    hashField(hash, args.includes("--cached") ? "cached-diff" : "worktree-diff", result.stdout);
  }

  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!untracked.ok) return null;
  for (const relativePath of untracked.stdout.split("\0").filter(Boolean).sort()) {
    if (!hashWorkspacePath(hash, root, relativePath)) return null;
  }

  const config = loadProjectConfig(root);
  if (config.error !== null) return null;
  if (!hashWorkspacePath(hash, root, ".voltflow.json", true)) return null;
  for (const relativePath of config.fingerprintPaths) {
    if (relativePath === ".voltflow.json") continue;
    if (!hashWorkspacePath(hash, root, relativePath, true)) return null;
  }
  return hash.digest("hex");
}

function onUserPrompt(input, context) {
  if (typeof input.session_id !== "string") return null;
  return withStateLock(context.dataDir, input.session_id, () => onUserPromptLocked(input, context));
}

function onUserPromptLocked(input, context) {
  if (typeof input.prompt !== "string" || typeof input.session_id !== "string") return null;
  const previous = loadState(context.dataDir, input.session_id, input.cwd);
  const overrideReason = deploymentOverrideReason(input.prompt);
  const current = context.fingerprint(input.cwd);

  if (overrideReason !== null) {
    const state = previous ?? freshState(input.session_id, input.cwd, null, current);
    if (current === null) return userContext("VoltFlow override not armed: a Git worktree is required.");
    state.override = {
      reason: overrideReason,
      fingerprint: current,
      consumed: false,
      at: timestamp(),
    };
    saveState(context.dataDir, state);
    return userContext("VoltFlow deployment override armed for one matching deployment on the current diff.");
  }

  const unfinished = previous?.changed === true && previous.approval?.fingerprint !== current;
  const continuing = previous?.active === true || unfinished;
  const state = continuing
    ? previous
    : freshState(input.session_id, input.cwd, previous, current);
  const previousPromptHash = state.promptHash;
  const previousWorkflowId = state.workflowId;
  if (continuing && typeof state.workflowId !== "string") state.workflowId = randomUUID();
  state.active = true;
  state.promptHash = createHash("sha256").update(input.prompt).digest("hex");
  state.stopBlocks = 0;
  state.reworkCycles = 0;
  state.valueWarningIssued = false;
  state.updatedAt = timestamp();
  saveState(context.dataDir, state);
  if (continuing) {
    for (const related of relatedStates(context.dataDir, input.session_id, input.cwd)) {
      const sameWorkflow = typeof previousWorkflowId === "string"
        ? related.workflowId === previousWorkflowId
        : related.workflowId === undefined && related.promptHash === previousPromptHash;
      if (!sameWorkflow) continue;
      related.workflowId = state.workflowId;
      related.promptHash = state.promptHash;
      saveState(context.dataDir, related);
    }
  }

  const prefix = controllerPrefix(context, input.session_id);
  const configNote = context.configError === null ? "" : ` Config warning: ${context.configError}`;
  return userContext(
    `VoltFlow is active. Before editing, run ${prefix.replace("<command>", "start")} --tier <trivial|standard|high> --tdd <required|exempt> --review <self|single|split>. ` +
      `If the controller cannot access PLUGIN_DATA inside the sandbox, rerun the exact command with external permission; do not relocate the approval state. ` +
      `For a simple, low-risk edit with no deployment intent, replace start with skip and add --evidence <reason>; skip must happen before any change and does not approve deployment. ` +
      `For manual evidence, replace start with red or validate and add --evidence <text>; self review uses approve --self --evidence <text>. ` +
      `Before an independent review, replace start with review and add --lane <lane>; give its returned token to the reviewer, whose final receipt must be VOLTFLOW_REVIEW: PASS|FAIL <lane> <token>. ` +
      `When a subagent spawn or status reports "Selected model is at capacity", wait 3, 6, and 9 seconds for the first three retries, then use a 9-second cap, for at most ten replacement spawns; preserve the same assignment, model, reasoning, scope, and evidence contract, and stop after the first success or a different error. ` +
      `Completion bar: finish when current evidence shows the result is safe and satisfies the requested scope. Theoretical edge cases are advisory unless they are reproducible in ordinary documented use and break requested behavior, a repository invariant, or a material safety boundary. Do not reopen validated work for speculative improvement.${configNote}`,
  );
}

function deploymentOverrideReason(prompt) {
  const text = prompt.trim();
  if (OVERRIDE_QUESTION.test(text) || OVERRIDE_NEGATION.test(text) || !OVERRIDE_INTENT.test(text)) return null;
  return text;
}

function onPreToolUse(input, context) {
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string" || typeof input.tool_name !== "string") return null;
  const workspace = hookWorkspace(input);
  if (workspace.error !== null) return deny(`VoltFlow blocked the tool: ${workspace.error}`);
  if (workspace.unmanaged === true) return null;
  const state = withStateLock(context.dataDir, input.session_id, () => {
    const existing = loadState(context.dataDir, input.session_id, workspace.cwd);
    const related = relatedState(context.dataDir, input.session_id, workspace.cwd);
    if (existing !== null && !newerWorkflow(related, existing)) return existing;
    if (related === null) return null;
    const inherited = inheritedState(input.session_id, workspace.cwd, related, context.fingerprint(workspace.cwd));
    saveState(context.dataDir, inherited);
    return inherited;
  });
  if (state === null && loadSessionStates(context.dataDir, input.session_id).length > 0) {
    return deny("VoltFlow blocked the tool: this session has no workflow state for that Git repository.");
  }
  const configError = loadProjectConfig(workspace.cwd).error;
  if (configError !== null && isCommandTool(input.tool_name)) {
    return deny(`VoltFlow configuration must be fixed before command execution: ${configError}`);
  }
  if (
    state?.active === true
    && input.tool_name.endsWith("spawn_agent")
    && isRecord(input.tool_input)
    && typeof input.tool_input.task_name === "string"
    && input.tool_input.fork_turns !== "none"
  ) {
    return deny('VoltFlow requires v2 subagents to use fork_turns: "none".');
  }

  if (isDeployInvocation(input.tool_name, input.tool_input, workspace.cwd)) {
    if (state === null) return deny("VoltFlow blocked deployment: no workflow state or review receipt exists.");
    const current = context.fingerprint(workspace.cwd);
    const gate = gateStatus(state, current);
    if (!gate.allowed) return deny(`VoltFlow blocked deployment: ${gate.reason}`);
    if (gate.source === "user override") {
      return withStateLock(context.dataDir, input.session_id, () => {
        const fresh = loadState(context.dataDir, input.session_id, workspace.cwd);
        if (fresh === null) {
          return deny("VoltFlow blocked deployment: workflow state changed before the override could be consumed.");
        }
        const freshGate = gateStatus(fresh, context.fingerprint(workspace.cwd));
        if (freshGate.source !== "user override") {
          return deny(`VoltFlow blocked deployment: ${freshGate.reason ?? "the one-shot override was already consumed"}.`);
        }
        fresh.override.consumed = true;
        saveState(context.dataDir, fresh);
        return null;
      });
    }
    return null;
  }

  if (state?.active !== true || !isEditTool(input.tool_name)) return null;
  const paths = editedPaths(input.tool_input);
  if (paths.length === 0) return null;
  if (!validClassification(state)) {
    return deny("VoltFlow requires start classification before the first edit.");
  }
  if (state.tdd === "required" && paths.some(isTestPath) && paths.some((file) => !isTestPath(file))) {
    return deny("VoltFlow requires test and production edits to be separate. Update the test, rerun RED, then edit production.");
  }
  if (state.tdd === "required" && state.red === null && paths.some((file) => !isTestPath(file))) {
    return deny("VoltFlow requires a failing test or reproduction before production edits. Add the focused test, run it, and verify the expected failure.");
  }
  return null;
}

function onPostToolUse(input, context) {
  if (typeof input.session_id !== "string") return null;
  return withStateLock(context.dataDir, input.session_id, () => onPostToolUseLocked(input, context));
}

function onPostToolUseLocked(input, context) {
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string") return null;
  const workspace = hookWorkspace(input);
  if (workspace.error !== null) return null;
  if (workspace.unmanaged === true) return null;
  const state = loadState(context.dataDir, input.session_id, workspace.cwd);
  if (state?.active !== true) return null;
  const current = context.fingerprint(workspace.cwd);
  const recoveredViolation = recoverRevertedViolation(state, current);

  const editTool = typeof input.tool_name === "string" && isEditTool(input.tool_name);
  const command = typeof input.tool_name === "string" && isCommandTool(input.tool_name)
    ? commandFrom(input.tool_input)
    : null;
  const testCommand = command !== null && isTestCommand(command, input.tool_response);
  const failed = toolFailed(input.tool_response) || testCommand && testOutputFailed(input.tool_response);
  const fingerprintChanged = current !== null && state.lastFingerprint !== null && current !== state.lastFingerprint;
  let valueWarning = null;
  if ((!failed && editTool) || fingerprintChanged) {
    const paths = editedPaths(input.tool_input);
    const testOnlyEdit = editTool && paths.length > 0 && paths.every(isTestPath);
    const touchesTest = testCommand || (editTool && paths.some(isTestPath)) || (command !== null && commandMentionsTestPath(command));
    const touchesProduction = !testCommand && (
      (editTool && paths.some((file) => !isTestPath(file)))
      || (command !== null && commandMentionsProductionPath(command))
    );
    if (
      state.validation?.fingerprint === state.lastFingerprint
      && !testOnlyEdit
      && (touchesProduction || (fingerprintChanged && command !== null))
    ) {
      state.reworkCycles = (state.reworkCycles ?? 0) + 1;
      if (state.reworkCycles >= 2 && state.valueWarningIssued !== true) {
        state.valueWarningIssued = true;
        valueWarning = { systemMessage: VALUE_WARNING };
      }
    }
    if (state.tdd === "required" && state.red === null && state.tddViolation !== true && !testOnlyEdit && !testCommand && !recoveredViolation) {
      state.tddViolation = true;
      state.violationBaseFingerprint = fingerprintChanged ? state.lastFingerprint : null;
    }
    if (state.tdd === "required" && state.red !== null && state.tddViolation !== true && touchesTest && touchesProduction) {
      state.tddViolation = true;
      state.violationBaseFingerprint = fingerprintChanged ? state.lastFingerprint : null;
    }
    if (touchesTest) {
      state.redObserved ??= state.red;
      state.red = null;
    }
    invalidateForChange(state);
  }

  if (testCommand) {
    if (failed && state.tdd === "required" && state.tddViolation !== true) {
      state.red = evidence(command, current);
      state.redObserved = state.red;
    }
    if (!failed && current !== null) state.validation = evidence(command, current);
  }
  if (current !== null) state.lastFingerprint = current;
  state.updatedAt = timestamp();
  saveState(context.dataDir, state);
  return valueWarning;
}

function onSubagentStart(input, context) {
  const prefix = typeof input.session_id === "string" ? controllerPrefix(context, input.session_id) : null;
  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext:
        `VoltFlow subtask contract: ${prefix === null ? "" : `run ${prefix} from the assigned worktree; use external permission if protected plugin state is sandboxed. `}Stay inside the assigned WORK LAYER, OUTCOME, and SCOPE; return the requested EVIDENCE and stop at the stated condition. When TDD is required, define one behavior per implementation slice: write one focused test, observe the expected RED, make the minimum production change, reach GREEN, and finish RED→GREEN before starting the next slice. Do not batch tests or implement later behavior. For TDD-exempt work, do not create tests; use the closest useful validation. Validate every changed observable layer; syntax checks do not prove runtime behavior. Do not add adjacent cleanup or abstractions. A final reviewer must cover correctness, relevant security, validation quality, and excess scope. A finding blocks only when it is reproducible in ordinary documented use and breaks requested behavior, a repository invariant, or a material safety boundary; theoretical edge cases are advisory. PASS means the result is safe and satisfies scope, not that no improvement remains. Before returning a review receipt, remove only generated artifacts created by validation and confirm the assigned worktree fingerprint is unchanged. End with the exact assigned receipt VOLTFLOW_REVIEW: PASS <lane> <token> only when a material blocker remains absent; otherwise use FAIL with the same lane and token after reporting every blocker in one pass.`,
    },
  };
}

function onSubagentStop(input, context) {
  if (typeof input.session_id !== "string") return null;
  return withStateLock(context.dataDir, input.session_id, () => onSubagentStopLocked(input, context));
}

function onSubagentStopLocked(input, context) {
  if (typeof input.session_id !== "string" || typeof input.last_assistant_message !== "string") return null;
  const result = /(?:^|\n)VOLTFLOW_REVIEW:\s*(PASS|FAIL)\s+([a-z0-9][a-z0-9_-]*)\s+([a-f0-9-]+)\s*$/i.exec(
    input.last_assistant_message.trimEnd(),
  );
  if (result === null) return null;
  const [, outcome, lane, token] = result;
  const state = loadSessionStates(context.dataDir, input.session_id).find((candidate) =>
    candidate.reviewAssignments.some((entry) => entry.lane === lane && entry.token === token));
  if (state === undefined) return { systemMessage: "VoltFlow ignored an unassigned or stale review receipt." };
  if (!["single", "split"].includes(state.reviewMode)) return null;
  const current = context.fingerprint(state.cwd);
  const assignment = state.reviewAssignments.find(
    (entry) => entry.lane === lane && entry.token === token && entry.fingerprint === current,
  );
  if (assignment === undefined) {
    return { systemMessage: "VoltFlow ignored an unassigned or stale review receipt." };
  }

  if (outcome === "FAIL") {
    state.reviewFailure = { lane, at: timestamp() };
    state.reviewPasses = [];
    state.reviewAssignments = [];
    state.approval = null;
    saveState(context.dataDir, state);
    return null;
  }

  const blocker = evidenceBlocker(state, current);
  if (blocker !== null) return { systemMessage: `VoltFlow ignored review pass: ${blocker}` };
  if (current === null) return { systemMessage: "VoltFlow ignored review pass: Git fingerprint unavailable." };

  const agentId = typeof input.agent_id === "string" ? input.agent_id : "unknown";
  state.reviewPasses = state.reviewPasses.filter((entry) => entry.fingerprint === current);
  if (!state.reviewPasses.some((entry) => entry.agentId === agentId)) {
      state.reviewPasses.push({ agentId, lane, fingerprint: current, at: timestamp() });
  }
  state.reviewAssignments = state.reviewAssignments.filter((entry) => entry !== assignment);

  const approved = state.reviewMode === "single"
    ? state.reviewPasses.length >= 1
    : SPLIT_LANES.size === new Set(state.reviewPasses.filter((entry) => SPLIT_LANES.has(entry.lane)).map((entry) => entry.lane)).size;
  if (approved) {
    state.approval = approval(current, "subagent", state.reviewPasses.map((entry) => entry.lane).join(", "));
    state.reviewFailure = null;
  }
  saveState(context.dataDir, state);
  return null;
}

function onStop(input, context) {
  if (typeof input.session_id !== "string") return null;
  return withStateLock(context.dataDir, input.session_id, () => onStopLocked(input, context));
}

function onStopLocked(input, context) {
  if (typeof input.session_id !== "string") return null;
  const state = loadState(context.dataDir, input.session_id, input.cwd);
  if (state?.active !== true) return null;
  if (!state.changed) {
    state.active = false;
    saveState(context.dataDir, state);
    return null;
  }

  const pending = pendingReasons(state, context.fingerprint(input.cwd));
  if (pending.length === 0) {
    state.active = false;
    saveState(context.dataDir, state);
    return null;
  }
  const reason = `VoltFlow workflow incomplete: ${pending.join("; ")}.`;
  state.active = false;
  saveState(context.dataDir, state);
  return { systemMessage: `${reason} Deployment remains blocked.` };
}

function hookContext(input, options) {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const dataDir = options.dataDir ?? process.env.PLUGIN_DATA ?? path.join(cwd, ".git", "voltflow");
  const pluginRoot = options.pluginRoot ?? process.env.PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return {
    dataDir,
    pluginRoot,
    fingerprint: options.fingerprint ?? workspaceFingerprint,
    configError: loadProjectConfig(cwd).error,
  };
}

function freshState(sessionId, cwd, previous, currentFingerprint) {
  return {
    version: 1,
    sessionId,
    cwd: canonicalWorkspacePath(cwd),
    workflowId: randomUUID(),
    active: true,
    tier: "unclassified",
    tdd: "unclassified",
    reviewMode: "unclassified",
    changed: false,
    tddViolation: false,
    violationBaseFingerprint: null,
    red: null,
    redObserved: null,
    validation: null,
    reviewAssignments: [],
    reviewPasses: [],
    reviewFailure: null,
    approval: previous?.approval?.fingerprint === currentFingerprint ? previous.approval : null,
    override:
      previous?.override?.fingerprint === currentFingerprint && previous.override.consumed === false
        ? previous.override
        : null,
    skip: null,
    stopBlocks: 0,
    reworkCycles: 0,
    valueWarningIssued: false,
    lastFingerprint: currentFingerprint,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

function inheritedState(sessionId, cwd, source, currentFingerprint) {
  const state = freshState(sessionId, cwd, null, currentFingerprint);
  if (source === null) return state;
  Object.assign(state, {
    active: source.active,
    tier: source.tier,
    tdd: source.tdd,
    reviewMode: source.reviewMode,
    workflowId: source.workflowId ?? source.promptHash ?? state.workflowId,
    promptHash: source.promptHash,
  });
  return state;
}

function gateStatus(state, currentFingerprint) {
  if (currentFingerprint === null) return { allowed: false, reason: "Git fingerprint unavailable" };
  if (state.approval?.fingerprint === currentFingerprint) return { allowed: true, source: "review receipt" };
  if (state.override?.fingerprint === currentFingerprint && state.override.consumed === false) {
    return { allowed: true, source: "user override" };
  }
  return { allowed: false, reason: "no passing review or one-shot override matches the current diff" };
}

function pendingReasons(state, currentFingerprint) {
  const reasons = [];
  if (!validClassification(state)) reasons.push("classification missing or weaker than the selected tier");
  if (state.tdd === "required" && historicalRed(state) === null) reasons.push("RED evidence missing");
  if (state.tddViolation === true) reasons.push("production changed before RED");
  if (state.validation?.fingerprint !== currentFingerprint) reasons.push("fresh validation missing");
  if (state.approval?.fingerprint !== currentFingerprint) reasons.push("final review missing or stale");
  return reasons;
}

function evidenceBlocker(state, currentFingerprint) {
  if (state.tddViolation === true) return "production changed before RED";
  if (state.tdd === "required" && historicalRed(state) === null) return "RED evidence is missing";
  if (state.validation?.fingerprint !== currentFingerprint) return "fresh validation is missing";
  return null;
}

function saveState(dataDir, state) {
  const primaryPath = statePath(dataDir, state.sessionId);
  const primary = loadStateFile(primaryPath, state.sessionId);
  const file = primary === null || sameWorkspace(primary.cwd, state.cwd)
    ? primaryPath
    : worktreeStatePath(dataDir, state.sessionId, state.cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function withStateLock(dataDir, sessionId, operation) {
  const lock = `${statePath(dataDir, sessionId)}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15000) unlinkSync(lock);
      } catch {
        // Another hook released the lock between checks.
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for the VoltFlow session lock");
      // ponytail: synchronous per-session lock; use a transactional store if hook throughput grows.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lock);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function validState(value, sessionId) {
  return isRecord(value)
    && value.version === 1
    && value.sessionId === sessionId
    && typeof value.cwd === "string"
    && (value.workflowId === undefined || typeof value.workflowId === "string")
    && typeof value.active === "boolean"
    && typeof value.changed === "boolean"
    && typeof value.tddViolation === "boolean"
    && (value.reworkCycles === undefined || Number.isInteger(value.reworkCycles))
    && (value.valueWarningIssued === undefined || typeof value.valueWarningIssued === "boolean")
    && ["unclassified", ...TIERS].includes(value.tier)
    && ["unclassified", ...TDD_MODES].includes(value.tdd)
    && ["unclassified", ...REVIEW_MODES].includes(value.reviewMode)
    && (value.lastFingerprint === null || typeof value.lastFingerprint === "string")
    && (value.violationBaseFingerprint === null || typeof value.violationBaseFingerprint === "string")
    && (value.red === null || validEvidence(value.red))
    && (value.redObserved === undefined || value.redObserved === null || validEvidence(value.redObserved))
    && (value.validation === null || validEvidence(value.validation))
    && Array.isArray(value.reviewAssignments)
    && value.reviewAssignments.every(validReviewAssignment)
    && Array.isArray(value.reviewPasses)
    && value.reviewPasses.every(validReviewPass)
    && (value.reviewFailure === null || (isRecord(value.reviewFailure) && typeof value.reviewFailure.lane === "string"))
    && (value.approval === null || validApproval(value.approval))
    && (value.override === null || validOverride(value.override))
    && (value.skip === undefined || value.skip === null || validEvidence(value.skip));
}

function validEvidence(value) {
  return isRecord(value)
    && typeof value.details === "string"
    && (value.fingerprint === null || typeof value.fingerprint === "string")
    && typeof value.at === "string";
}

function validReviewAssignment(value) {
  return isRecord(value)
    && typeof value.lane === "string"
    && typeof value.token === "string"
    && typeof value.fingerprint === "string"
    && typeof value.at === "string";
}

function validReviewPass(value) {
  return isRecord(value)
    && typeof value.agentId === "string"
    && typeof value.lane === "string"
    && typeof value.fingerprint === "string"
    && typeof value.at === "string";
}

function validApproval(value) {
  return isRecord(value)
    && typeof value.fingerprint === "string"
    && typeof value.source === "string"
    && typeof value.evidence === "string"
    && typeof value.at === "string";
}

function validOverride(value) {
  return isRecord(value)
    && typeof value.reason === "string"
    && typeof value.fingerprint === "string"
    && typeof value.consumed === "boolean"
    && typeof value.at === "string";
}

function statePath(dataDir, sessionId) {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(dataDir, "sessions", `${key}.json`);
}

function worktreeStatePath(dataDir, sessionId, cwd) {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  const workspaceKey = createHash("sha256").update(canonicalWorkspacePath(cwd)).digest("hex");
  return path.join(dataDir, "sessions", sessionKey, `${workspaceKey}.json`);
}

function loadSessionStates(dataDir, sessionId) {
  const states = [];
  const primary = loadStateFile(statePath(dataDir, sessionId), sessionId);
  if (primary !== null) states.push(primary);
  const directory = path.join(dataDir, "sessions", createHash("sha256").update(sessionId).digest("hex"));
  if (!existsSync(directory)) return states;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const state = loadStateFile(path.join(directory, entry.name), sessionId);
    if (state !== null) states.push(state);
  }
  return states;
}

function relatedState(dataDir, sessionId, cwd) {
  const primary = loadState(dataDir, sessionId);
  if (primary !== null) {
    if (sameWorkspace(primary.cwd, cwd)) return null;
    if (sameRepository(primary.cwd, cwd)) return primary;
  }
  return relatedStates(dataDir, sessionId, cwd)[0] ?? null;
}

function relatedStates(dataDir, sessionId, cwd) {
  return loadSessionStates(dataDir, sessionId)
    .filter((state) => !sameWorkspace(state.cwd, cwd) && sameRepository(state.cwd, cwd));
}

function newerWorkflow(source, target) {
  const sourceId = source?.workflowId ?? source?.promptHash;
  const targetId = target?.workflowId ?? target?.promptHash;
  return source !== null
    && target !== null
    && typeof sourceId === "string"
    && sourceId !== targetId;
}

function editedPaths(toolInput) {
  const direct = isRecord(toolInput)
    ? [toolInput.path, toolInput.file_path, toolInput.filePath].filter((value) => typeof value === "string")
    : [];
  const patch = typeof toolInput === "string"
    ? toolInput
    : isRecord(toolInput) && typeof toolInput.patch === "string"
      ? toolInput.patch
      : commandFrom(toolInput);
  if (patch === null) return direct;
  const paths = [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:)\s*(.+)$/gm)].map((match) => match[1].trim());
  return [...new Set([...direct, ...paths])];
}

function hookWorkspace(input) {
  const base = input.cwd;
  const workdirs = new Set(workdirsFrom(input.tool_input).map((workdir) => {
    const resolved = path.resolve(base, workdir);
    return gitWorktreeRoot(resolved) ?? canonicalPath(resolved);
  }));
  if (!isEditTool(input.tool_name) && workdirs.size > 1) {
    return { cwd: base, error: "one command tool cannot span multiple worktrees", unmanaged: false };
  }
  if (!isEditTool(input.tool_name) && workdirs.size === 1) {
    return { cwd: workdirs.values().next().value, error: null, unmanaged: false };
  }
  if (!isEditTool(input.tool_name)) return { cwd: base, error: null, unmanaged: false };
  const baseRoot = gitWorktreeRoot(base);
  if (baseRoot === null) return { cwd: base, error: null, unmanaged: false };
  const paths = editedPaths(input.tool_input);
  const resolvedRoots = paths.map((file) => gitWorktreeRoot(path.resolve(base, file)));
  const roots = new Set(resolvedRoots.filter((root) => root !== null));
  if (roots.size > 1) return { cwd: base, error: "one edit cannot span multiple Git worktrees", unmanaged: false };
  if (roots.size > 0 && resolvedRoots.includes(null)) {
    return { cwd: base, error: "one edit cannot span managed and external paths", unmanaged: false };
  }
  if (paths.length > 0 && roots.size === 0) return { cwd: base, error: null, unmanaged: true };
  return { cwd: roots.values().next().value ?? baseRoot ?? base, error: null, unmanaged: false };
}

function isTestPath(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(normalized);
}

function isTestCommand(command, response) {
  if (/&&|\|\||[|;&\n]/.test(command)) return false;
  const segments = shellSegments(command);
  if (segments.length !== 1) return false;
  const segment = segments[0].trim();
  if (TEST_COMMAND.test(segment)) return true;
  const [wrapper, ...rest] = segment.split(/\s+/);
  return rest.length > 0
    && !NON_EXECUTING_COMMANDS.test(wrapper)
    && TEST_COMMAND.test(rest.join(" "))
    && TEST_OUTPUT.test(toolResponseText(response));
}

function toolResponseText(response) {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(toolResponseText).join("\n");
  if (!isRecord(response)) return "";
  return [response.text, response.output, response.stdout, response.stderr, response.content]
    .map(toolResponseText)
    .filter(Boolean)
    .join("\n");
}

function testOutputFailed(response) {
  return /(?:^|\n)(?:not ok \d+\s+-|FAILED \([^\n)]*failures=[1-9]\d*|=+ .* [1-9]\d* failed|test result: FAILED|Tests:\s+.*[1-9]\d* failed|Tests run:.*Failures:\s*[1-9]\d*)/im.test(toolResponseText(response));
}

function shellSegments(command) {
  return command.split(/&&|\|\||[|;&\n]/).map((segment) => segment.trim()).filter(Boolean);
}

function isDryRunSegment(segment) {
  if (segment.includes("$(") || segment.includes("`") || segment.includes("<(") || segment.includes(">(") || segment.includes("=(")) return false;
  if (/(?:^|\s)--dry-run(?:=true)?(?:\s|$)/i.test(segment)) return true;
  return /\bkubectl\b/i.test(segment) && /(?:^|\s)--dry-run=(?:client|server)(?:\s|$)/i.test(segment);
}

function commandMentionsTestPath(command) {
  return command.split(/\s+/).some((token) => isTestPath(token.replace(/^["']+|["',:]+$/g, "")));
}

function commandMentionsProductionPath(command) {
  return command.split(/\s+/).some((token) => {
    const value = token.replace(/^["']+|["',:]+$/g, "");
    if (isTestPath(value)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:s|y|tr)\W/.test(value)) return false;
    if (/^\s*sed\b/i.test(command) && /^\/.*\/[a-z]*$/i.test(value)) return false;
    return value.includes("/")
      || /^\.[a-z0-9_-]+$/i.test(value)
      || /(?:^|\/)(?:Dockerfile|Makefile|Justfile|Procfile)$/i.test(value)
      || /(?:^|\/)[^/]+\.[a-z0-9][a-z0-9._-]*$/i.test(value);
  });
}

function isEditTool(toolName) {
  return /(?:^|__|\.)(?:apply_patch|edit|write)$/i.test(toolName);
}

function isCommandTool(toolName) {
  return /(?:^|__|\.)(?:bash|exec|exec_command)$/i.test(toolName);
}

function commandFrom(toolInput) {
  if (typeof toolInput === "string") {
    const nested = nestedExecInputs(toolInput);
    return nested.length === 0 ? toolInput : nested.map((input) => input.cmd).join("\n");
  }
  if (!isRecord(toolInput)) return null;
  for (const key of ["command", "cmd"]) {
    if (typeof toolInput[key] === "string") return toolInput[key];
  }
  return null;
}

function workdirsFrom(toolInput) {
  if (isRecord(toolInput) && typeof toolInput.workdir === "string") return [toolInput.workdir];
  return typeof toolInput === "string"
    ? nestedExecInputs(toolInput).map((input) => input.workdir ?? ".")
    : [];
}

function nestedExecInputs(source) {
  const marker = "tools.exec_command(";
  const starts = [];
  for (let start = source.indexOf(marker); start !== -1; start = source.indexOf(marker, start + marker.length)) {
    starts.push(start);
  }
  const property = (name, call) => {
    const match = new RegExp(`(?:^|[,{])\\s*(?:"${name}"|${name})\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(call);
    if (match === null) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  };
  return starts.flatMap((start, index) => {
    const call = source.slice(start, starts[index + 1] ?? source.length);
    const cmd = property("cmd", call);
    return cmd === null ? [] : [{ cmd, workdir: property("workdir", call) }];
  });
}

function toolFailed(response) {
  if (typeof response === "string") {
    if (/^Success\b/i.test(response) || /\b0\s+failed\b/i.test(response)) return false;
    const exit = /(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exit_code)\D*(-?\d+)/i.exec(response);
    if (exit !== null) return Number(exit[1]) !== 0;
    return /\b[1-9]\d*\s+failed\b|\b(?:error|failure)\b/i.test(response);
  }
  if (!isRecord(response)) return false;
  if (typeof response.exit_code === "number") return response.exit_code !== 0;
  return response.is_error === true || response.isError === true || response.error !== undefined;
}

function loadProjectConfig(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const file = path.join(root.ok ? root.stdout.trim() : cwd, ".voltflow.json");
  if (!existsSync(file)) return { deployPatterns: [], deployTools: [], fingerprintPaths: [], error: null };
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error("root must be an object");
    return {
      deployPatterns: compilePatterns(value.deployPatterns, "deployPatterns"),
      deployTools: compilePatterns(value.deployTools, "deployTools"),
      fingerprintPaths: compilePaths(value.fingerprintPaths, root.ok ? root.stdout.trim() : cwd),
      error: null,
    };
  } catch (error) {
    return {
      deployPatterns: [],
      deployTools: [],
      fingerprintPaths: [],
      error: `.voltflow.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function compilePatterns(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of regex strings`);
  }
  return value.map((entry) => new RegExp(entry, "i"));
}

function compilePaths(value, root) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error("fingerprintPaths must be an array of relative file paths");
  }
  for (const entry of value) {
    const resolved = path.resolve(root, entry);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("fingerprintPaths entries must stay inside the Git worktree");
    }
  }
  return [...new Set(value)].sort();
}

function hashWorkspacePath(hash, root, relativePath, allowMissing = false) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
  hashField(hash, "path", relativePath);
  if (!existsSync(resolved)) {
    if (!allowMissing) return false;
    hashField(hash, "state", "missing");
    return true;
  }
  const stats = lstatSync(resolved);
  if (stats.isDirectory()) return false;
  const object = git(root, ["hash-object", "--no-filters", "--", relativePath]);
  if (!object.ok) return false;
  hashField(hash, "mode", String(stats.mode));
  hashField(hash, "object", object.stdout);
  return true;
}

function hashField(hash, label, value) {
  const bytes = Buffer.from(String(value));
  hash.update(`${label.length}:${label}:${bytes.length}:`);
  hash.update(bytes);
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: result.stdout ?? "",
  };
}

function parseArguments(argv) {
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { command: argv[0], flags };
}

function userContext(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  };
}

function approval(fingerprint, source, details) {
  return { fingerprint, source, evidence: details, at: timestamp() };
}

function evidence(details, fingerprint) {
  return { details, fingerprint, at: timestamp() };
}

function historicalRed(state) {
  return state.redObserved ?? state.red;
}

function controllerPrefix(context, sessionId) {
  const script = path.join(context.pluginRoot, "scripts", "voltflow.mjs");
  return `node ${quote(script)} <command> --data-dir ${quote(context.dataDir)} --session ${quote(sessionId)}`;
}

function quote(value) {
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function textFlag(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp() {
  return new Date().toISOString();
}

function validClassification(state) {
  return TIERS.has(state.tier)
    && TDD_MODES.has(state.tdd)
    && REVIEW_MODES.has(state.reviewMode)
    && REVIEW_RANK[state.reviewMode] >= REVIEW_RANK[REQUIRED_REVIEW[state.tier]];
}

function sameWorkspace(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && canonicalWorkspacePath(left) === canonicalWorkspacePath(right);
}

function canonicalWorkspacePath(value) {
  return gitWorktreeRoot(value) ?? canonicalPath(value);
}

function sameRepository(left, right) {
  const leftCommon = gitCommonDirectory(left);
  const rightCommon = gitCommonDirectory(right);
  return leftCommon !== null && leftCommon === rightCommon;
}

function gitWorktreeRoot(value) {
  const result = gitMetadata(value, ["rev-parse", "--show-toplevel"]);
  return result.ok ? canonicalPath(result.stdout.trim()) : null;
}

function gitCommonDirectory(value) {
  const result = gitMetadata(value, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return result.ok ? canonicalPath(result.stdout.trim()) : null;
}

function gitMetadata(value, args) {
  let current = path.resolve(value);
  while (true) {
    if (existsSync(current)) {
      try {
        if (statSync(current).isDirectory()) {
          const result = git(current, args);
          if (result.ok) return result;
        }
      } catch {
        // Continue through lexical parents when a path cannot be resolved.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return git(nearestExistingDirectory(value), args);
}

function nearestExistingDirectory(value) {
  let current = path.resolve(value);
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  const canonical = canonicalPath(current);
  return statSync(canonical).isDirectory() ? canonical : path.dirname(canonical);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function recoverRevertedViolation(state, currentFingerprint) {
  if (state.tddViolation === true
    && typeof state.violationBaseFingerprint === "string"
    && currentFingerprint === state.violationBaseFingerprint) {
    state.tddViolation = false;
    state.violationBaseFingerprint = null;
    return true;
  }
  return false;
}

function invalidateForChange(state) {
  state.changed = true;
  state.validation = null;
  state.reviewAssignments = [];
  state.reviewPasses = [];
  state.reviewFailure = null;
  state.approval = null;
  state.override = null;
  state.stopBlocks = 0;
}

function success(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr) {
  return { exitCode: 1, stdout: "", stderr };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  if (process.argv[2] === "hook") {
    const raw = await readStdin();
    if (raw.trim().length === 0) return;
    const input = JSON.parse(raw);
    const output = handleHook(input);
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  const result = runController(process.argv.slice(2));
  if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

const entry = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`VoltFlow failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
