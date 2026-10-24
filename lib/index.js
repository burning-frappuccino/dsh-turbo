// dsh-turbo 0.2.2 — Host half (generated from src/ by scripts/build.mjs)

// src/host/plugin.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/shared/policies.ts
var TURBO_POLICY = Object.freeze({
  minimalPlanning: true,
  preferSinglePass: true,
  skipOptionalReview: true,
  skipOptionalTests: true,
  preferLowLatency: true,
  preferAggressiveParallelism: false,
  preserveMandatoryChecks: true
});
var TURBO_MAX_POLICY = Object.freeze({
  ...TURBO_POLICY,
  preferAggressiveParallelism: true
});
var DEFAULT_POLICY = Object.freeze({
  minimalPlanning: false,
  preferSinglePass: false,
  skipOptionalReview: false,
  skipOptionalTests: false,
  preferLowLatency: false,
  preferAggressiveParallelism: false,
  preserveMandatoryChecks: true
});
function policyFor(mode, gear = "fast") {
  if (mode !== "turbo") return DEFAULT_POLICY;
  return gear === "max" ? TURBO_MAX_POLICY : TURBO_POLICY;
}
function isTurbo(mode) {
  return mode === "turbo";
}

// src/version.ts
var PLUGIN_VERSION = "0.2.2";
var PLUGIN_NAME = "dsh-turbo";

