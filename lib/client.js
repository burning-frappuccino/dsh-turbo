// dsh-turbo 0.2.2 — Web client half (generated from src/ by scripts/build.mjs)
// Registers a factory with the DSH client module system; nothing renders until
// the slot this plugin claims is first materialized.
window.__ModuleLoader__.load({
  id: "dsh-turbo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_BASE_PATH: () => DEFAULT_BASE_PATH,
  NS: () => NS,
  SlotName: () => SlotName,
  TURBO_CSS: () => TURBO_CSS,
  TurboController: () => TurboController,
  TurboToggle: () => TurboToggle,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/turbo-toggle.tsx
var React = __toESM(require("react"), 1);

// src/client/turbo-controller.ts
var DEFAULT_BASE_PATH = "/api/dsh-turbo";
var TurboController = class {
  #sessionId;
  #basePath;
  #fetch;
  #timeoutMs;
  #signal;
  constructor(sessionId, options = {}) {
    this.#sessionId = sessionId;
    this.#basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
    this.#timeoutMs = options.timeoutMs ?? 4e3;
    this.#signal = options.signal;
  }
  get sessionId() {
    return this.#sessionId;
  }
  /** `GET /state` — read the authoritative record for this Session. */
  async read() {
    return this.#request("GET", `/state?sessionId=${encodeURIComponent(this.#sessionId)}`);
  }
  /**
   * `POST /state` — ask the Host to move this Session to `mode`.
   *
   * @param mode - target mode.
   * @param expectedRevision - the revision currently on screen; the Host
   *   rejects the write when another tab has moved past it.
   */
  async write(mode, expectedRevision, gear) {
    const body = { sessionId: this.#sessionId, mode };
    if (gear !== void 0) body["gear"] = gear;
    if (expectedRevision !== void 0) body["expectedRevision"] = expectedRevision;
    return this.#request("POST", "/state", body);
  }
  async #request(method, path, body) {
    const fetchImpl = this.#fetch;
    if (fetchImpl === void 0) return { kind: "offline", message: "this browser has no fetch implementation" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const relay = () => controller.abort();
    this.#signal?.addEventListener("abort", relay, { once: true });
    try {
      const response = await fetchImpl(`${this.#basePath}${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : void 0,
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store"
      });
      const payload = await readJson(response);
      if (payload === void 0) {
        return { kind: "error", message: `bridge returned ${response.status} with no JSON body` };
      }
      if (response.status === 409 && isConflict(payload)) {
        return {
          kind: "conflict",
          view: {
            state: normalizeState(payload.state),
            capabilities: [],
            metrics: emptyMetrics(),
            live: false
          }
        };
      }
      if (!response.ok || !isReply(payload)) {
        const message = typeof payload.message === "string" ? String(payload.message) : `bridge returned ${response.status}`;
        return response.status === 400 ? { kind: "invalid", message } : { kind: "error", message };
      }
      return {
        kind: "ok",
        view: {
          state: normalizeState(payload.state),
          capabilities: payload.capabilities,
          metrics: payload.metrics,
          live: payload.live
        }
      };
    } catch (error) {
      if (isAbort(error)) return { kind: "offline", message: "the Host answered too slowly; Turbo state unknown" };
      return { kind: "offline", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", relay);
    }
  }
};
function emptyMetrics() {
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
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return void 0;
  }
}
function isAbort(error) {
  return typeof error === "object" && error !== null && error.name === "AbortError";
}
function isReply(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (record["ok"] !== true) return false;
  const state = record["state"];
  if (typeof state !== "object" || state === null) return false;
  const stateRecord = state;
  return typeof stateRecord["sessionId"] === "string" && (stateRecord["mode"] === "turbo" || stateRecord["mode"] === "default") && (stateRecord["gear"] === void 0 || stateRecord["gear"] === "fast" || stateRecord["gear"] === "max") && typeof stateRecord["revision"] === "number" && Array.isArray(record["capabilities"]) && typeof record["metrics"] === "object";
}
function isConflict(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (record["ok"] !== false || record["code"] !== "conflict") return false;
  const state = record["state"];
  if (typeof state !== "object" || state === null) return false;
  const stateRecord = state;
  return typeof stateRecord["sessionId"] === "string" && (stateRecord["mode"] === "turbo" || stateRecord["mode"] === "default") && (stateRecord["gear"] === void 0 || stateRecord["gear"] === "fast" || stateRecord["gear"] === "max") && typeof stateRecord["revision"] === "number";
}
function normalizeState(state) {
  return { ...state, gear: state.gear === "max" ? "max" : "fast" };
}

// src/client/turbo-toggle.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "turbo";
var BASE_PATH = "/api/dsh-turbo";
var POLL_MS = 2500;
var INITIAL = {
  mode: "default",
  gear: "fast",
  revision: 0,
  capabilities: [],
  metrics: emptyMetrics()
};
function TurboToggle(props) {
  const sessionId = props.turboSessionId;
  const controllerRef = React.useRef(void 0);
  const [status, setStatus] = React.useState("loading");
  const [snapshot, setSnapshot] = React.useState(INITIAL);
  const [switching, setSwitching] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const chipRef = React.useRef(null);
  const aliveRef = React.useRef(true);
  const tr = React.useCallback((key, fallback) => {
    const t = props.t;
    if (typeof t !== "function") return fallback;
    try {
      const value = t(key);
      return typeof value === "string" && value !== "" && value !== key ? value : fallback;
    } catch {
      return fallback;
    }
  }, [props.t]);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (typeof sessionId !== "string" || sessionId === "") {
      setStatus("unavailable");
      return;
    }
    const controller = new TurboController(sessionId, { basePath: BASE_PATH });
    controllerRef.current = controller;
    let cancelled = false;
    const load = async () => {
      const result = await controller.read();
      if (cancelled || !aliveRef.current) return;
      if (result.kind === "ok") {
        setSnapshot({
          mode: result.view.state.mode,
          gear: result.view.state.gear,
          revision: result.view.state.revision,
          capabilities: result.view.capabilities,
          metrics: result.view.metrics
        });
        setStatus("ready");
        setError(null);
        return;
      }
      if (result.kind === "offline") {
        setStatus("unavailable");
        return;
      }
      setStatus("unavailable");
    };
    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
    }, POLL_MS);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void load();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId]);
  const placePanel = React.useCallback(() => {
    const chip = chipRef.current;
    if (chip === null || typeof window === "undefined") return;
    const rect = chip.getBoundingClientRect();
    setAnchor({
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      right: Math.max(8, window.innerWidth - rect.right)
    });
  }, []);
  React.useEffect(() => {
    if (!detailsOpen) return;
    placePanel();
    const onResize = () => placePanel();
    const onKey = (event) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    const onPointer = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (chipRef.current?.closest(".dshTurbo_root")?.contains(target) === true) return;
      setDetailsOpen(false);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [detailsOpen, placePanel]);
  const onToggle = React.useCallback(() => {
    const controller = controllerRef.current;
    if (controller === void 0 || switching) return;
    if (status !== "ready") return;
    const previous = snapshot;
    const target = previous.mode === "turbo" ? "default" : "turbo";
    setSwitching(true);
    setError(null);
    setSnapshot({ ...previous, mode: target });
    void controller.write(target, previous.revision, previous.gear).then((result) => {
      if (!aliveRef.current) return;
      setSwitching(false);
      if (result.kind === "ok") {
        setSnapshot({
          mode: result.view.state.mode,
          gear: result.view.state.gear,
          revision: result.view.state.revision,
          capabilities: result.view.capabilities,
          metrics: result.view.metrics
        });
        setStatus("ready");
        return;
      }
      if (result.kind === "conflict") {
        setSnapshot({
          mode: result.view.state.mode,
          gear: result.view.state.gear,
          revision: result.view.state.revision,
          capabilities: previous.capabilities,
          metrics: previous.metrics
        });
        setError(tr("error.conflict", "Another tab changed this session; showing the Host value."));
        return;
      }
      setSnapshot(previous);
      setError(
        result.kind === "offline" ? tr("error.offline", "Host unreachable \u2014 Turbo not changed.") : result.kind === "invalid" ? tr("error.invalid", "Host rejected the request.") : tr("error.generic", "Turbo switch failed.")
      );
    }, () => {
      if (!aliveRef.current) return;
      setSwitching(false);
      setSnapshot(previous);
      setError(tr("error.generic", "Turbo switch failed."));
    });
  }, [snapshot, status, switching, tr]);
  const onGearChange = React.useCallback((event) => {
    const controller = controllerRef.current;
    if (controller === void 0 || switching || status !== "ready" || snapshot.mode !== "turbo") return;
    const previous = snapshot;
    const gear = event.currentTarget.value === "1" ? "max" : "fast";
    if (gear === previous.gear) return;
    setSwitching(true);
    setError(null);
    setSnapshot({ ...previous, gear });
    void controller.write("turbo", previous.revision, gear).then((result) => {
      if (!aliveRef.current) return;
      setSwitching(false);
      if (result.kind === "ok") {
        setSnapshot({
          mode: result.view.state.mode,
          gear: result.view.state.gear,
          revision: result.view.state.revision,
          capabilities: result.view.capabilities,
          metrics: result.view.metrics
        });
        return;
      }
      if (result.kind === "conflict") {
        setSnapshot({
          mode: result.view.state.mode,
          gear: result.view.state.gear,
          revision: result.view.state.revision,
          capabilities: previous.capabilities,
          metrics: previous.metrics
        });
        setError(tr("error.conflict", "Another tab changed this session; showing the Host value."));
        return;
      }
      setSnapshot(previous);
      setError(result.kind === "offline" ? tr("error.offline", "Host unreachable \u2014 Turbo not changed.") : tr("error.generic", "Turbo switch failed."));
    }, () => {
      if (!aliveRef.current) return;
      setSwitching(false);
      setSnapshot(previous);
      setError(tr("error.generic", "Turbo switch failed."));
    });
  }, [snapshot, status, switching, tr]);
  const mode = snapshot.mode;
  const on = mode === "turbo";
  const label = status === "loading" ? tr("label.loading", "Turbo") : status === "unavailable" ? tr("label.unavailable", "OVERDRIVE unavailable") : switching ? tr("label.switching", "Switching\u2026") : on ? snapshot.gear === "max" ? tr("label.max", "\u{1F525} \u6781\u9650") : tr("label.fast", "\u26A1 \u6781\u901F") : tr("label.off", "OVERDRIVE");
  const title = status === "unavailable" ? tr("title.unavailable", "Turbo host bridge unreachable") : on ? tr("title.on", "Turbo is on for this session \u2014 click to return to the default execution mode") : tr("title.off", "Turbo is off for this session \u2014 click for the low-latency execution mode");
  const className = [
    "dshTurbo_button",
    on && status === "ready" ? "dshTurbo_on" : "",
    status === "unavailable" ? "dshTurbo_unavailable" : "",
    switching ? "dshTurbo_busy" : ""
  ].filter(Boolean).join(" ");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshTurbo_root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        ref: chipRef,
        type: "button",
        className,
        "aria-pressed": status === "ready" ? on : void 0,
        "aria-label": title,
        title,
        disabled: status !== "ready" || switching,
        onClick: onToggle,
        "data-dsh-turbo-mode": status === "ready" ? mode : "unknown",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshTurbo_bolt", "aria-hidden": "true", children: on && status === "ready" ? snapshot.gear === "max" ? "\u{1F525}" : "\u26A1" : "" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshTurbo_text", children: label })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "label",
      {
        className: `dshTurbo_gears ${!on || status !== "ready" ? "dshTurbo_gearsDisabled" : ""}`,
        title: tr("gear.title", "Drag to choose Fast or Max"),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: snapshot.gear === "fast" ? "dshTurbo_gearActive" : "", children: tr("gear.fast", "\u6781\u901F") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "range",
              min: "0",
              max: "1",
              step: "1",
              value: snapshot.gear === "max" ? 1 : 0,
              "aria-label": tr("gear.aria", "Turbo gear"),
              disabled: !on || status !== "ready" || switching,
              onChange: onGearChange,
              "data-dsh-turbo-gear": snapshot.gear
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: snapshot.gear === "max" ? "dshTurbo_gearActive dshTurbo_gearMax" : "", children: tr("gear.max", "\u6781\u9650") })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dshTurbo_info",
        "aria-label": tr("details.open", "OVERDRIVE details"),
        "aria-expanded": detailsOpen,
        title: tr("details.open", "OVERDRIVE details"),
        disabled: status === "unavailable",
        onClick: () => setDetailsOpen((open) => !open),
        children: "?"
      }
    ),
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshTurbo_error", role: "status", title: error, children: error }),
    detailsOpen && anchor !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      DetailsPanel,
      {
        tr,
        anchor,
        onClose: () => setDetailsOpen(false)
      }
    )
  ] });
}
function DetailsPanel({ tr, anchor, onClose }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      className: "dshTurbo_panel",
      role: "dialog",
      "aria-label": tr("details.title", "DSH OVERDRIVE"),
      style: { bottom: `${anchor.bottom}px`, right: `${anchor.right}px` },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshTurbo_panelHead", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: tr("details.title", "DSH OVERDRIVE") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dshTurbo_close", onClick: onClose, "aria-label": tr("details.close", "Close"), children: "\xD7" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshTurbo_intro", children: tr("details.intro", "Helps tasks take a more direct path and finish faster.") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshTurbo_gearHelp", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: tr("gear.fast", "\u6781\u901F") }),
            ": ",
            tr("details.fast", "\u5C11\u601D\u8003\u3001\u5C11\u7ED5\u8DEF\uFF0C\u4F18\u5148\u63A7\u5236 Token\u3002")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: tr("gear.max", "\u6781\u9650") }),
            ": ",
            tr("details.max", "\u5141\u8BB8\u591A\u82B1 Token\uFF0C\u5E76\u884C\u83B7\u53D6\u4E0A\u4E0B\u6587\u548C\u6267\u884C\u72EC\u7ACB\u5DE5\u5177\uFF0C\u4F18\u5148\u538B\u7F29\u7B49\u5F85\u65F6\u95F4\u3002")
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshTurbo_benefits", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshTurbo_benefit", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: "dshTurbo_metric", children: tr("details.flow.value", "about 20%") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: tr("details.flow.label", "fewer execution steps") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshTurbo_benefit", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { className: "dshTurbo_metric", children: tr("details.speed.value", "about 1.5\xD7") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: tr("details.speed.label", "faster completion") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshTurbo_caveat", children: tr("details.caveat", "Based on current measurements; results vary by task and model.") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshTurbo_try", children: tr("details.try", "Try a quick test: run the same task once with Turbo on and once off, then compare time and token usage.") })
      ]
    }
  );
}
var TURBO_CSS = `
.dshTurbo_root{display:inline-flex;align-items:center;gap:4px;min-width:0;position:relative}
.dshTurbo_button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;transition:background-color .12s,color .12s;white-space:nowrap}
.dshTurbo_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTurbo_button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshTurbo_button:disabled{cursor:default}
.dshTurbo_on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.dshTurbo_on:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 8%);color:var(--dsw-alias-state-business-primary)}
.dshTurbo_unavailable{color:var(--dsw-alias-label-tertiary);opacity:.7;cursor:not-allowed}
.dshTurbo_busy{opacity:.65}
.dshTurbo_bolt{display:inline-flex;width:0;overflow:hidden}
.dshTurbo_on .dshTurbo_bolt,.dshTurbo_button:not(.dshTurbo_on) .dshTurbo_bolt{width:0}
.dshTurbo_info{width:18px;height:18px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.dshTurbo_gears{display:inline-flex;align-items:center;gap:3px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;white-space:nowrap}
.dshTurbo_gears input{width:38px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dshTurbo_gearsDisabled{opacity:.38}
.dshTurbo_gearsDisabled input{cursor:default}
.dshTurbo_gearActive{color:var(--dsw-alias-state-business-primary);font-weight:600}
.dshTurbo_gearMax{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}
.dshTurbo_info:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTurbo_info:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshTurbo_error{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dshTurbo_panel{position:fixed;z-index:60;box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);padding:10px 12px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:18px}
.dshTurbo_panelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:13px}
.dshTurbo_close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:16px;cursor:pointer;padding:0 2px}
.dshTurbo_close:hover{color:var(--dsw-alias-label-primary)}
.dshTurbo_intro{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
.dshTurbo_gearHelp{margin:0 0 10px;padding:7px 8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshTurbo_gearHelp p{margin:0}
.dshTurbo_gearHelp p+p{margin-top:4px}
.dshTurbo_benefits{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.dshTurbo_benefit{display:flex;min-width:0;flex-direction:column;gap:1px;padding:9px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-secondary)}
.dshTurbo_metric{color:var(--dsw-alias-state-business-primary);font-size:18px;line-height:22px;font-variant-numeric:tabular-nums}
.dshTurbo_caveat{margin:0 0 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshTurbo_try{margin:0;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
@media (max-width:640px){
  .dshTurbo_button{padding:0 6px}
  .dshTurbo_on .dshTurbo_text{display:none}
  .dshTurbo_on .dshTurbo_bolt{width:auto}
  .dshTurbo_error{display:none}
  .dshTurbo_gears span{display:none}
  .dshTurbo_gears input{width:32px}
}
`;

// src/client/index.ts
var inject = ["slots", "locale"];
var SLOT = "conversation.input.right";
var STYLE_ID = "dsh-turbo/turbo.css";
var zh = {
  "label.off": "OVERDRIVE",
  "label.on": "\u26A1 Turbo ON",
  "label.fast": "\u26A1 \u6781\u901F",
  "label.max": "\u{1F525} \u6781\u9650",
  "label.loading": "Turbo",
  "label.switching": "Switching\u2026",
  "label.unavailable": "OVERDRIVE \u4E0D\u53EF\u7528",
  "title.off": "\u672C\u4F1A\u8BDD\u4E3A\u9ED8\u8BA4\u6267\u884C\u6A21\u5F0F \u2014 \u70B9\u51FB\u5207\u6362\u4E3A\u6781\u901F\u6A21\u5F0F",
  "title.on": "\u672C\u4F1A\u8BDD\u5DF2\u5F00\u542F\u6781\u901F\u6A21\u5F0F \u2014 \u70B9\u51FB\u6062\u590D\u9ED8\u8BA4\u6267\u884C\u6A21\u5F0F",
  "title.unavailable": "\u65E0\u6CD5\u8FDE\u63A5 Turbo Host \u6865\u63A5",
  "gear.fast": "\u6781\u901F",
  "gear.max": "\u6781\u9650",
  "gear.title": "\u62D6\u52A8\u9009\u62E9\u6781\u901F\u6216\u6781\u9650\u6863",
  "gear.aria": "Turbo \u6863\u4F4D",
  "details.open": "OVERDRIVE \u6548\u679C\u8BF4\u660E",
  "details.close": "\u5173\u95ED",
  "details.title": "DSH OVERDRIVE",
  "details.intro": "\u8BA9\u4EFB\u52A1\u5C11\u8D70\u5F2F\u8DEF\uFF0C\u66F4\u5FEB\u5B8C\u6210\u3002",
  "details.fast": "\u5C11\u601D\u8003\u3001\u5C11\u7ED5\u8DEF\uFF0C\u4F18\u5148\u63A7\u5236 Token\u3002",
  "details.max": "\u5141\u8BB8\u591A\u82B1 Token\uFF0C\u5E76\u884C\u83B7\u53D6\u4E0A\u4E0B\u6587\u548C\u6267\u884C\u72EC\u7ACB\u5DE5\u5177\uFF0C\u4F18\u5148\u538B\u7F29\u7B49\u5F85\u65F6\u95F4\u3002",
  "details.flow.value": "\u7EA6 20%",
  "details.flow.label": "\u51CF\u5C11\u6267\u884C\u6D41\u7A0B",
  "details.speed.value": "\u7EA6 1.5\xD7",
  "details.speed.label": "\u63D0\u5347\u5B8C\u6210\u901F\u5EA6",
  "details.caveat": "\u53C2\u8003\u5F53\u524D\u5B9E\u6D4B\uFF0C\u5B9E\u9645\u6548\u679C\u4F1A\u968F\u4EFB\u52A1\u548C\u6A21\u578B\u53D8\u5316\u3002",
  "details.try": "\u6B22\u8FCE\u505A\u4E2A\u5C0F\u6D4B\u8BD5\uFF1A\u7528\u540C\u4E00\u4EFB\u52A1\u5206\u522B\u5F00\u542F\u548C\u5173\u95ED Turbo\uFF0C\u5BF9\u6BD4\u8017\u65F6\u4E0E Token \u7528\u91CF\u3002",
  "error.conflict": "\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u5DF2\u4FEE\u6539\uFF0C\u663E\u793A Host \u7684\u5F53\u524D\u503C",
  "error.offline": "\u65E0\u6CD5\u8FDE\u63A5 Host \u2014 \u672A\u4FEE\u6539 Turbo",
  "error.invalid": "Host \u62D2\u7EDD\u4E86\u8BE5\u8BF7\u6C42",
  "error.generic": "\u5207\u6362 Turbo \u5931\u8D25"
};
var en = {
  "label.off": "OVERDRIVE",
  "label.on": "\u26A1 Turbo ON",
  "label.fast": "\u26A1 Fast",
  "label.max": "\u{1F525} Max",
  "label.loading": "Turbo",
  "label.switching": "Switching\u2026",
  "label.unavailable": "OVERDRIVE unavailable",
  "title.off": "This session uses the default execution mode \u2014 click for Turbo",
  "title.on": "Turbo is on for this session \u2014 click to restore the default mode",
  "title.unavailable": "The Turbo host bridge is unreachable",
  "gear.fast": "Fast",
  "gear.max": "Max",
  "gear.title": "Drag to choose Fast or Max",
  "gear.aria": "Turbo gear",
  "details.open": "About OVERDRIVE results",
  "details.close": "Close",
  "details.title": "DSH OVERDRIVE",
  "details.intro": "Helps tasks take a more direct path and finish faster.",
  "details.fast": "Less deliberation and fewer detours, with token cost kept in check.",
  "details.max": "Spends extra tokens on parallel context and independent tools to reduce wall-clock time.",
  "details.flow.value": "about 20%",
  "details.flow.label": "fewer execution steps",
  "details.speed.value": "about 1.5\xD7",
  "details.speed.label": "faster completion",
  "details.caveat": "Based on current measurements; results vary by task and model.",
  "details.try": "Try a quick test: run the same task once with Turbo on and once off, then compare time and token usage.",
  "error.conflict": "Another tab changed this session; showing the Host value",
  "error.offline": "Host unreachable \u2014 Turbo not changed",
  "error.invalid": "The Host rejected the request",
  "error.generic": "Turbo switch failed"
};
function apply(ctx) {
  installStyles(ctx);
  if (typeof ctx.locale?.register === "function") {
    try {
      ctx.locale.register(NS, { zh, en });
    } catch (error) {
      ctx.logger?.warn?.("dsh-turbo: locale registration failed: %o", error);
    }
  }
  const slots = ctx.slots;
  if (typeof slots?.inject !== "function" || typeof slots.register !== "function") {
    ctx.logger?.warn?.("dsh-turbo: the client slot service is unavailable; the toggle cannot be registered");
    return;
  }
  slots.inject(SLOT, () => slots.register?.({
    name: SLOT,
    kind: "list",
    id: "dsh-turbo",
    order: 10,
    locale: NS,
    // The slot's session binding is the only Session identity this control
    // needs: the Host validates it again on every read and write.
    inject: (sessionId) => ({ turboSessionId: sessionId })
  }, TurboToggle));
}
function installStyles(ctx) {
  if (typeof document === "undefined") return;
  try {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
    const tag = document.createElement("style");
    tag.dataset["plugin"] = "dsh-turbo";
    tag.dataset["pluginCss"] = STYLE_ID;
    tag.textContent = TURBO_CSS;
    document.head.appendChild(tag);
  } catch (error) {
    ctx.logger?.warn?.("dsh-turbo: stylesheet injection failed: %o", error);
  }
}
var SlotName = SLOT;
    return module.exports;
  },
});
//# sourceMappingURL=client.js.map
