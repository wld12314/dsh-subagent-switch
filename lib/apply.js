// apply.js — plugin entry point
//
// DSH loads this via `apply(ctx, config)`. The `ctx` object comes from the
// DSH runtime; we try to use it without assuming every method exists.
// Until the real hooks are mounted (model list read, subagent spawn
// interception, UI panel registration), this module wires the pure engine
// and provides clear diagnostic errors on any unknown hook.

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "./router.js";
import { selectionOf, resolveExcludedProviders, isExcludedProvider, DEFAULT_CHEAP_BAND } from "./models.js";
import { pollQuota, estimateCost, resolveQuotaAwareProviders, resolveAccountBackedProviders } from "./quota.js";
import { fetchWebSummary as defaultFetchWebSummary } from "./tags.js";
// Imported for local use: a bare `export ... from` creates no local binding.
import { canonicalDomain } from "./tags.js";
import {
  defaultOverridesPath,
  readOverrides,
  writeOverrides,
  withPriority,
  withRoutable,
  pinnedList,
  PRIORITY_MIN,
  PRIORITY_MAX
} from "./overrides.js";

// Overridable tag-sync fetch; defaults to the stub in tags.js (throws clearly).
let fetchWebSummary = defaultFetchWebSummary;

// ---- Cordis plugin declaration -------------------------------------------
// Cordis reads these top-level exports. `inject` declares service dependencies
// so apply() is deferred until they exist AND so that Cordis's context proxy
// lets us read them at all — touching an undeclared service throws
// `cannot get property "X" without inject`. That applies to every service,
// including platform ones, so all three must be listed here:
//   - webServer: not a Cordis service but our panel API's HTTP handle (the
//     working @local/model-route plugin declares it the same way).
//   - llm: the real host-side model catalog (ctx.llm.listProviders /
//     listModels / resolveModelInfo). This is what DSH's own model bar uses.
//   - subagents: the subagent service we wrap startActivation on.
export const name = "subagent-switch";
export const inject = ["webServer", "llm", "subagents"];

let config = null;
let router = null;

// ---- safe context access -------------------------------------------------
// Cordis's context proxy THROWS on any property that is neither declared in
// `inject` nor present on the context — it does not return undefined. So a
// plain `typeof ctx.listModels === "function"` probe would itself raise
// `cannot get property "listModels" without inject` and take the caller down.
// Every optional/probing access must go through this.
function safeGet(ctx, prop) {
  if (ctx == null) return undefined;
  try {
    return ctx[prop];
  } catch {
    return undefined;
  }
}

// ---- internal helpers ----------------------------------------------------

// Domain keywords, English and Chinese. The Chinese entries are not decorations:
// real subagent tasks in this build are Chinese ("写一个快速排序"), and an
// English-only table classified every one of them as `general`, which made all
// tasks collapse onto whichever model happened to be good at `general`.
const DOMAIN_KEYWORDS = {
  coding: [
    "coding", "code", "programming", "debug", "refactor", "test", "function",
    "编码", "代码", "调试", "重构", "程序", "函数", "测试", "报错", "编译",
    "脚本", "算法", "接口", "排序", "数据库", "部署", "修 bug", "修复",
    // 不收裸的「实现」：「业界有哪些成熟实现思路」是调研任务，会误判成编码。
    // 真正的编码任务靠「排序」「算法」「函数」「代码」这些更强的词命中。
    "实现功能", "实现一个", "实现代码"
  ],
  research: [
    "research", "investigate", "literature", "web search", "retrieval",
    "调研", "检索", "查资料", "搜索", "调查", "文献", "资料", "查一下", "找一下"
  ],
  writing: [
    "write", "article", "draft", "copy", "email", "translate",
    // 注意别放裸的 "写一"/"写个"/"写篇"：中文里 "写一个快速排序" 是编码任务，
    // 会被误判成写作。只收带明确文体的词。
    "写作", "撰写", "文章", "稿子", "邮件", "翻译", "文案", "润色",
    "写一篇", "写篇文", "写一封", "写段文", "写个文案", "写个稿"
  ],
  summarize: [
    "summarize", "summary", "brief", "condense",
    "总结", "摘要", "概括", "简述", "提炼", "归纳"
  ],
  analysis: [
    "analyze", "compare", "review", "evaluate",
    "分析", "评估", "对比", "比较", "审查", "复盘", "排查"
  ],
  background: [
    "background", "context", "recap",
    "背景", "上下文", "回顾", "补充资料"
  ]
};

/** Category values that mean "let the task text decide". */
const AUTO_CATEGORIES = new Set(["", "auto", "general"]);

/**
 * Build the required/optional domain sets for one subagent task.
 *
 * `category` is an explicit statement of intent (routing table, caller, or
 * `inferCategory`) and is authoritative when it is a real category. The
 * description then only *adds* optional hints, so an explicit `coding` request
 * is never diluted into `general` just because the prompt happened not to
 * contain an English keyword.
 *
 * When `category` is empty/`general`/`auto`, the description decides: matched
 * domains become required, and `general` is the fallback.
 */