// src/host/evidence.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
var EvidenceLog = class {
  #path;
  #maxBytes;
  #now;
  #onError;
  #bytes = 0;
  constructor(options = {}) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {
    });
    if (this.#path !== void 0) {
      try {
        this.#bytes = statSync(this.#path).size;
      } catch {
        this.#bytes = 0;
      }
    }
  }
  get enabled() {
    return this.#path !== void 0;
  }
  get path() {
    return this.#path;
  }
  /** Append one record. Never throws into the caller's hook. */
  write(record) {
    if (this.#path === void 0) return;
    const line = `${JSON.stringify({ ts: this.#now(), ...record })}
`;
    try {
      if (this.#bytes + line.length > this.#maxBytes) this.#rotate();
      mkdirSync(dirname(this.#path), { recursive: true });
      appendFileSync(this.#path, line, "utf8");
      this.#bytes += Buffer.byteLength(line);
    } catch (error) {
      this.#onError(error);
    }
  }
  #rotate() {
    if (this.#path === void 0) return;
    try {
      renameSync(this.#path, `${this.#path}.1`);
    } catch {
    }
    this.#bytes = 0;
  }
};

// src/host/json-file.ts
import { mkdirSync as mkdirSync2, readFileSync, renameSync as renameSync2, writeFileSync, existsSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
var JsonFile = class {
  #path;
  #debounceMs;
  #onError;
  #timer;
  #pending;
  constructor(path, options = {}) {
    this.#path = path;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#onError = options.onError ?? (() => {
    });
  }
  get path() {
    return this.#path;
  }
  /** Read the document, or `undefined` when it is absent or unreadable. */
  load() {
    try {
      if (!existsSync(this.#path)) return void 0;
      const raw = readFileSync(this.#path, "utf8");
      if (raw.trim() === "") return void 0;
      return JSON.parse(raw);
    } catch (error) {
      try {
        renameSync2(this.#path, `${this.#path}.corrupt-${Date.now()}`);
      } catch {
      }
      this.#onError(error);
      return void 0;
    }
  }
  /** Queue a write; the newest value wins. */
  save(value) {
    this.#pending = value;
    if (this.#timer !== void 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = void 0;
      const next = this.#pending;
      this.#pending = void 0;
      if (next !== void 0) this.#write(next);
    }, this.#debounceMs);
    this.#timer.unref?.();
  }
  /** Write the pending value immediately. */
  flush() {
    if (this.#timer !== void 0) {
      clearTimeout(this.#timer);
      this.#timer = void 0;
    }
    const next = this.#pending;
    this.#pending = void 0;
    if (next !== void 0) this.#write(next);
  }
  #write(value) {
    const tmp = join(dirname2(this.#path), `.${process.pid}-${Date.now()}.tmp`);
    try {
      mkdirSync2(dirname2(this.#path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
      renameSync2(tmp, this.#path);
    } catch (error) {
      this.#onError(error);
    }
  }
};

// src/host/metrics.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["pwsh", "bash", "ops_bash", "shell", "job_start", "terminal"]);
var VERIFICATION_COMMAND = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|lint|typecheck|build)\b|\b(?:python(?:3(?:\.\d+)?)?|py(?:\s+-\d+(?:\.\d+)?)?)\s+-m\s+unittest\b|\b(?:vitest|jest|pytest|mocha|ava|ctest|cargo\s+test|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|tsc\b|node\s+--test)/i;
var TurboMetrics = class {
  #turns = /* @__PURE__ */ new Map();
  #live = /* @__PURE__ */ new Map();
  #file;
  #turnsPerSession;
  #maxSessions;
  #now;
  constructor(options = {}) {
    this.#turnsPerSession = options.turnsPerSession ?? 40;
    this.#maxSessions = options.maxSessions ?? 500;
    this.#now = options.now ?? Date.now;
    this.#file = options.path === void 0 ? void 0 : new JsonFile(options.path, {
      onError: options.onError
    });
    const loaded = this.#file?.load();
    if (loaded !== void 0 && loaded.version === 1 && typeof loaded.sessions === "object" && loaded.sessions !== null) {
      for (const [sessionId, records] of Object.entries(loaded.sessions)) {
        if (!Array.isArray(records)) continue;
        const clean = records.filter(isTurnRecord).slice(-this.#turnsPerSession);
        if (clean.length > 0) this.#turns.set(sessionId, clean);
      }
    }
  }
  /** Open a turn; ignores repeats for a turn already in flight. */
  beginTurn(sessionId, turn, mode) {
    const existing = this.#live.get(sessionId);
    if (existing !== void 0 && existing.turn === turn) return;
    this.#live.set(sessionId, { turn, mode, startedAt: this.#now(), steps: 0, toolCalls: 0, verification: false });
  }
  /** Count one model step for the live turn. */
  countStep(sessionId, turn) {
    const live = this.#live.get(sessionId);
    if (live === void 0 || live.turn !== turn) return;
    live.steps += 1;
  }
  /** Count one tool call and note whether it looks like verification. */
  countToolCall(sessionId, turn, toolName, rawArguments) {
    const live = this.#live.get(sessionId);
    if (live === void 0 || live.turn !== turn) return;
    live.toolCalls += 1;
    if (!live.verification && SHELL_TOOLS.has(toolName)) {
      live.verification = looksLikeVerification(rawArguments);
    }
  }
  /** Close the live turn and retain its record. */
  endTurn(sessionId, turn) {
    const live = this.#live.get(sessionId);
    if (live === void 0 || live.turn !== turn) return void 0;
    this.#live.delete(sessionId);
    const record = {
      turn,
      mode: live.mode,
      startedAt: live.startedAt,
      endedAt: this.#now(),
      steps: live.steps,
      toolCalls: live.toolCalls,
      verification: live.verification
    };
    const records = [...this.#turns.get(sessionId) ?? [], record].slice(-this.#turnsPerSession);
    this.#turns.set(sessionId, records);
    if (this.#turns.size > this.#maxSessions) {
      const oldest = [...this.#turns.entries()].sort((a, b) => lastEnd(a[1]) - lastEnd(b[1]));
      for (const [id] of oldest.slice(0, this.#turns.size - this.#maxSessions)) this.#turns.delete(id);
    }
    this.#persist();
    return record;
  }
  /** Read the client-facing summary for one Session. */
  summary(sessionId) {
    const records = this.#turns.get(sessionId) ?? [];
    if (records.length === 0) {
      return {
        turns: 0,
        avgLatencyMs: null,
        lastLatencyMs: null,
        lastSteps: null,
        lastToolCalls: null,
        lastVerification: null,
        lastMode: null
      };
    }
    const last = records[records.length - 1];
    const durations = records.map((record) => record.endedAt - record.startedAt);
    const total = durations.reduce((sum, value) => sum + value, 0);
    return {
      turns: records.length,
      avgLatencyMs: Math.round(total / durations.length),
      lastLatencyMs: durations[durations.length - 1],
      lastSteps: last.steps,
      lastToolCalls: last.toolCalls,
      lastVerification: last.verification,
      lastMode: last.mode
    };
  }
  /** All retained records for one Session (benchmark + diagnostics). */
  records(sessionId) {
    return this.#turns.get(sessionId) ?? [];
  }
  /** Flush pending writes (teardown path). */
  flush() {
    this.#file?.flush();
  }
  #persist() {
    if (this.#file === void 0) return;
    const sessions = {};
    for (const [sessionId, records] of this.#turns) sessions[sessionId] = records.map((record) => ({ ...record }));
    this.#file.save({ version: 1, sessions });
  }
};
function looksLikeVerification(rawArguments) {
  const command = commandOf(rawArguments);
  if (command === void 0) return false;
  return VERIFICATION_COMMAND.test(command);
}
function commandOf(rawArguments) {
  let value = rawArguments;
  if (typeof value === "string") {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof value !== "object" || value === null) return void 0;
  const record = value;
  for (const key of ["command", "cmd", "script", "line"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate.filter((part) => typeof part === "string").join(" ");
      if (joined !== "") return joined;
    }
  }
  return void 0;
}
function isTurnRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return typeof record.turn === "number" && (record.mode === "turbo" || record.mode === "default") && typeof record.startedAt === "number" && typeof record.endedAt === "number" && typeof record.steps === "number" && typeof record.toolCalls === "number" && typeof record.verification === "boolean";
}
function lastEnd(records) {
  return records.length === 0 ? 0 : records[records.length - 1].endedAt;
}

// src/host/session-store.ts
var DEFAULT_RECORD = Object.freeze({ mode: "default", gear: "fast", revision: 0, updatedAt: 0 });
function parseMode(value) {
  return value === "turbo" || value === "default" ? value : void 0;
}
function parseGear(value) {
  return value === "fast" || value === "max" ? value : void 0;
}
function isSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
}
var TurboSessionStore = class {
  #entries = /* @__PURE__ */ new Map();
  #file;
  #defaultMode;
  #defaultGear;
  #ttlMs;
  #maxSessions;
  #now;
  #listeners = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.#ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1e3;
    this.#maxSessions = options.maxSessions ?? 2e3;
    this.#now = options.now ?? Date.now;
    this.#defaultMode = options.defaultMode ?? DEFAULT_RECORD.mode;
    this.#defaultGear = options.defaultGear ?? DEFAULT_RECORD.gear;
    this.#file = options.path === void 0 ? void 0 : new JsonFile(options.path, {
      onError: options.onError
    });
    const loaded = this.#file?.load();
    if (loaded !== void 0 && (loaded.version === 1 || loaded.version === 2) && typeof loaded.sessions === "object" && loaded.sessions !== null) {
      for (const [sessionId, record] of Object.entries(loaded.sessions)) {
        if (!isSessionId(sessionId)) continue;
        const mode = parseMode(record?.mode);
        if (mode === void 0) continue;
        const gear = loaded.version === 2 ? parseGear(record.gear) ?? "fast" : "fast";
        const revision = Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 0;
        const updatedAt = Number.isFinite(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt : 0;
        this.#entries.set(sessionId, { mode, gear, revision, updatedAt });
      }
    }
  }
  /** Number of Sessions with an explicitly written record. */
  get size() {
    return this.#entries.size;
  }
  /** Read one authoritative record; absent Sessions read as the configured default. */
  get(sessionId) {
    const record = this.#entries.get(sessionId);
    if (record === void 0) {
      return {
        sessionId,
        mode: this.#defaultMode,
        gear: this.#defaultGear,
        revision: 0,
        updatedAt: 0
      };
    }
    return {
      sessionId,
      mode: record.mode,
      gear: record.gear,
      revision: record.revision,
      updatedAt: record.updatedAt
    };
  }
  /**
   * Apply a mode change.
   *
   * @param sessionId - validated Session id.
   * @param mode - requested mode.
   * @param expectedRevision - the revision the caller observed, or undefined
   *   for an unconditional write.
   */
  set(sessionId, mode, expectedRevision, gear) {
    const current = this.get(sessionId);
    if (expectedRevision !== void 0 && expectedRevision !== current.revision) {
      return { changed: false, state: current, conflict: true };
    }
    const nextGear = gear ?? current.gear;
    if (current.mode === mode && current.gear === nextGear) {
      return { changed: false, state: current };
    }
    const next = {
      mode,
      gear: nextGear,
      revision: current.revision + 1,
      updatedAt: this.#now()
    };
    this.#entries.set(sessionId, next);
    this.#persist();
    const state = { sessionId, ...next };
    this.#emit(state, "set");
    return { changed: true, state };
  }
  /** Subscribe to accepted writes; returns the unsubscribe function. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  /** Drop expired records; returns how many were removed. */
  prune() {
    const cutoff = this.#now() - this.#ttlMs;
    let removed = 0;
    for (const [sessionId, record] of this.#entries) {
      if (record.updatedAt < cutoff) {
        this.#entries.delete(sessionId);
        removed += 1;
      }
    }
    if (this.#entries.size > this.#maxSessions) {
      const oldest = [...this.#entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [sessionId] of oldest.slice(0, this.#entries.size - this.#maxSessions)) {
        this.#entries.delete(sessionId);
        removed += 1;
      }
    }
    if (removed > 0) this.#persist();
    return removed;
  }
  /** Flush pending writes (teardown path). */
  flush() {
    this.#file?.flush();
  }
  #persist() {
    if (this.#file === void 0) return;
    const sessions = {};
    for (const [sessionId, record] of this.#entries) sessions[sessionId] = { ...record };
    this.#file.save({ version: 2, sessions });
  }
  #emit(state, cause) {
    for (const listener of this.#listeners) {
      try {
        listener(state, cause);
      } catch {
      }
    }
  }
};

// src/prompts/turbo-policy.ts
var TURBO_SECTION_NAME = "turbo:execution-policy";
var TURBO_POLICY_MARKER = "TURBO EXECUTION MODE";
function renderTurboPolicy(gear = "fast") {
  const base = [
    TURBO_POLICY_MARKER,
    "",
    "Optimize for minimum wall-clock completion time.",
    "",
    "Plan briefly, then execute as soon as the necessary context is in hand. Do not re-derive facts you already have, do not re-read the same file, and do not compare equivalent options.",
    "",
    "Keep planning compact. Put implementation into tool calls instead of drafting it at length before acting.",
    "",
    "Prefer one complete implementation pass over incremental rewriting. Use parallel tool calls when the operations are independent; keep dependent steps in dependency order.",
    "",
    "Do not open optional review, reflection, or re-verification stages. Do not start full suites, builds, formatters, or linters that the user did not ask for and that the acceptance criteria do not require.",
    "",
    "Before you call a code change finished, run the single cheapest command that would catch a wrong result \u2014 one test file, one typecheck, or one script that exercises the change. That check is part of finishing the task, not an optional stage.",
    "",
    "Tool failures that block completion still get the minimal repair they need: a retry or a fix is part of finishing the task, not an optional stage.",
    "",
    "Deliver the result as soon as it is complete. End the reply with one line stating what you actually ran: `Verified: <the command or check>` or `Verified: none`. Never describe code as tested when no test ran.",
    "",
    "Mandatory permissions, approvals, sandbox rules, and checks are never skipped for speed."
  ];
  if (gear === "max") {
    base.splice(
      4,
      0,
      "MAX GEAR: lower wall-clock latency is worth extra token and tool budget.",
      "",
      "Gather all likely-needed context up front. Launch every independent read, search, tool call, and available subagent in the same turn instead of serially. Parallel duplicate exploration is allowed only when the result can be checked cheaply; never duplicate a mutating or non-idempotent action.",
      "",
      "Keep dependent operations ordered. Use the extra breadth to finish sooner, not to add prose or ceremonial review.",
      ""
    );
  }
  return base.join("\n");
}

// src/host/runtime-adapter.ts
var RuntimeAdapter = class {
  #ctx;
  #store;
  #metrics;
  #evidence;
  #config;
  #bridgeAvailable;
  #caps = {
    promptSection: false,
    preStepHook: false,
    sessionMetrics: false,
    reasoningEffort: false,
    effortUnavailable: false,
    observedEffort: void 0
  };
  /** Agent-scoped request hooks owned by this adapter, keyed for de-duplication. */
  #effortHooks = /* @__PURE__ */ new Map();
  /** One warning per process when another listener wins the effort field. */
  #effortMismatchReported = false;
  constructor(options) {
    this.#ctx = options.ctx;
    this.#store = options.store;
    this.#metrics = options.metrics;
    this.#evidence = options.evidence;
    this.#config = options.config;
    this.#bridgeAvailable = options.bridgeAvailable ?? (() => false);
  }
  /** Register every hook; returns one disposer that withdraws all of them. */
  attach() {
    const disposers = [];
    if (typeof this.#ctx.inject === "function") {
      disposers.push(this.#ctx.inject(["systemPrompt"], (sctx) => {
        const systemPrompt = sctx.systemPrompt;
        if (systemPrompt === void 0) return;
        const section = {
          name: TURBO_SECTION_NAME,
          order: this.#config.sectionOrder,
          text: (context) => this.#promptFor(context?.agent)
        };
        const dispose = systemPrompt.section(section);
        this.#caps.promptSection = true;
        return () => {
          this.#caps.promptSection = false;
          dispose();
        };
      }));
    }
    disposers.push(this.#ctx.on("agent/pre-step", (async (payload, next) => {
      const decision = await next();
      try {
        this.#onPreStep(payload, decision);
      } catch (error) {
        this.#ctx.logger?.warn("dsh-turbo: pre-step bookkeeping failed: %o", error);
      }
      return decision;
    })));
    disposers.push(this.#ctx.on("session/event", ((session, event) => {
      try {
        this.#onSessionEvent(session, event);
      } catch (error) {
        this.#ctx.logger?.warn("dsh-turbo: session metrics bookkeeping failed: %o", error);
      }
    })));
    this.#caps.sessionMetrics = true;
    if (this.#config.reasoningEffort !== "inherit" || this.#config.maxReasoningEffort !== "inherit") {
      const attach = (agent) => {
        try {
          this.#attachEffort(agent);
        } catch (error) {
          this.#ctx.logger?.warn("dsh-turbo: reasoning-effort hook failed: %o", error);
        }
      };
      disposers.push(this.#ctx.on("agent/created", ((payload) => {
        attach(payload?.agent);
      })));
      if (typeof this.#ctx.inject === "function") {
        disposers.push(this.#ctx.inject(["agents"], (serviceCtx) => {
          const list = serviceCtx.agents?.list;
          if (typeof list !== "function") return;
          try {
            for (const agent of list.call(serviceCtx.agents)) attach(agent);
          } catch (error) {
            this.#ctx.logger?.warn("dsh-turbo: existing-agent scan failed: %o", error);
          }
        }));
      }
    }
    disposers.push(this.#ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.#store.prune();
        } catch {
        }
      }, 10 * 60 * 1e3);
      timer.unref?.();
      return () => clearInterval(timer);
    }, "dsh-turbo: state pruning"));
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
        }
      }
      for (const dispose of [...this.#effortHooks.values()]) {
        try {
          dispose();
        } catch {
        }
      }
      this.#effortHooks.clear();
      this.#caps.reasoningEffort = false;
      this.#caps.observedEffort = void 0;
    };
  }
  /** What is really in effect, in the exact words the client shows. */
  capabilities() {
    const fastEffort = this.#config.reasoningEffort;
    const maxEffort = this.#config.maxReasoningEffort;
    const effortEnabled = fastEffort !== "inherit" || maxEffort !== "inherit";
    return [
      {
        id: "prompt-policy",
        state: this.#caps.promptSection ? "applied" : "unavailable",
        detail: this.#caps.promptSection ? `Ordered prompt section "${TURBO_SECTION_NAME}" renders only for Turbo Sessions.` : "The host has no systemPrompt service, so no prompt policy can be added."
      },
      {
        id: "pre-step-policy",
        state: this.#caps.preStepHook ? "applied" : "unavailable",
        detail: this.#caps.preStepHook ? "agent/pre-step stamps every step with the effective mode and records evidence." : "agent/pre-step is unavailable in this composition; nothing is enforced per step."
      },
      {
        id: "turn-metrics",
        state: this.#caps.sessionMetrics ? "applied" : "unavailable",
        detail: "Turn latency, step count and tool calls are read from session events."
      },
      {
        id: "http-bridge",
        state: this.#bridgeAvailable() ? "applied" : "unavailable",
        detail: this.#bridgeAvailable() ? "GET/POST /api/dsh-turbo/state serves the authoritative session mode." : "This profile has no webServer, so only the execution policy applies (headless/SDK surfaces)."
      },
      {
        id: "reasoning-effort",
        state: !effortEnabled ? "off" : this.#caps.reasoningEffort ? "applied" : "off",
        detail: !effortEnabled ? "Model route untouched (both gear efforts inherit the selected route)." : this.#caps.reasoningEffort ? `Turbo requests carried the selected gear effort (Fast: "${fastEffort}", Max: "${maxEffort}") in request/header.` : this.#caps.effortError !== void 0 ? `The route refused a selected gear effort (${this.#caps.effortError}); Turbo kept the turn alive and left the route untouched.` : this.#caps.effortUnavailable ? `Configured for Fast "${fastEffort}" / Max "${maxEffort}", but no Agent context was reachable.` : this.#caps.observedEffort !== void 0 ? `The selected gear effort did not reach the route; it resolved "${this.#caps.observedEffort}" instead.` : `Configured for Fast "${fastEffort}" / Max "${maxEffort}"; no Turbo request has been observed yet.`
      },
      {
        id: "optional-stages",
        state: "unavailable",
        detail: "This composition mounts no automatic review/test stage, so Turbo cannot skip one \u2014 the model owns that choice, which is why the prompt policy states it."
      },
      {
        id: "tool-filtering",
        state: "off",
        detail: "No tool is blocked by name or argument: killing commands that mention test/build breaks real tasks."
      },
      {
        id: "mandatory-checks",
        state: "applied",
        detail: "Permissions, approvals, sandbox limits and required checks are never modified."
      }
    ];
  }
  /** Effective mode for one Session (single source of truth). */
  modeOf(sessionId) {
    return sessionId === void 0 ? "default" : this.#store.get(sessionId).mode;
  }
  // ── internals ─────────────────────────────────────────────────────────────
  /** Render the section text for one agent (empty string = contribute nothing). */
  #promptFor(agent) {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (sessionId === void 0) return "";
    const state = this.#store.get(sessionId);
    if (state.mode !== "turbo") return "";
    return renderTurboPolicy(state.gear);
  }
  #onPreStep(payload, decision) {
    const agent = payload.agent;
    const sessionId = agent?.session?.id ?? agent?.id;
    const turn = typeof payload.turn === "number" ? payload.turn : void 0;
    if (sessionId === void 0 || !isSessionId(sessionId) || turn === void 0) return;
    if (decision.kind === "reject") return;
    const state = this.#store.get(sessionId);
    this.#caps.preStepHook = true;
    this.#metrics.countStep(sessionId, turn);
    const policy = policyFor(state.mode, state.gear);
    this.#evidence.write({
      event: "pre-step",
      session: sessionId,
      turn,
      step: typeof payload.step === "number" ? payload.step : null,
      mode: state.mode,
      gear: state.gear,
      revision: state.revision,
      policy,
      promptSection: this.#caps.promptSection ? "applied" : "unavailable",
      // What the last request actually carried, not what this plugin asked for.
      reasoningEffort: this.#caps.observedEffort ?? null,
      reasoningEffortConfigured: this.#effortFor(state.gear)
    });
  }
  #onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (sessionId === void 0 || !isSessionId(sessionId)) return;
    const type = event.type;
    const data = event.data ?? {};
    if (type === "turn/start") {
      const turn = turnOf(data);
      if (turn === void 0) return;
      this.#metrics.beginTurn(sessionId, turn, this.#store.get(sessionId).mode);
      return;
    }
    if (type === "tool/call") {
      const turn = turnOf(data);
      if (turn === void 0) return;
      const name2 = typeof data.name === "string" ? data.name : "";
      this.#metrics.countToolCall(sessionId, turn, name2, data.arguments);
      return;
    }
    if (type === "request/header") {
      const header = data["header"];
      const observed = header?.config?.reasoningEffort;
      const state = this.#store.get(sessionId);
      if (state.mode !== "turbo") return;
      const expected = this.#effortFor(state.gear);
      if (expected === "inherit") return;
      const value = typeof observed === "string" ? observed : void 0;
      this.#caps.observedEffort = value;
      const matches = value === expected;
      this.#caps.reasoningEffort = matches;
      if (!matches && !this.#effortMismatchReported) {
        this.#effortMismatchReported = true;
        this.#ctx.logger?.warn(
          'dsh-turbo: reasoningEffort "%s" was configured but the request header carries "%s"; another agent/request listener owns that field',
          expected,
          value ?? "(none)"
        );
      }
      return;
    }
    if (type === "turn/end") {
      const turn = turnOf(data);
      if (turn === void 0) return;
      const record = this.#metrics.endTurn(sessionId, turn);
      if (record !== void 0) {
        this.#evidence.write({
          event: "turn-end",
          session: sessionId,
          turn,
          mode: record.mode,
          latencyMs: record.endedAt - record.startedAt,
          steps: record.steps,
          toolCalls: record.toolCalls,
          verificationObserved: record.verification
        });
      }
    }
  }
  /** Attach one agent-scoped request listener that lowers reasoning effort. */
  #attachEffort(agent) {
    const agentCtx = agent?.ctx;
    if (agent === void 0 || agentCtx === void 0) {
      this.#caps.effortUnavailable = true;
      return;
    }
    if (this.#effortHooks.has(agent.id)) return;
    const sessionId = agent.session?.id ?? agent.id;
    const disposeRequest = agentCtx.on("agent/request", (async (_payload, next) => {
      const config = await next();
      const state = this.#store.get(sessionId);
      if (state.mode !== "turbo") return config;
      const effort = this.#effortFor(state.gear);
      if (effort === "inherit") return config;
      return { ...config, reasoningEffort: effort };
    }), { prepend: true });
    const disposeError = agentCtx.on("agent/request-error", (async (payload, next) => {
      const failure = payload?.failure;
      if (failure?.code !== "UNSUPPORTED_REASONING_EFFORT") return next();
      this.#disableEffort(agent.id, failure.message ?? "the route refused the configured reasoning effort");
      return { kind: "retry" };
    }));
    this.#caps.effortUnavailable = false;
    let disposed = false;
    let detachDisposed = () => {
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      this.#effortHooks.delete(agent.id);
      try {
        disposeRequest();
      } finally {
        try {
          disposeError();
        } finally {
          detachDisposed();
        }
      }
    };
    detachDisposed = this.#ctx.on("agent/disposed", ((payload) => {
      if (payload?.agent?.id !== agent.id) return;
      cleanup();
    }));
    this.#effortHooks.set(agent.id, cleanup);
  }
  /** Withdraw the lever after the route refused it, and say so honestly. */
  #disableEffort(agentId, reason) {
    this.#caps.reasoningEffort = false;
    this.#caps.effortError = reason;
    this.#effortMismatchReported = true;
    this.#ctx.logger?.warn('dsh-turbo: reasoning effort disabled for agent "%s": %s', agentId, reason);
    this.#evidence.write({
      event: "effort-disabled",
      session: agentId,
      configured: `${this.#config.reasoningEffort}/${this.#config.maxReasoningEffort}`,
      reason
    });
    this.#effortHooks.get(agentId)?.();
  }
  /** Resolve the request-level lever for the selected Turbo gear. */
  #effortFor(gear) {
    return gear === "max" ? this.#config.maxReasoningEffort : this.#config.reasoningEffort;
  }
};
function turnOf(data) {
  const turn = data.turn;
  return typeof turn === "number" && Number.isFinite(turn) ? turn : void 0;
}