function defaultTaskClassifier(category, subtask) {
  const rawExplicit = String(category || "").trim();
  const explicit = String(category || "").trim().toLowerCase();
  const description = String(subtask?.description || "").toLowerCase();

  const matched = [];
  for (const [cat, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws.some((k) => description.includes(k))) matched.push(cat);
  }

  // Explicit intent wins: it becomes the required set, description domains are
  // demoted to optional so they nudge ranking without redefining the task.
  if (!AUTO_CATEGORIES.has(explicit)) {
    // Callers may pass a Chinese category ("编码") straight into the routing
    // table or /select. Without canonicalizing it here the required set would be
    // ["编码"], which never equals a tagged "coding" — every such call would
    // silently collapse to a 0-score fallback. Same translation as config.tags.
    const canonical = canonicalDomain(rawExplicit) || explicit;
    const optional = matched.filter((d) => d !== canonical);
    return { required: [canonical], optional };
  }

  const required = matched.slice();
  const optional = [];

  if (required.length === 0) {
    required.push("general");
  }

  return { required, optional };
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `source` over `target`.
 *
 * Objects merge key by key; **arrays REPLACE**. The original implementation
 * concatenated arrays, which made `["free"]` in a patch config come out as
 * `["free", "free_quota", "paid"]` — a user narrowing a list silently widened
 * it instead. Same class of bug as the dropped-config one below: the config
 * said one thing and the plugin did another. Replacing is what "override"
 * means to everyone writing a config file; growing a list is opt-in (write the
 * whole list).
 */
function mergeDeep(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = out[key];
    if (isPlainObject(tv) && isPlainObject(sv)) {
      out[key] = mergeDeep(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

/**
 * The config block this plugin owns inside a Cordis patch row.
 */
const PLUGIN_KEY = "subagent-switch";

/**
 * Strip the `subagent-switch` wrapper when it is present.
 *
 * `config.example.json` ships as `{ "subagent-switch": { ... } }`, while
 * `dsh-bundle.patch.yml` hands `apply()` the body FLAT:
 *
 *     config:
 *       enabled: true
 *       panelTitle: ...
 *
 * Both shapes must unwrap to the same plain body, because `apply()` used to do
 * `mergeDeep(example, configIn)` and then `opts = config["subagent-switch"]`:
 * a flat patch config landed at the TOP level, `config["subagent-switch"]` was
 * still the untouched example subtree, and every patch-supplied value
 * (panelTitle / enabled / escalateOnMiss / overridesPath / routingTable / ...)
 * was silently dropped. The plugin then ran on example defaults forever.
 */
function unwrapPluginConfig(raw) {
  if (!isPlainObject(raw)) return {};
  const nested = raw[PLUGIN_KEY];
  return isPlainObject(nested) ? nested : raw;
}

/**
 * Merge the shipped defaults with whatever the host passed, accepting either
 * config shape. Returns the flat option body (never wrapped).
 */
function resolvePluginConfig(exampleConfig, configIn) {
  return mergeDeep(unwrapPluginConfig(exampleConfig), unwrapPluginConfig(configIn));
}

// ---- public API --------------------------------------------------------

export async function apply(ctx, configIn) {
  log("subagent-switch", "apply() entered");

  // Each step below is isolated: a failure in one must not stop the panel API
  // from mounting, because that is the only feedback surface the user has.
  const step = (name, fn) => {
    try {
      const out = fn();
      log("subagent-switch", `step ok: ${name}`);
      return out;
    } catch (err) {
      log("subagent-switch", `step FAILED: ${name}: ${err?.stack || err?.message || String(err)}`);
      return undefined;
    }
  };

  config = step("load config", () => resolvePluginConfig(loadExampleConfig(), configIn)) || {};
  const opts = config;

  // Whole-provider exclusion (core default: `cline`). Resolved once here and
  // threaded into the catalog read so excluded providers are skipped BEFORE
  // `llm.listModels()` / `llm.resolveModelInfo()` are called — filtering later
  // would still pay for the hundreds of adapter round-trips we are avoiding.
  const excludedProviders =
    step("resolve excluded providers", () => resolveExcludedProviders(opts.excludedProviders)) || [];

  // Panel-managed overrides (manual priority + per-model "放行"). Resolved once
  // so the router, the API and the panel all point at the SAME file; a mismatch
  // would mean the panel writes somewhere the router never reads.
  const overridesPath = step("resolve overrides path", () => opts.overridesPath || defaultOverridesPath())
    || defaultOverridesPath();

  router = step("build router", () => new Router({ ...opts, overridesPath }, {
    async getModelList() {
      const list = await readModelListFromHost(ctx, { excludedProviders });
      // Balances are a provider property, read over the host web server. Do it
      // here (inside the model source) so the gate always sees fresh numbers,
      // and so the very first apply-time refresh is already correct. Failures
      // are non-fatal: an unreadable provider just has no balance attached.
      if (typeof readQuotasRef === "function") {
        await readQuotasRef();
      }
      return list;
    }
  }, defaultTaskClassifier));

  if (!router) {
    log("subagent-switch", "router construction failed; plugin inactive");
    return;
  }

  // Host bridge: expose a stable seam so the integrator can route a subagent
  // spawn without patching DSH internals. `selectForSubtask(subtask)` returns
  // the chosen normalized model record (or null); `selectionOf(record)`
  // projects it into the exact shape a subagent carries
  // ({ provider, model, reasoningEffort }). The host wires this into the
  // subagent spawn path on a per-build basis.
  const bridge = {
    selectForSubtask: async (subtask = {}) => {
      await router.refreshModels();
      const result = router.select(subtask);
      return result.model ? result : null;
    },
    selectionOf
  };
  if (ctx && typeof ctx === "object" && !Object.isFrozen(ctx)) {
    try { ctx.subagentSwitch = bridge; } catch { /* host may not allow writes */ }
  }

  // The extra panel is the BROWSER half (lib/ui/client.js), loaded by DSH
  // through package.json's `dsh.client`. Its data bridge is the HTTP route
  // registered below (same pattern as the working @local/model-route plugin:
  // ctx.inject(['webServer']) + server.register({ kind: 'prefix', ... })).
  //
  // Mounted FIRST, before the subagent wrapper and the quota monitor: the API
  // is the user's only window into this plugin, so nothing that runs later may
  // be able to prevent it from appearing.
  step("mount panel api", () => installPanelApi(ctx, router, opts));

  // ---- subagent model injection (the real hook) ---------------------------
  // Every subagent (spawn / fork / external) flows through
  // `ctx.subagents.startActivation(spec)`. The child's model rides in
  // `spec.request.agentOptions = { provider, model, reasoningEffort }`.
  // We wrap that one method. This is the only runtime intercept point — there
  // is no dedicated "model override" hook in DSH's subagent service.
  try {
    await installStartActivationWrapper(ctx, router, opts, log);
    log("subagent-switch", "step ok: install startActivation wrapper");
  } catch (err) {
    log("subagent-switch", `step FAILED: install startActivation wrapper: ${err?.stack || err?.message || String(err)}`);
  }

  // Install any pure-logic tools this plugin exposes to the agent. None yet;
  // register a private name if/when we add diagnostics.
  step("install pure tools", () => installPureTools(ctx));

  // Web-sync: allow the host/integrator to override the tag-sync fetch. The
  // default export from tags.js already throws a clear error when engaged, so
  // we never silently no-op in production.
  step("wire tag sync fetch", () => {
    fetchWebSummary = (opts.tagSync && typeof opts.tagSync.fetchWebSummary === "function")
      ? opts.tagSync.fetchWebSummary
      : defaultFetchWebSummary;
  });

  // Start quota monitoring.
  if (opts.quota && opts.quota.enabled !== false) {
    try {
      startQuotaMonitor(ctx, opts);
      log("subagent-switch", "step ok: quota monitor");
    } catch (err) {
      log("subagent-switch", `step FAILED: quota monitor: ${err?.stack || err?.message || String(err)}`);
    }
  }

  // Log, not crash, if the real model-list read fails at first load.
  try {
    await router.refreshModels();
    log("subagent-switch", `models loaded: ${router.models?.length || 0}`);
  } catch (err) {
    log("subagent-switch", `failed to read model list: ${err?.message || String(err)}`);
  }

  log("subagent-switch", "apply() finished");
}

// ---- DSH-specific hooks (per DSH version) -------------------------------

/**
 * Load the bundled example config. We read it from disk (not a dynamic
 * `import` with an assertions arg) so the plugin keeps working whether DSH
 * bundles it as ESM or CJS — import assertions are only valid in ESM and vary
 * by Node version.
 */
function loadExampleConfig() {
  try {
    // config.example.json sits at the package root, one level above lib/.
    const raw = readFileSync(new URL("../config.example.json", import.meta.url), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    log("subagent-switch", `could not load example config: ${e?.message || String(e)}`);
    return {};
  }
}

/**
 * Read the model list from the host's own LLM registry — the same source DSH's
 * session model bar reads.
 *
 * IMPORTANT: there is no host-side `ctx.listModels()`. That method belongs to
 * the browser RPC client (`harness-client.mjs` -> `llm.models`). The host
 * side is the Cordis `llm` service, and DSH builds its model catalog from it
 * exactly this way (dsh-api-session-controller `buildModelCatalog`):
 *   ctx.llm.listProviders()                  -> [{ id, name }]
 *   ctx.llm.listModels(providerId)           -> [{ provider, id, name, description?, inputModalities? }]
 *   ctx.llm.resolveModelInfo(providerId, id) -> + { context: { contextWindow }, reasoning: { efforts, defaultEffort } }
 *
 * Note `listModels` deliberately carries NO credit/quota information — the
 * adapter drops everything except identity. For workbuddy the price survives
 * only because the display name embeds it (`"Hy3 · x0.00"`), which is why tier
 * inference parses that suffix (see models.js inferTier).
 *
 * The selection shape a subagent carries is:
 *   { provider, model, reasoningEffort? }
 */
async function readModelListFromHost(ctx, readOptions = {}) {
  const excludedProviders = Array.isArray(readOptions.excludedProviders)
    ? readOptions.excludedProviders
    : resolveExcludedProviders(undefined);

  // Primary: the live host LLM registry.
  const llm = safeGet(ctx, "llm");
  if (llm && typeof llm.listProviders === "function") {
    return await readModelsFromLlm(llm, excludedProviders);
  }

  // Fallback: a host that exposes a single already-grouped catalog.
  const legacyListModels = safeGet(ctx, "listModels");
  if (typeof legacyListModels === "function") {
    return await readModelsFromGroupedCatalog(await legacyListModels.call(ctx), excludedProviders);
  }

  throw new Error(
    `[subagent-switch] no model catalog on this DSH build: neither ` +
    `ctx.llm.listProviders() nor ctx.listModels() is available. ` +
    `If this build renamed the LLM service, add its name to the plugin's inject list.`
  );
}

// resolveModelInfo is one adapter round-trip per model. Cache it briefly so
// opening the panel repeatedly does not re-hit every adapter each time.
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;
const MODEL_INFO_CACHE = new Map(); // "provider/model" -> { at, info }

async function resolveModelInfoCached(llm, provider, model) {
  if (typeof llm.resolveModelInfo !== "function") return null;
  const key = `${provider}/${model}`;
  const now = Date.now();
  const hit = MODEL_INFO_CACHE.get(key);
  if (hit && now - hit.at < MODEL_INFO_TTL_MS) return hit.info;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    MODEL_INFO_CACHE.set(key, { at: now, info });
    return info;
  } catch (err) {
    // Enrichment is optional; a model without metadata is still routable.
    log("subagent-switch", `resolveModelInfo failed for ${key}: ${err?.message || String(err)}`);
    return null;
  }
}

function effortFields(reasoning) {
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
  const defaultEffort = reasoning?.defaultEffort ?? null;
  const highestEffort = efforts.length
    ? (efforts[efforts.length - 1].id ?? efforts[efforts.length - 1].name ?? null)
    : null;
  return {
    reasoningEfforts: efforts.map((e) => String(e.id ?? e.name)),
    defaultEffort: defaultEffort != null ? String(defaultEffort) : highestEffort,
    highestEffort
  };
}

async function readModelsFromLlm(llm, excludedProviders = []) {
  const providers = llm.listProviders() || [];
  const records = [];
  const failures = [];
  const skippedProviders = [];

  for (const provider of providers) {
    const providerId = String(provider?.id ?? "");
    if (!providerId) continue;

    // Skip an excluded provider BEFORE touching its adapter. On a setup like
    // `cline` that is 459 models — 459 listModels results and 459
    // resolveModelInfo round-trips that we never pay for.
    if (isExcludedProvider(providerId, excludedProviders)) {
      skippedProviders.push(providerId);
      continue;
    }

    let models;
    try {
      models = await llm.listModels(providerId);
    } catch (err) {
      // One broken provider must not blank the whole catalog (DSH's own
      // builder isolates failures the same way).
      failures.push(`${providerId}: ${err?.message || String(err)}`);
      continue;
    }

    for (const m of models || []) {
      const modelId = String(m?.id ?? "");
      if (!modelId) continue;
      const info = await resolveModelInfoCached(llm, providerId, modelId);
      const { reasoningEfforts, defaultEffort, highestEffort } = effortFields(info?.reasoning);
      const contextWindow = info?.context?.contextWindow;
      records.push({
        id: `${providerId}/${modelId}`,
        provider: providerId,
        model: modelId,
        name: String(m.name ?? modelId),
        description: m.description ?? info?.description ?? "",
        contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
        reasoningEfforts,
        defaultEffort,
        highestEffort,
        // Tier is inferred by normalizeModel from provider/name unless the
        // config explicitly maps this id.
        tier: undefined
      });
    }
  }

  if (records.length === 0) {
    const detail = failures.length ? ` (provider failures: ${failures.join("; ")})` : "";
    const excludedNote = skippedProviders.length
      ? ` Excluded by config.excludedProviders: ${skippedProviders.join(", ")}.`
      : "";
    throw new Error(
      `[subagent-switch] ctx.llm reported no usable models across ${providers.length} provider(s)${detail}.${excludedNote}`
    );
  }
  for (const failure of failures) {
    log("subagent-switch", `model provider failed: ${failure}`);
  }
  if (skippedProviders.length) {
    log(
      "subagent-switch",
      `excluded provider(s) skipped before adapter calls: ${skippedProviders.join(", ")}`
    );
  }

  return records;
}

async function readModelsFromGroupedCatalog(catalog, excludedProviders = []) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const records = [];

  for (const group of groups) {
    const provider = String(group.id ?? group.name ?? "");
    if (isExcludedProvider(provider, excludedProviders)) continue;
    const models = Array.isArray(group.models) ? group.models : [];
    for (const m of models) {
      const { reasoningEfforts, defaultEffort, highestEffort } = effortFields(m?.reasoning);
      records.push({
        id: `${provider}/${m.id}`,
        provider,
        model: String(m.id),
        name: String(m.name ?? m.id),
        description: m.description ?? "",
        reasoningEfforts,
        defaultEffort,
        highestEffort,
        tier: undefined
      });
    }
  }

  if (records.length === 0) {
    throw new Error(
      `[subagent-switch] grouped catalog returned no usable models (groups=${groups.length}).`
    );
  }

  return records;
}

function installPureTools(ctx) {
  // DSH throws on duplicate global tool names; use a private name if/when
  // we add diagnostics tools.
}

// ---- subagent spawn interception ----------------------------------------

/**
 * Decide whether the plugin should rewrite a child's model for this spawn.
 *
 * We deliberately do NOT touch:
 *  - continuations (`spec.mode === "continuable"`): those re-run an already
 *    existing child session and must keep the model it was created with.
 *  - spawns that already carry an explicit agentOptions: the user/caller made
 *    a deliberate choice (the subagent tool already lets the model be named),
 *    so our auto-router yields to it unless `forceOverride` is on in config.
 *
 * Otherwise the task text is read from `spec.request.prompt[0].text`
 * (or `spec.label`) and routing proceeds.
 */
function shouldRouteSubagent(spec, opts) {
  if (!spec || typeof spec !== "object") return null;

  // Continuations re-run an existing child; never re-model them.
  if (spec.mode === "continuable") return null;

  const request = spec.request || {};
  const existing = request.agentOptions;

  // Explicit user/model choice: respect it unless forceOverride is set.
  if (existing && typeof existing === "object" && existing.provider && existing.model) {
    if (opts.forceOverride !== true) return null;
  }

  // No prompt at all → nothing to classify.
  const promptText = Array.isArray(request.prompt) && request.prompt.length
    ? String(request.prompt[0]?.text ?? "")
    : "";
  const description = String(spec.label || promptText || "").trim();
  if (!description) return null;

  return { description, promptText };
}

/**
 * Wrap `ctx.subagents.startActivation` so the router chooses the child model.
 *
 * Guardrails (so the wrapper can never break a spawn):
 *  - Only installs when `ctx.subagents` and its `startActivation` exist and are
 *    functions. Otherwise we skip silently (the plugin still works; the panel
 *    and manual `ctx.subagentSwitch.selectForSubtask` remain available).
 *  - On any routing error we fall back to the original call without modifying
 *    the request — the spawn still happens with the caller's model.
 *  - We never re-route continuations or explicit user choices (see
 *    shouldRouteSubagent).
 *  - Optional provider allowlist (`opts.allowedProviders`) is forwarded to the
 *    router so strict sessions that pre-validate routes keep their policy. Note
 *    the subagent tool itself also pre-validates the route against the session
 *    policy; if our chosen route is not allowed the spawn will surface that
 *    error to the caller exactly as it would for a manual choice.
 */
async function installStartActivationWrapper(ctx, router, opts, logFn) {
  if (!ctx || typeof ctx !== "object") return;
  const subagents = safeGet(ctx, "subagents");
  if (!subagents || typeof subagents.startActivation !== "function") {
    logFn("subagent-switch", "subagent interception skipped: ctx.subagents.startActivation not available");
    return;
  }

  const original = subagents.startActivation.bind(subagents);
  const enabled = opts.enabled !== false && opts.autoRouteSubagents !== false;

  subagents.startActivation = async function wrappedStartActivation(spec, ...rest) {
    if (!enabled) return original(spec, ...rest);

    const decision = shouldRouteSubagent(spec, opts);
    if (!decision) return original(spec, ...rest);

    try {
      await router.refreshModels();

      // Re-apply the session policy the host already validated the CALLER's
      // model against. DSH checks `policy.routes` via preflightChildLlmRoute
      // BEFORE startActivation, but we rewrite the model INSIDE it, so the
      // swapped model would otherwise skip that check. We ask the host to
      // supply the current session's allowed providers (see
      // resolveAllowedProviders); if none is configured we route freely.
      const allowed = await resolveAllowedProviders(ctx, opts);

      const result = router.select(
        { category: inferCategory(decision.description), description: decision.description },
        allowed ? { allowedProviders: allowed } : {}
      );
      if (result && result.model) {
        const selection = selectionOf(result.model);
        spec = {
          ...spec,
          request: {
            ...spec.request,
            agentOptions: { ...(spec.request?.agentOptions || {}), ...selection }
          }
        };
        // Spell out whether this was a real capability match or a fallback.
        // Without it the log reads as if every pick were earned, which is
        // exactly the confusion the panel's match column fixes. Three distinct
        // cases hide behind matched===false, and they are NOT the same problem:
        //   score < 0  → every candidate declares itself bad at this domain
        //   score = 0  → nobody declared anything, pure catalog-order tie
        const verdict =
          result.matched === true
            ? `matched +${result.score}`
            : result.matched === false
              ? typeof result.score === "number" && result.score < 0
                ? `no good candidate (all scored ${result.score})`
                : `fallback 0-score tie${typeof result.candidates === "number" ? ` (${result.candidates} tied)` : ""}`
              : "no scoring";
        // Escalation spends real money, so say what it bought: which band was
        // skipped and why. A silent upgrade is impossible to audit afterwards.
        const esc = result.escalated
          ? ` [escalated, skipped ${(result.skipped?.band || []).join("+") || "?"} best ${result.skipped?.modelId || "?"}]`
          : "";
        logFn("subagent-switch", `routed subagent → ${selection.provider}/${selection.model} (${result.reason}; ${verdict})${esc}`);
      } else {
        logFn("subagent-switch", `no route found for subagent; using caller's model`);
      }
    } catch (err) {
      // Never let routing break a spawn. Fall back to the original request.
      logFn("subagent-switch", `subagent routing error, using caller's model: ${err?.message || String(err)}`);
    }

    return original(spec, ...rest);
  };

  logFn("subagent-switch", "subagent model auto-routing installed (intercepting startActivation)");
}

/**
 * Cheap category hint from the task text so the routing table + matching get a
 * signal even before the generic keyword classifier runs inside the router.
 * Returns a normalized category string or "" when nothing matched.
 */
function inferCategory(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";

  // Score each domain by the TOTAL LENGTH of the keywords that hit, then take
  // the winner. Not "first domain whose list contains any match":
  // "业界有哪些成熟实现思路" hits coding via 「实现」 while also hitting
  // research via 「调研」/「思路」 — length-weighted scoring lets the more
  // specific evidence win instead of whichever table entry is listed first.
  // Order in the map is only the tie-break.
  const map = [
    ["coding", DOMAIN_KEYWORDS.coding],
    ["summarize", DOMAIN_KEYWORDS.summarize],
    ["research", DOMAIN_KEYWORDS.research],
    ["writing", DOMAIN_KEYWORDS.writing],
    ["analysis", DOMAIN_KEYWORDS.analysis]
  ];

  let best = "";
  let bestScore = 0;
  for (const [cat, kws] of map) {
    let score = 0;
    for (const k of kws) {
      if (k && t.includes(k)) score += k.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

/**
 * Resolve the set of providers the current session actually allows a child
 * LLM to use, so the auto-router obeys the same `policy.routes` the session
 * enforces for a manual model choice.
 *
 * Why this exists: DSH's subagent tool validates the child route against
 * `session.policy.routes` via `preflightChildLlmRoute` *before*
 * `startActivation`. Because we rewrite the model *inside* startActivation, a
 * naively chosen model would bypass that check and could be rejected (or fail
 * silently) when the real request fires. Rather than guess, we let the host
 * tell us the allowed providers.
 *
 * Resolution order:
 *  1. `opts.resolveAllowedProviders`: an async (or sync) host-supplied hook,
 *     e.g. a function DSH passes in at install that reads the active session's
 *     `policy.routes`. Its return value is normalized to a string[] of
 *     provider ids (or null/empty when the session has no restriction).
 *  2. `opts.allowedProviders`: a static config allowlist (still honored as a
 *     manual fallback / override).
 *
 * Returns null when nothing constrains the route (router then routes freely).
 * A provider already named by the caller is always preserved by
 * shouldRouteSubagent, so this never fights an explicit user choice.
 */
async function resolveAllowedProviders(ctx, opts) {
  // Host-injected dynamic resolver (preferred — reflects the live session).
  const hook = opts && opts.resolveAllowedProviders;
  if (typeof hook === "function") {
    try {
      const value = await hook(ctx);
      const norm = normalizeProviderList(value);
      if (norm) return norm;
    } catch (err) {
      log("subagent-switch", `resolveAllowedProviders hook failed: ${err?.message || String(err)}`);
      // fall through to static config
    }
  }

  // Static config allowlist.
  const staticList = opts && opts.allowedProviders;
  return normalizeProviderList(staticList);
}

/**
 * Normalize whatever a resolver returns into a provider-id string[] or null.
 * Accepts:
 *   - string[] of provider ids
 *   - { routes: [{provider, model}] } shaped like DSH's policy
 *   - null / undefined / empty → null (no constraint)
 */
function normalizeProviderList(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const ids = value.filter((v) => typeof v === "string" && v.length > 0);
    return ids.length ? ids : null;
  }
  // policy.routes shape: [{ provider, model }]
  if (Array.isArray(value.routes)) {
    const ids = value.routes
      .map((r) => r && r.provider)
      .filter((p) => typeof p === "string" && p.length > 0);
    return ids.length ? Array.from(new Set(ids)) : null;
  }
  return null;
}

// ---- quota monitor ------------------------------------------------------

async function startQuotaMonitor(ctx, opts) {
  const intervalMs = Number(opts.quota?.checkIntervalMs) || 300000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

  const timer = setInterval(async () => {
    try {
      await router.refreshModels();
      // Alerts are per PROVIDER now: a balance is an account property, and it
      // is the only number that can actually run dry. (Per-model
      // `remainingCredit` is just the provider balance mirrored onto each row.)
      const below = Number(opts.quota && opts.quota.lowCreditThreshold);
      const threshold = Number.isFinite(below) && below >= 0 ? below : 0;
      const quotas = router.quotaByProvider instanceof Map ? router.quotaByProvider : new Map();
      for (const [provider, quota] of quotas) {
        const remaining = Number(quota?.remaining);
        if (!Number.isFinite(remaining)) continue;
        if (remaining <= 0) {
          log("subagent-switch", `quota exhausted: provider ${provider} (remaining=0) — its models leave the pool`);
        } else if (threshold > 0 && remaining <= threshold) {
          log("subagent-switch", `quota low: provider ${provider} (remaining=${remaining})`);
        }
      }
    } catch (e) {
      log("subagent-switch", `quota monitor error: ${e?.message || String(e)}`);
    }
  }, intervalMs);

  // Don't keep the host process alive just for quota polling; Cordis may not
  // dispose plugins before shutdown.
  if (timer && typeof timer.unref === "function") timer.unref();

  // Cleanup must go through Cordis's `ctx.effect`, which is the only disposal
  // hook guaranteed on this build. `ctx.on('dispose', ...)` does not exist on
  // the Cordis context and threw a TypeError here.
  const dispose = () => clearInterval(timer);
  const effect = safeGet(ctx, "effect");
  const on = safeGet(ctx, "on");
  if (typeof effect === "function") {
    effect.call(ctx, () => dispose);
  } else if (typeof on === "function") {
    on.call(ctx, "dispose", dispose);
  } else {
    // No disposal hook available: still monitor, but say so rather than crash.
    log("subagent-switch", "quota monitor: no disposal hook (ctx.effect missing); interval will not be cleared on unload");
  }
}

// ---- UI panel data bridge (HTTP route) -----------------------------------
//
// The browser half cannot call ctx.listModels() or this router, so the host
// exposes them over HTTP — the exact pattern the working @local/model-route
// plugin uses on this machine:
//   ctx.inject(['webServer']) / ctx.get('webServer')
//   server.register({ kind: 'prefix', path, handler })
//
// Route: /subagent-switch-api
//   GET  /models   → { models: [...], tiers: [...] }   (panel rows)
//   GET  /state    → { title, defaultModel, routingTable, blacklist, autoFallback, ... }
//   GET  /select?category=&description=  → the routing decision for a task
//   GET  /routes   → the same decision for every known category (preview table)
//   POST /priority { id, priority }      → set/replace one model's manual priority
//   POST /routable { id, routable }      → force-allow (or release) one model
//
// The two POST endpoints only ever write the plugin's OWN overrides file
// (~/.dsh/subagent-switch-overrides.json), never the DSH profile config.
//
// Every request re-reads the live model list, so opening the panel always
// shows current state without a restart.
const API_ROUTE = "/subagent-switch-api";

// The categories the preview table walks. Kept in one place so `/routes` and
// the panel cannot drift apart; these are exactly the domains the task
// classifier and the preset vocabulary use.
const ROUTE_PREVIEW_CATEGORIES = Object.freeze([
  "coding",
  "research",
  "writing",
  "summarize",
  "analysis",
  "general"
]);

/**
 * Turn a `Router.select()` result into the JSON shape the panel reason about.
 *
 * The important field is `matched`:
 *  - `true`  → the winner has a real `goodAt` claim on the task domain
 *  - `false` → nothing in the band claimed it, so this is a 0-score tie-break.
 *    Reporting that as a "match" would be a lie, and it is precisely how a
 *    small flash model ends up looking like the right answer for research.
 *  - `null`  → the choice did not go through scoring at all (routing table).
 *
 * @param {object} routerRef
 * @param {{ category?: string, description?: string }} subtask
 */
function describeSelection(routerRef, subtask) {
  const result = routerRef.select(subtask);
  const m = result.model;
  return {
    category: String(subtask?.category || "").toLowerCase() || "general",
    reason: result.reason,
    tier: result.tier,
    score: typeof result.score === "number" ? result.score : null,
    matched: result.matched === true ? true : result.matched === false ? false : null,
    candidates: typeof result.candidates === "number" ? result.candidates : null,
    // Escalation (option B): the cheap band had nothing that claims this domain,
    // so the router paid more for a real match. `skipped` records exactly what
    // the money bought over, so the panel can justify the higher price instead
    // of silently spending 4-8x.
    escalated: result.escalated === true,
    skipped: result.skipped
      ? {
          band: result.skipped.band || [],
          modelId: result.skipped.modelId || "",
          modelName: result.skipped.modelName || "",
          score: typeof result.skipped.score === "number" ? result.skipped.score : null,
          candidates: typeof result.skipped.candidates === "number" ? result.skipped.candidates : null
        }
      : null,
    // Manual priority that actually decided this pick (0 = automatic), and
    // whether it did. `pinned` is the panel's signal that the answer came from
    // the user's own ranking, not from capability tags.
    priority: typeof result.priority === "number" ? result.priority : 0,
    pinned: result.pinned === true,
    model: m
      ? {
          id: m.id,
          name: m.name,
          provider: m.provider,
          tier: m.rawTier || m.tier,
          priceMultiplier: m.priceMultiplier === undefined ? null : m.priceMultiplier,
          goodAt: m.goodAt || [],
          badAt: m.badAt || [],
          tagSource: m.tagSource || ""
        }
      : null
  };
}

// Set by installPanelApi once the host web server is known. The router's model
// source calls it so every refresh also refreshes per-provider balances; it
// stays null when the web server is unavailable, and quota simply reads as
// unknown instead of the plugin failing.
let readQuotasRef = null;

function installPanelApi(ctx, routerRef, opts) {
  const getter = safeGet(ctx, "get");
  const server =
    (typeof getter === "function" ? getter.call(ctx, "webServer") : undefined) ||
    safeGet(ctx, "webServer");
  if (!server || typeof server.register !== "function") {
    log("subagent-switch", `no webServer; panel API ${API_ROUTE} not mounted (panel will show a read error)`);
    return;
  }

  const sendJson = (res, status, value) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(value));
  };

  // Balance reads go through the host's OWN web server origin, so no extra
  // config is needed: `getOrigin()` is already bound by the time apply() runs.
  let lastQuotaFailures = [];
  const readQuotas = async () => {
    try {
      const origin = typeof server.getOrigin === "function" ? server.getOrigin() : undefined;
      if (!origin) return { ok: false, failures: ["no web server origin"] };
      const result = await routerRef.refreshQuotas(origin);
      lastQuotaFailures = result.failures || [];
      return result;
    } catch (err) {
      lastQuotaFailures = [String(err?.message || err)];
      log("subagent-switch", `quota refresh failed: ${err?.stack || err?.message || err}`);
      return { ok: false, failures: lastQuotaFailures };
    }
  };
  readQuotasRef = readQuotas;

  const state = () => ({
    title: opts.panelTitle || "子代理模型切换",
    defaultModel: opts.defaultModel || "",
    routingTable: Array.isArray(opts.routingTable) ? opts.routingTable : [],
    // Prefer the router's live list: entries get canonicalized to `provider/model`
    // ids on first refresh, and enable()/disable() update it at runtime.
    blacklist: Array.isArray(routerRef && routerRef.blacklist)
      ? routerRef.blacklist
      : Array.isArray(opts.blacklist)
      ? opts.blacklist
      : [],
    autoFallback: Boolean(opts.quota && opts.quota.autoFallbackOnExhaustion),
    autoRouteSubagents: opts.autoRouteSubagents !== false,
    // Surface the exclusion so a shorter list never looks like a bug: the panel
    // prints "已忽略 provider：cline" instead of silently dropping 459 models.
    excludedProviders: resolveExcludedProviders(opts.excludedProviders),
    // The eligibility gate: only account-backed providers may spend a
    // subagent — those whose balance we can read, plus those the user signed
    // into (trae/deepseek-account publish no balance route). Everything else is
    // listed but not routable — the panel says so instead of hiding them.
    quotaAwareProviders: (routerRef && routerRef.quotaAwareProviders) || resolveQuotaAwareProviders(opts.quotaAwareProviders),
    accountBackedProviders: (routerRef && routerRef.accountBackedProviders) || resolveAccountBackedProviders(opts.accountBackedProviders),
    requireQuotaAware: !(routerRef && routerRef.requireQuotaAware === false),
    // Escalation switch + threshold, so the panel can state the current spending
    // posture instead of leaving "why did it pick an expensive model" unanswered.
    escalateOnMiss: !(routerRef && routerRef.escalateOnMiss === false),
    escalateMinScore:
      routerRef && Number.isFinite(routerRef.escalateMinScore) ? routerRef.escalateMinScore : 1,
    routableOverrides: (routerRef && routerRef.routableOverrides) || [],
    // Band grouping, so the panel can explain why a free model did not win:
    // "free" and "free_quota" are ranked together by capability, not by price.
    cheapBand: (routerRef && routerRef.cheapBand) || DEFAULT_CHEAP_BAND,
    tierBands: (routerRef && routerRef.tierBands) || [],
    quotaByProvider: routerRef && routerRef.quotaByProvider
      ? Object.fromEntries(routerRef.quotaByProvider)
      : {},
    // Manual overrides live in their own file so one delete restores fully
    // automatic behaviour. The panel shows the path so "where is this stored"
    // and "how do I undo it" have real answers.
    overridesPath: (routerRef && routerRef.overridesPath) || opts.overridesPath || defaultOverridesPath(),
    priority: routerRef && routerRef.overrides ? { ...routerRef.overrides.priority } : {},
    forceRoutable: routerRef && routerRef.overrides ? Object.keys(routerRef.overrides.routable) : [],
    priorityRange: [PRIORITY_MIN, PRIORITY_MAX]
  });

  const models = async () => {
    await routerRef.refreshModels();
    return {
      models: (routerRef.models || []).map((m) => ({
        // `id` is the canonical blacklist / defaultModel key. Display names
        // collide once the price suffix is stripped, so the UI must key on id.
        id: m.id || "",
        name: m.name,
        plainName: m.plainName || "",
        provider: m.provider,
        tier: m.rawTier || "paid",
        status: m.status,
        goodAt: m.goodAt || [],
        badAt: m.badAt || [],
        priceMultiplier: m.priceMultiplier === undefined ? null : m.priceMultiplier,
        // Where the tags came from: "" = none, "preset" = the built-in family
        // table (a guess), "config" = hand-written in config.tags (trusted).
        tagSource: m.tagSource || "",
        // Why a model is (not) in the routing pool. "no-quota-source" means its
        // provider exposes no readable balance — listed, tagged, blacklistable,
        // but never chosen automatically.
        routable: m.routable !== false,
        gateReason: m.gateReason || "",
        // Manual priority (0 = automatic). Larger wins, and it beats the
        // capability score on purpose — see Router._rank().
        priority: typeof m.priority === "number" ? m.priority : 0,
        // True when this model is only routable because the user pressed
        // 「放行」 on it (its provider still has no readable balance).
        forceRoutable: routerRef && routerRef.overrides
          ? Boolean(routerRef.overrides.routable && routerRef.overrides.routable[m.id])
          : false,
        quota:
          m.remainingCredit === undefined || m.remainingCredit === -1
            ? "未知"
            : m.remainingCredit === 0
            ? "用尽"
            : `剩余 ${m.remainingCredit}`
      })),
      tiers: routerRef.tierOrder || [],
      quotaFailures: lastQuotaFailures
    };
  };

  // Read a small JSON body (the panel only ever posts a model id + a number or
  // a boolean). Bounded so a stray request cannot balloon memory; anything
  // malformed becomes `{}` rather than a 500.
  const readJsonBody = (req) => new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) finish({});
    });
    req.on("end", () => {
      try {
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish({});
      }
    });
    req.on("error", () => finish({}));
  });

  // Persist whatever the router currently holds. The router is the single
  // source of truth in memory; this only mirrors it to disk, so a failed write
  // still leaves the running plugin consistent (the change is live, just not
  // durable) and the response says which.
  const persistOverrides = (next) => {
    routerRef.setOverrides(next);
    const file = routerRef.overridesPath || overridesPath || defaultOverridesPath();
    return writeOverrides(routerRef.overrides, file);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://subagent-switch.local");
    const sub = url.pathname.startsWith(API_ROUTE)
      ? url.pathname.slice(API_ROUTE.length) || "/"
      : url.pathname;

    try {
      // Write endpoints. GET stays read-only; only these two mutate anything,
      // and they only ever touch the plugin's own overrides file.
      if (req.method === "POST") {
        if (sub === "/priority") {
          const body = await readJsonBody(req);
          const modelId = String(body.id || "").trim();
          const value = Number(body.priority);
          if (!modelId) return sendJson(res, 400, { error: "id is required" });
          if (!Number.isFinite(value)) return sendJson(res, 400, { error: "priority must be a number" });
          const next = withPriority(routerRef.overrides, modelId, value);
          const saved = persistOverrides(next);
          return sendJson(res, 200, {
            ok: true,
            saved: saved.ok,
            file: saved.file,
            error: saved.error,
            priority: routerRef.overrides.priority[modelId] || 0,
            pinned: pinnedList(routerRef.overrides)
          });
        }
        if (sub === "/routable") {
          const body = await readJsonBody(req);
          const modelId = String(body.id || "").trim();
          if (!modelId) return sendJson(res, 400, { error: "id is required" });
          const next = withRoutable(routerRef.overrides, modelId, body.routable === true);
          const saved = persistOverrides(next);
          return sendJson(res, 200, {
            ok: true,
            saved: saved.ok,
            file: saved.file,
            error: saved.error,
            forceRoutable: Boolean(routerRef.overrides.routable[modelId])
          });
        }
        return sendJson(res, 404, { error: "no such endpoint" });
      }

      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      if (sub === "/" || sub === "/state") return sendJson(res, 200, state());
      if (sub === "/models") return sendJson(res, 200, await models());
      if (sub === "/select") {
        const subtask = {
          category: url.searchParams.get("category") || "",
          description: url.searchParams.get("description") || ""
        };
        await routerRef.refreshModels();
        return sendJson(res, 200, describeSelection(routerRef, subtask));
      }
      if (sub === "/routes") {
        // One shot for the panel's preview table: what every task category
        // would actually get right now, without the caller having to know the
        // category list. Refresh once, then rank each category against the
        // same snapshot.
        await routerRef.refreshModels();
        const rows = ROUTE_PREVIEW_CATEGORIES.map((category) => ({
          category,
          ...describeSelection(routerRef, { category, description: "" })
        }));
        return sendJson(res, 200, { rows });
      }
      return sendJson(res, 404, { error: "no such endpoint" });
    } catch (err) {
      sendJson(res, 500, { error: (err && err.message) || String(err) });
    }
  };

  // Mounting MUST happen synchronously inside apply(), before any await.
  //
  // Cordis scopes `ctx.effect` to the synchronous body of apply(). The previous
  // version awaited installStartActivationWrapper (an async function) first, so
  // by the time ctx.effect ran the effect scope was already closed: the route
  // was silently never registered and the panel reported HTTP 404, while the
  // browser half still rendered. @local/model-route works precisely because its
  // apply() is fully synchronous. Keep it that way here.
  let mounted = false;
  try {
    const effect = safeGet(ctx, "effect");
    if (typeof effect === "function") {
      effect.call(ctx, () => server.register({ kind: "prefix", path: API_ROUTE, handler }));
      mounted = true;
    }
  } catch (err) {
    log("subagent-switch", `ctx.effect mount failed: ${err?.message || String(err)}`);
  }

  if (!mounted) {
    // Fallback: register without a disposal scope. The route then outlives the
    // plugin, which is acceptable — a missing panel is worse than a stale one.
    try {
      server.register({ kind: "prefix", path: API_ROUTE, handler });
      mounted = true;
      log("subagent-switch", "panel API mounted WITHOUT disposal scope (fallback)");
    } catch (err) {
      log("subagent-switch", `could not mount panel API: ${err?.message || String(err)}`);
    }
  }

  if (mounted) log("subagent-switch", `panel API mounted: ${API_ROUTE}`);
}