// src/host/plugin.ts
var name = PLUGIN_NAME;
var inject = [];
var ROUTE_PREFIX = "/api/dsh-turbo";
var MAX_BODY_BYTES = 16 * 1024;
var DEFAULTS = {
  sectionOrder: 700,
  // Safe default. The lever is route-specific: the shipped DeepSeek Messages
  // adapter accepts only `off | low | high | max`, so defaulting to `minimal`
  // would fail every Turbo turn with UNSUPPORTED_REASONING_EFFORT.
  reasoningEffort: "inherit",
  maxReasoningEffort: "high",
  evidenceLog: true,
  storageDir: "dsh-turbo",
  defaultMode: "default",
  defaultGear: "fast"
};
var EFFORTS = /* @__PURE__ */ new Set(["inherit", "off", "minimal", "low", "medium", "high", "max"]);
var MODES = /* @__PURE__ */ new Set(["default", "turbo"]);
function resolveConfig(raw, onUnknown) {
  if (raw === void 0 || raw === null) return DEFAULTS;
  if (typeof raw !== "object") throw new Error("dsh-turbo: config must be an object");
  const input = raw;
  const known = /* @__PURE__ */ new Set(["sectionOrder", "reasoningEffort", "maxReasoningEffort", "evidenceLog", "storageDir", "defaultMode", "defaultGear"]);
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) onUnknown?.(unknown);
  const sectionOrder = input.sectionOrder ?? DEFAULTS.sectionOrder;
  if (typeof sectionOrder !== "number" || !Number.isFinite(sectionOrder)) {
    throw new Error("dsh-turbo: config sectionOrder must be a finite number");
  }
  const reasoningEffort = input.reasoningEffort ?? DEFAULTS.reasoningEffort;
  if (typeof reasoningEffort !== "string" || !EFFORTS.has(reasoningEffort)) {
    throw new Error(`dsh-turbo: config reasoningEffort must be one of ${[...EFFORTS].join(", ")}`);
  }
  const maxReasoningEffort = input.maxReasoningEffort ?? DEFAULTS.maxReasoningEffort;
  if (typeof maxReasoningEffort !== "string" || !EFFORTS.has(maxReasoningEffort)) {
    throw new Error(`dsh-turbo: config maxReasoningEffort must be one of ${[...EFFORTS].join(", ")}`);
  }
  const evidenceLog = input.evidenceLog ?? DEFAULTS.evidenceLog;
  if (typeof evidenceLog !== "boolean") throw new Error("dsh-turbo: config evidenceLog must be a boolean");
  const storageDir = input.storageDir ?? DEFAULTS.storageDir;
  if (typeof storageDir !== "string" || !/^[A-Za-z0-9._-]+$/.test(storageDir)) {
    throw new Error("dsh-turbo: config storageDir must be a simple directory name");
  }
  const defaultMode = input.defaultMode ?? DEFAULTS.defaultMode;
  if (typeof defaultMode !== "string" || !MODES.has(defaultMode)) {
    throw new Error('dsh-turbo: config defaultMode must be "default" or "turbo"');
  }
  const defaultGear = input.defaultGear ?? DEFAULTS.defaultGear;
  const parsedDefaultGear = parseGear(defaultGear);
  if (parsedDefaultGear === void 0) {
    throw new Error('dsh-turbo: config defaultGear must be "fast" or "max"');
  }
  return {
    sectionOrder,
    reasoningEffort,
    maxReasoningEffort,
    evidenceLog,
    storageDir,
    defaultMode,
    defaultGear: parsedDefaultGear
  };
}
function dshHome() {
  const fromEnv = process.env["DSH_HOME"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join2(homedir(), ".dsh");
}
function apply(ctx, rawConfig) {
  const log = ctx.logger;
  const config = resolveConfig(rawConfig, (keys) => {
    log?.warn("dsh-turbo: ignoring unknown config key(s): %s", keys.join(", "));
  });
  const dir = join2(dshHome(), "storages", config.storageDir);
  let httpBridge = false;
  const store = new TurboSessionStore({
    path: join2(dir, "state.json"),
    defaultMode: config.defaultMode,
    defaultGear: config.defaultGear,
    onError: (error) => log?.warn("dsh-turbo: state write failed: %o", error)
  });
  const metrics = new TurboMetrics({
    path: join2(dir, "metrics.json"),
    onError: (error) => log?.warn("dsh-turbo: metrics write failed: %o", error)
  });
  const evidence = new EvidenceLog({
    path: config.evidenceLog ? join2(dir, "evidence.jsonl") : void 0,
    onError: (error) => log?.warn("dsh-turbo: evidence write failed: %o", error)
  });
  const adapter = new RuntimeAdapter({
    ctx,
    store,
    metrics,
    evidence,
    config,
    bridgeAvailable: () => httpBridge
  });
  const detachStore = store.subscribe((state) => {
    evidence.write({
      event: "mode-change",
      session: state.sessionId,
      mode: state.mode,
      gear: state.gear,
      revision: state.revision,
      turbo: isTurbo(state.mode)
    });
  });
  const detachAdapter = adapter.attach();
  const optional = {};
  ctx.inject?.(["agents"], (serviceCtx) => {
    const registry = serviceCtx["agents"];
    if (registry !== void 0 && registry !== null) {
      optional.agents = registry;
    }
  });
  const observedAgents = /* @__PURE__ */ new Set();
  ctx.effect(() => {
    const onCreated = ctx.on("agent/created", ((payload) => {
      if (typeof payload?.agent?.id === "string") observedAgents.add(payload.agent.id);
    }));
    const onDisposed = ctx.on("agent/disposed", ((payload) => {
      if (typeof payload?.agent?.id === "string") observedAgents.delete(payload.agent.id);
    }));
    return () => {
      onCreated();
      onDisposed();
    };
  }, "dsh-turbo: live agent tracking");
  const live = (sessionId) => {
    if (observedAgents.has(sessionId)) return true;
    try {
      const lookup = optional.agents?.get;
      return typeof lookup === "function" && lookup.call(optional.agents, sessionId) !== void 0;
    } catch {
      return false;
    }
  };
  const stateRoute = {
    kind: "exact",
    path: `${ROUTE_PREFIX}/state`,
    handler: async (req, res) => {
      const request = req;
      const response = res;
      const method = (request.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        const url = safeUrl(request.url);
        const sessionId2 = url?.searchParams.get("sessionId") ?? void 0;
        if (!isSessionId(sessionId2)) {
          sendJson(response, 400, {
            ok: false,
            code: "invalid",
            message: "sessionId is required and must be a plain session token"
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          state: store.get(sessionId2),
          capabilities: adapter.capabilities(),
          metrics: metrics.summary(sessionId2),
          live: live(sessionId2),
          plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION }
        });
        return;
      }
      if (method !== "POST") {
        sendJson(response, 405, {
          ok: false,
          code: "unsupported",
          message: "Turbo state accepts GET and POST"
        });
        return;
      }
      const contentType = String(request.headers?.["content-type"] ?? "");
      if (!contentType.toLowerCase().includes("application/json")) {
        sendJson(response, 415, {
          ok: false,
          code: "invalid",
          message: "POST /api/dsh-turbo/state requires content-type: application/json"
        });
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: error instanceof Error ? error.message : "unreadable body"
        });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: "body must be a JSON object"
        });
        return;
      }
      const input = body;
      const sessionId = input.sessionId;
      const mode = parseMode(input.mode);
      const gear = input.gear === void 0 ? void 0 : parseGear(input.gear);
      if (!isSessionId(sessionId)) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: "sessionId is required and must be a plain session token"
        });
        return;
      }
      if (mode === void 0) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: 'mode must be "default" or "turbo"'
        });
        return;
      }
      if (input.gear !== void 0 && gear === void 0) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: 'gear must be "fast" or "max" when present'
        });
        return;
      }
      const expectedRevision = input.expectedRevision;
      if (expectedRevision !== void 0 && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        sendJson(response, 400, {
          ok: false,
          code: "invalid",
          message: "expectedRevision must be a non-negative integer when present"
        });
        return;
      }
      const outcome = store.set(sessionId, mode, expectedRevision, gear);
      if (outcome.conflict === true) {
        sendJson(response, 409, {
          ok: false,
          code: "conflict",
          message: "the session mode changed elsewhere; re-read the authoritative state",
          state: outcome.state
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        state: outcome.state,
        capabilities: adapter.capabilities(),
        metrics: metrics.summary(sessionId),
        live: live(sessionId),
        plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION }
      });
      log?.info("dsh-turbo: session %s mode=%s gear=%s revision=%d", sessionId, outcome.state.mode, outcome.state.gear, outcome.state.revision);
    }
  };
  const healthRoute = {
    kind: "exact",
    path: `${ROUTE_PREFIX}/health`,
    handler: (_req, res) => {
      let agentService = "absent";
      try {
        if (optional.agents !== void 0) {
          const list = optional.agents.list;
          agentService = typeof list === "function" ? `present:${String(list.call(optional.agents).length)}` : "present:no-list";
        }
      } catch {
        agentService = "present:probe-failed";
      }
      sendJson(res, 200, {
        ok: true,
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        trackedSessions: store.size,
        capabilities: adapter.capabilities(),
        diagnostics: {
          agentsService: agentService,
          observedAgents: observedAgents.size,
          evidence: evidence.enabled ? evidence.path ?? "on" : "off"
        }
      });
    }
  };
  ctx.inject?.(["webServer"], (serviceCtx) => {
    const webServer = serviceCtx["webServer"];
    if (webServer === void 0) return;
    serviceCtx.effect(() => {
      httpBridge = true;
      const disposeState = webServer.register(stateRoute);
      const disposeHealth = webServer.register(healthRoute);
      return () => {
        httpBridge = false;
        disposeHealth();
        disposeState();
      };
    }, "dsh-turbo: http bridge");
  });
  ctx.effect(() => () => {
    detachAdapter();
    detachStore();
    store.flush();
    metrics.flush();
    log?.info("dsh-turbo: unloaded (routes, prompt section, hooks and state withdrawn)");
  }, "dsh-turbo: lifetime");
  log?.info(
    "dsh-turbo %s: loaded (sectionOrder=%d, fastEffort=%s, maxEffort=%s, evidence=%s)",
    PLUGIN_VERSION,
    config.sectionOrder,
    config.reasoningEffort,
    config.maxReasoningEffort,
    evidence.enabled ? evidence.path ?? "" : "off"
  );
}
function safeUrl(raw) {
  try {
    return new URL(raw ?? "/", "http://dsh.local");
  } catch {
    return void 0;
  }
}
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", ((chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    }));
    request.on("end", (() => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() === "" ? {} : JSON.parse(text));
      } catch (error) {
        reject(new Error(`malformed JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    }));
    request.on("error", ((error) => reject(error)));
  });
}
export {
  DEFAULT_POLICY,
  EvidenceLog,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  RuntimeAdapter,
  TURBO_MAX_POLICY,
  TURBO_POLICY,
  TURBO_POLICY_MARKER,
  TURBO_SECTION_NAME,
  TurboMetrics,
  TurboSessionStore,
  apply,
  dshHome,
  inject,
  isSessionId,
  isTurbo,
  looksLikeVerification,
  name,
  parseGear,
  parseMode,
  policyFor,
  renderTurboPolicy,
  resolveConfig
};
//# sourceMappingURL=index.js.map