// ---- logging helper -------------------------------------------------------
//
// The Electron main process console is not reachable from here, so every log
// line also goes to a file next to the profile. That file is the only way to
// tell whether the HOST half of this plugin actually ran: the browser half
// always renders (it ships its own bundle), but if apply() throws early the
// HTTP route never mounts and the panel just shows a 404.
const LOG_FILE = resolveLogFile();

function resolveLogFile() {
  // Resolved lazily at load so the path follows whatever profile the user
  // actually runs; never hardcode a home directory.
  try {
    return join(homedir(), ".dsh", "subagent-switch-host.log");
  } catch {
    return undefined;
  }
}

function log(source, message) {
  const ts = new Date().toISOString();
  const line = `[subagent-switch ${source}] ${ts} ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    /* logging must never break the plugin */
  }
}

// Export pure parts for unit tests.
export { Router } from "./router.js";
export { parseTags, mergeTags } from "./tags.js";
export { defaultTaskClassifier, installPanelApi, API_ROUTE, readModelListFromHost, safeGet };
export { shouldRouteSubagent, inferCategory, installStartActivationWrapper, resolveAllowedProviders, normalizeProviderList };
export { DOMAIN_KEYWORDS };
export { unwrapPluginConfig, resolvePluginConfig, PLUGIN_KEY };

