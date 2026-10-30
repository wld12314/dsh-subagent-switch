// Unit tests for the plugin's pure logic.
//
// Run with: node --test test/unit.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeModel, applyPlanFilters, rankWithinTier, resolveTierOrder, resolveTierBands, inferTier, selectionOf, parsePriceMultiplier, stripPriceSuffix, modelMatchesKey, findModel, isBlacklisted, blacklistKeys, DEFAULT_EXCLUDED_PROVIDERS, resolveExcludedProviders, isExcludedProvider, routeGate, ROUTE_GATE, hasPositiveMatch } from "../lib/models.js";
import { parseTags, normalizeTag, mergeTags, canonicalDomain, DOMAIN_ALIASES } from "../lib/tags.js";
import { estimateCost, isCreditSafe, pollQuota, QUOTA_SOURCES, DEFAULT_QUOTA_AWARE_PROVIDERS, resolveQuotaAwareProviders, isQuotaAwareProvider, readProviderQuotas, DEFAULT_ACCOUNT_BACKED_PROVIDERS, resolveAccountBackedProviders, isAccountBackedProvider } from "../lib/quota.js";
import { Router } from "../lib/router.js";
import { shouldRouteSubagent, inferCategory, installStartActivationWrapper, resolveAllowedProviders, normalizeProviderList, safeGet, readModelListFromHost, defaultTaskClassifier, unwrapPluginConfig, resolvePluginConfig, PLUGIN_KEY } from "../lib/apply.js";
import { matchPreset, applyPreset, applyPresets } from "../lib/presets.js";
import {
  emptyOverrides,
  sanitizeOverrides,
  clampPriority,
  readOverrides,
  writeOverrides,
  withPriority,
  withRoutable,
  priorityOf,
  isRoutableOverride,
  pinnedList,
  PRIORITY_MIN,
  PRIORITY_MAX
} from "../lib/overrides.js";

test("normalizeModel trims name and lowercases nothing but keeps tags", () => {
  const m = normalizeModel({ name: "  Qwen Coder  ", provider: " ollama ", goodAt: [" coding ", "   "], badAt: [" analysis"] });
  assert.equal(m.name, "Qwen Coder");
  assert.equal(m.provider, "ollama");
  assert.deepEqual(m.goodAt, ["coding"]);
  assert.deepEqual(m.badAt, ["analysis"]);
});

test("applyPlanFilters marks excluded and unavailable models", () => {
  const blacklist = ["model-b"];
  const m1 = normalizeModel({ name: "model-b" });
  const m2 = normalizeModel({ name: "model-c" });

  const r1 = applyPlanFilters(m1, blacklist, true);
  const r2 = applyPlanFilters(m2, blacklist, true);
  assert.equal(r1.status, "excluded");
  assert.equal(r2.status, "available");
});

test("applyPlanFilters marks unavailable when directory misses the model", () => {
  const m = normalizeModel({ name: "model-d" });
  const r = applyPlanFilters(m, [], false);
  assert.equal(r.status, "unavailable");
});

test("blacklist matches by id and bare model id, not by colliding plain name", () => {
  // Two real catalog entries that both display as "Hy3 · xN.NN" once the price
  // suffix is stripped, but are different models.
  const a = normalizeModel({ id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00" });
  const b = normalizeModel({ id: "workbuddy/hy3-x", provider: "workbuddy", model: "hy3-x", name: "Hy3 · x0.05" });

  // exclude exactly one of them by id
  const byId = applyPlanFilters(b, ["workbuddy/hy3-x"], true);
  assert.equal(byId.status, "excluded");
  assert.equal(applyPlanFilters(a, ["workbuddy/hy3-x"], true).status, "available");

  // ... and by bare model id
  assert.equal(applyPlanFilters(a, ["hy3"], true).status, "excluded");
  assert.equal(applyPlanFilters(b, ["hy3"], true).status, "available");

  // legacy configs blacklisting the full display name still work
  assert.equal(applyPlanFilters(a, ["Hy3 · x0.00"], true).status, "excluded");
  assert.equal(applyPlanFilters(b, ["Hy3 · x0.00"], true).status, "available");

  // plainName alone must NOT match, precisely because it collides
  assert.equal(applyPlanFilters(a, ["Hy3"], true).status, "available");
  assert.equal(applyPlanFilters(b, ["Hy3"], true).status, "available");
});

test("modelMatchesKey / findModel resolve a key to the right catalog entry", () => {
  const models = [
    normalizeModel({ id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00" }),
    normalizeModel({ id: "workbuddy/hy3-x", provider: "workbuddy", model: "hy3-x", name: "Hy3 · x0.05" })
  ];
  assert.equal(findModel(models, "hy3-x").id, "workbuddy/hy3-x");
  assert.equal(findModel(models, "workbuddy/hy3").id, "workbuddy/hy3");
  assert.equal(findModel(models, "nope"), undefined);
});

test("resolveTierOrder keeps the configured order and stamps unknown at the end", () => {
  const ordered = resolveTierOrder(["paid", "free", "unknown-tier"]);
  assert.deepEqual(ordered, ["paid", "free", "unknown-tier"]);
});

test("parseTags splits on commas, semicolons, newlines", () => {
  assert.deepEqual(parseTags("coding;debug\nanalysis"), ["coding", "debug", "analysis"]);
  assert.deepEqual(parseTags(""), []);
});

test("normalizeTag rejects empty and invalid tokens", () => {
  assert.equal(normalizeTag("  "), null);
  assert.equal(normalizeTag("bad token!"), null);
  assert.ok(normalizeTag("math"));
});

test("mergeTags keeps good and removes contradictory bad", () => {
  const out = mergeTags(["coding"], ["analysis"], { goodAt: ["math"], badAt: ["coding"] });
  assert.deepEqual(out.goodAt, ["coding", "math"]);
  assert.deepEqual(out.badAt, ["analysis"]);
});

test("estimateCost is >= 0 and finite for a coding task", () => {
  const cost = estimateCost({ category: "coding", estimatedTokens: 120000, searchDepth: 2, needsTools: true });
  assert.ok(cost >= 0);
  assert.ok(Number.isFinite(cost));
});

test("isCreditSafe blocks empty quota", () => {
  const c = { remainingCredit: 0 };
  assert.equal(isCreditSafe(c, 10)["ok"], false);
});

test("pollQuota default is UNKNOWN (deliberately empty)", () => {
  assert.equal(pollQuota({ name: "x" }), -1);
});

test("Router selects a free model before paid in a same-tier match", async () => {
  const models = [
    { name: "fast-free", provider: "workbuddy", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 100 },
    { name: "strong-paid", provider: "workbuddy", tier: "paid", goodAt: ["coding", "research"], badAt: [], remainingCredit: 100 }
  ];

  const source = {
    async getModelList() {
      return models.map((m) => ({ ...m, goodAt: m.goodAt, badAt: m.badAt }));
    }
  };

  const router = new Router({
    modelTiers: ["free", "free_quota", "paid"],
    defaultModel: ""
  }, source, () => ({ required: ["coding"], optional: [] }));

  await router.refreshModels();
  const result = router.select({ category: "coding" });

  assert.ok(result.model);
  // free should win before paid, regardless of paid's richer tag set.
  assert.equal(result.model.name, "fast-free");
});

test("Router trusts better scoring when tiers are equal", async () => {
  const models = [
    { name: "weak", provider: "workbuddy", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 100 },
    { name: "strong", provider: "workbuddy", tier: "free", goodAt: ["coding", "research"], badAt: [], remainingCredit: 100 }
  ];

  const source = {
    async getModelList() {
      return models.map((m) => ({ ...m, goodAt: m.goodAt, badAt: m.badAt }));
    }
  };

  const router = new Router({ modelTiers: ["free"], defaultModel: "" }, source, () => ({ required: ["coding", "research"], optional: [] }));

  await router.refreshModels();
  const result = router.select({ category: "coding" });

  assert.equal(result.model.name, "strong");
});

test("Router honors explicit default when no tier matches", async () => {
  const source = {
    async getModelList() {
      return [{ name: "anything", provider: "workbuddy", goodAt: [], badAt: [], remainingCredit: 100 }];
    }
  };

  const router = new Router({
    modelTiers: ["free"],
    defaultModel: "anything"
  }, source, () => ({ required: ["nonexistent-domain"], optional: [] }));

  await router.refreshModels();
  const result = router.select({ category: "general" });

  assert.equal(result.model.name, "anything");
});

test("Router returns no-models-available when nothing is usable", async () => {
  const source = {
    async getModelList() {
      return [{ name: "x", provider: "workbuddy", goodAt: [], badAt: [], remainingCredit: 0 }];
    }
  };

  const router = new Router({ modelTiers: ["free"], defaultModel: "missing" }, source, () => ({ required: [], optional: [] }));
  await router.refreshModels();
  const result = router.select({ category: "general" });

  assert.equal(result.model, null);
  assert.equal(result.reason, "no-models-available");
});

test("Router.disable/enable take effect immediately (status is recomputed)", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "p/a", provider: "workbuddy", model: "a", name: "a", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 100 },
        { id: "p/b", provider: "workbuddy", model: "b", name: "b", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();

  // both available → first one wins
  assert.equal(router.select({ category: "coding" }).model.model, "a");

  // disable by canonical id; it must leave the pool right away
  router.disable(["p/a"]);
  assert.equal(router.models.find((m) => m.id === "p/a").status, "excluded");
  assert.equal(router.select({ category: "coding" }).model.model, "b");

  // enable again by bare model id; it must come back
  router.enable(["a"]);
  assert.equal(router.models.find((m) => m.id === "p/a").status, "available");
});

test("Router.setBlacklist canonicalizes entries to provider/model ids", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "free", goodAt: [], badAt: [], remainingCredit: 100 },
        { id: "w/hy3-x", provider: "workbuddy", model: "hy3-x", name: "Hy3 · x0.05", tier: "free", goodAt: [], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free"] }, source, () => ({ required: [], optional: [] }));
  await router.refreshModels();

  // a bare model id resolves to the canonical id
  router.setBlacklist(["hy3-x"]);
  assert.deepEqual(router.blacklist, ["w/hy3-x"]);
  assert.equal(router.models.find((m) => m.id === "w/hy3-x").status, "excluded");
  assert.equal(router.models.find((m) => m.id === "w/hy3").status, "available");

  // an unresolvable entry is kept verbatim rather than dropped
  router.setBlacklist(["totally-unknown"]);
  assert.deepEqual(router.blacklist, ["totally-unknown"]);
});

test("inferTier marks local providers as free and is null-safe", () => {
  assert.equal(inferTier("ollama/qwen", "ollama", "qwen2.5-coder"), "free");
  assert.equal(inferTier("deepseek/chat", "deepseek", "chat"), "paid");
  // no provider field; "trial" in the description is treated as quota-backed
  assert.equal(inferTier("x/y", undefined, "y", "free trial"), "free_quota");
  // null provider must not throw
  assert.equal(inferTier("z/w", undefined, "w"), "paid");
});

test("selectionOf projects a directory record into the subagent model shape", () => {
  const rec = { provider: "ollama", model: "qwen2.5-coder", name: "qwen2.5-coder", defaultEffort: "low" };
  assert.deepEqual(selectionOf(rec), { provider: "ollama", model: "qwen2.5-coder", reasoningEffort: "low" });
  const noEffort = { provider: "deepseek", model: "chat" };
  assert.deepEqual(selectionOf(noEffort), { provider: "deepseek", model: "chat" });
});

test("parsePriceMultiplier reads the ` · xN.NN` suffix providers bake into the name", () => {
  assert.equal(parsePriceMultiplier("Hy3 · x0.00"), 0);
  assert.equal(parsePriceMultiplier("Hy4 preview · x0.29"), 0.29);
  assert.equal(parsePriceMultiplier("Kimi-K3 · x1.62"), 1.62);
  // alternate separators the display layer may use
  assert.equal(parsePriceMultiplier("GLM-5.3 • x0.69"), 0.69);
  assert.equal(parsePriceMultiplier("Deepseek-V4-Pro | x0.51"), 0.51);
  // no price suffix → null (must not mistake a version number for a price)
  assert.equal(parsePriceMultiplier("GLM-5.3"), null);
  assert.equal(parsePriceMultiplier("v4.1-flash"), null);
  assert.equal(parsePriceMultiplier(""), null);
});

test("stripPriceSuffix returns the plain model name", () => {
  assert.equal(stripPriceSuffix("Hy3 · x0.00"), "Hy3");
  assert.equal(stripPriceSuffix("Hy4 preview · x0.29"), "Hy4 preview");
  assert.equal(stripPriceSuffix("GLM-5.3"), "GLM-5.3");
});

test("inferTier uses the price suffix before keyword heuristics", () => {
  // x0.00 = genuinely free, even though the provider is not local and the
  // name carries no "free"/"trial" hint.
  assert.equal(inferTier("workbuddy/hy3", "workbuddy", "Hy3 · x0.00"), "free");
  // cheap but not free → free_quota (default cutoff 0.15)
  assert.equal(inferTier("workbuddy/dsv4f", "workbuddy", "Deepseek-V4.1-Flash · x0.11"), "free_quota");
  // expensive → paid
  assert.equal(inferTier("workbuddy/kimi", "workbuddy", "Kimi-K3 · x1.62"), "paid");
  // a name that only LOOKS like it has a price is not parsed as one
  assert.equal(inferTier("z/glm", "workbuddy", "GLM-5.3"), "paid");
  // explicit tierMap beats the price signal, keyed by id and by plain name
  assert.equal(inferTier("workbuddy/hy3", "workbuddy", "Hy3 · x0.00", "", { "workbuddy/hy3": "paid" }), "paid");
  assert.equal(inferTier("workbuddy/hy3", "workbuddy", "Hy3 · x0.00", "", { "Hy3": "paid" }), "paid");
  // custom pricing thresholds are honored
  assert.equal(
    inferTier("workbuddy/kimi", "workbuddy", "Kimi-K3 · x1.62", "", {}, { quotaMultiplierMax: 2 }),
    "free_quota"
  );
});

test("normalizeModel keeps the display name and exposes plainName + priceMultiplier", () => {
  const m = normalizeModel({ name: "Hy3 · x0.00", provider: "workbuddy", model: "hy3" });
  assert.equal(m.name, "Hy3 · x0.00");
  assert.equal(m.plainName, "Hy3");
  assert.equal(m.priceMultiplier, 0);
  const plain = normalizeModel({ name: "GLM-5.3" });
  assert.equal(plain.priceMultiplier, undefined);
});

test("matchPreset tags the model families that exist in a real catalog", () => {
  const glm = matchPreset({ model: "glm-5.3", name: "GLM-5.3 · x0.69" });
  assert.ok(glm.goodAt.includes("coding"));
  assert.ok(glm.badAt.includes("vision"));

  // specific rules must win over the broader family rule
  const flash = matchPreset({ model: "glm-5.3-flash", name: "GLM-5.3-Flash · x0.08" });
  assert.ok(flash.goodAt.includes("summarize"));
  assert.ok(!flash.goodAt.includes("agentic"));

  const hy3 = matchPreset({ model: "hy3", name: "Hy3 · x0.00" });
  assert.ok(hy3.badAt.includes("coding"));

  // unknown family → no preset
  assert.equal(matchPreset({ model: "totally-unknown", name: "Totally Unknown" }), null);
});

test("applyPreset fills only empty tag sides so hand-written tags win", () => {
  // no own tags → preset fills both sides
  const filled = applyPreset({ model: "kimi-k3-1", name: "Kimi-K3 · x1.62", goodAt: [], badAt: [] });
  assert.ok(filled.goodAt.length > 0);

  // own goodAt present → preset must not touch it
  const own = applyPreset({ model: "kimi-k3-1", name: "Kimi-K3", goodAt: ["writing"], badAt: [] });
  assert.deepEqual(own.goodAt, ["writing"]);

  // a domain can never sit on both sides
  const both = applyPreset({ model: "hy3", name: "Hy3", goodAt: ["coding"], badAt: [] });
  assert.ok(!both.badAt.includes("coding"));
});

test("applyPresets covers every real catalog entry without crashing", () => {
  const catalog = [
    { model: "hy4-preview", name: "Hy4 preview · x0.29" },
    { model: "hy3", name: "Hy3 · x0.00" },
    { model: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash · x0.11" },
    { model: "space-bunny", name: "Space-Bunny · x0.08" },
    { model: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro · x0.13" }
  ].map((r) => ({ ...r, goodAt: [], badAt: [] }));
  const out = applyPresets(catalog);
  assert.equal(out.length, catalog.length);
  for (const m of out) assert.ok(Array.isArray(m.goodAt) && Array.isArray(m.badAt));
  // at least the coding-capable ones got a coding tag
  assert.ok(out.find((m) => m.model === "deepseek-v4.1-flash").goodAt.includes("coding"));
});

test("shouldRouteSubagent respects continuations and explicit user choices", () => {
  // continuation → never route
  assert.equal(shouldRouteSubagent({ mode: "continuable", request: { prompt: [{ text: "do something" }] } }, {}), null);

  // explicit provider+model, no forceOverride → never route
  assert.equal(shouldRouteSubagent({ request: { prompt: [{ text: "x" }], agentOptions: { provider: "deepseek", model: "chat" } } }, {}), null);

  // explicit provider+model WITH forceOverride → route
  const d = shouldRouteSubagent({ label: "fix the bug in auth", request: { prompt: [{ text: "fix the bug in auth" }], agentOptions: { provider: "deepseek", model: "chat" } } }, { forceOverride: true });
  assert.ok(d && d.description.includes("fix the bug"));

  // normal spawn with prompt → route, task text read from prompt[0]
  const normal = shouldRouteSubagent({ label: "Write a report", request: { prompt: [{ text: "Write a report about whales" }] } }, {});
  assert.ok(normal && normal.promptText.includes("whales"));

  // no prompt and no label → no task to classify
  assert.equal(shouldRouteSubagent({ request: {} }, {}), null);
});

test("inferCategory maps obvious task text to a category", () => {
  assert.equal(inferCategory("refactor this function and debug the bug"), "coding");
  assert.equal(inferCategory("research the market and search the web"), "research");
  assert.equal(inferCategory("summarize the meeting notes"), "summarize");
  assert.equal(inferCategory("please do the thing"), "");
});

test("installStartActivationWrapper injects the routed model and never blocks on error", async () => {
  const calls = [];
  const fakeCtx = {
    subagents: {
      startActivation: async (spec) => {
        calls.push(spec);
        return { childId: "child-1" };
      }
    }
  };

  // a router that always picks a fixed model
  let refreshed = 0;
  const router = {
    async refreshModels() { refreshed++; },
    select() { return { model: { provider: "ollama", model: "qwen2.5-coder", name: "qwen2.5-coder", defaultEffort: "low" } }; }
  };
  const logCalls = [];
  const logFn = (_s, m) => logCalls.push(m);

  await installStartActivationWrapper(fakeCtx, router, { autoRouteSubagents: true, enabled: true }, logFn);

  // spawn a fresh subagent asking for coding work
  const spec = { provider: "default", label: "write a function", request: { prompt: [{ text: "write a function that sorts" }] } };
  const res = await fakeCtx.subagents.startActivation(spec);

  assert.equal(res.childId, "child-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.agentOptions.provider, "ollama");
  assert.equal(calls[0].request.agentOptions.model, "qwen2.5-coder");
  assert.equal(calls[0].request.agentOptions.reasoningEffort, "low");
  assert.ok(refreshed >= 1);

  // An explicit user model choice is preserved (no forceOverride)
  const spec2 = { provider: "default", label: "x", request: { prompt: [{ text: "x" }], agentOptions: { provider: "deepseek", model: "chat" } } };
  await fakeCtx.subagents.startActivation(spec2);
  assert.equal(calls[1].request.agentOptions.model, "chat");

  // If the router throws, the spawn still goes through unchanged.
  const routerBroken = { async refreshModels() { throw new Error("boom"); }, select() { throw new Error("boom"); } };
  const fakeCtx2 = {
    subagents: {
      startActivation: async (s) => { calls.push(s); return { childId: "child-2" }; }
    }
  };
  await installStartActivationWrapper(fakeCtx2, routerBroken, { autoRouteSubagents: true, enabled: true }, logFn);
  const spec3 = { provider: "default", label: "y", request: { prompt: [{ text: "y" }] } };
  const res3 = await fakeCtx2.subagents.startActivation(spec3);
  assert.equal(res3.childId, "child-2");
  assert.equal(calls[2].request.agentOptions, undefined); // untouched
});

test("installStartActivationWrapper is a no-op when startActivation is missing", async () => {
  const logCalls = [];
  const fakeCtx = { subagents: {} }; // no startActivation
  await installStartActivationWrapper(fakeCtx, {}, { autoRouteSubagents: true }, (_s, m) => logCalls.push(m));
  assert.ok(!("startActivation" in fakeCtx.subagents));
  assert.ok(logCalls.some((m) => m.includes("skipped")));
});

test("normalizeProviderList accepts ids array, policy.routes shape, or null", () => {
  assert.deepEqual(normalizeProviderList(["deepseek", "ollama"]), ["deepseek", "ollama"]);
  // DSH policy.routes shape: pick out provider ids, dedup
  assert.deepEqual(normalizeProviderList({ routes: [{ provider: "deepseek", model: "chat" }, { provider: "deepseek", model: "coder" }] }), ["deepseek"]);
  assert.equal(normalizeProviderList(null), null);
  assert.equal(normalizeProviderList([]), null);
  assert.equal(normalizeProviderList({}), null);
});

test("resolveAllowedProviders prefers the host hook over static config", async () => {
  const ctx = {};
  // host hook returns policy.routes shape
  const opts = {
    resolveAllowedProviders: async () => ({ routes: [{ provider: "deepseek", model: "chat" }] }),
    allowedProviders: ["ollama"]
  };
  const got = await resolveAllowedProviders(ctx, opts);
  assert.deepEqual(got, ["deepseek"]);

  // hook fails → fall back to static config
  const opts2 = {
    resolveAllowedProviders: async () => { throw new Error("nope"); },
    allowedProviders: ["ollama", "vllm"]
  };
  const got2 = await resolveAllowedProviders(ctx, opts2);
  assert.deepEqual(got2, ["ollama", "vllm"]);

  // no hook, static only
  const got3 = await resolveAllowedProviders(ctx, { allowedProviders: ["qwen"] });
  assert.deepEqual(got3, ["qwen"]);

  // nothing → null (route freely)
  assert.equal(await resolveAllowedProviders(ctx, {}), null);
});

test("wrapper honors resolved allowed providers and still yields to explicit choice", async () => {
  const calls = [];
  const fakeCtx = {
    subagents: {
      startActivation: async (spec) => { calls.push(spec); return { childId: "c" }; }
    }
  };
  // router picks ollama, but the session only allows deepseek → allowedProviders
  // must make the router return null, so the caller's model is kept.
  let lastAllowed = null;
  const router = {
    async refreshModels() {},
    select(_subtask, selOpts) {
      lastAllowed = selOpts && selOpts.allowedProviders ? selOpts.allowedProviders : null;
      // pretend deepseek is the only legal one; router returns null because
      // its only model (ollama) is outside the allowlist
      if (lastAllowed && lastAllowed.includes("ollama")) {
        return { model: { provider: "ollama", model: "qwen" } };
      }
      return { model: null };
    }
  };
  const opts = { autoRouteSubagents: true, resolveAllowedProviders: async () => ({ routes: [{ provider: "deepseek", model: "chat" }] }) };
  const logCalls = [];
  await installStartActivationWrapper(fakeCtx, router, opts, (_s, m) => logCalls.push(m));

  const spec = { provider: "default", label: "write code", request: { prompt: [{ text: "write code" }], agentOptions: { provider: "deepseek", model: "chat" } } };
  await fakeCtx.subagents.startActivation(spec);

  // explicit choice → shouldRouteSubagent returns null → original called untouched
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.agentOptions.model, "chat");

  // non-explicit spawn → wrapper computes allowed providers and forwards them
  const spec2 = { provider: "default", label: "write code", request: { prompt: [{ text: "write code" }] } };
  await fakeCtx.subagents.startActivation(spec2);
  assert.deepEqual(lastAllowed, ["deepseek"]);
  // router returned null under the allowlist, so the rewrite did not happen
  assert.equal(calls[1].request.agentOptions, undefined);
});

// ---- host access: Cordis throws on undeclared properties ------------------
//
// This is the bug that made the plugin load but serve nothing: a plain
// `typeof ctx.listModels === "function"` probe THROWS on a real Cordis context.
// Every probe must go through safeGet.

function throwingCtx(target) {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return obj[prop];
      if (prop in obj) return obj[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    }
  });
}

test("safeGet swallows the Cordis 'without inject' throw", () => {
  const ctx = throwingCtx({ llm: { listProviders: () => [] } });
  assert.equal(safeGet(ctx, "listModels"), undefined);
  assert.equal(safeGet(ctx, "subagents"), undefined);
  assert.deepEqual(Object.keys(safeGet(ctx, "llm")), ["listProviders"]);
});

test("safeGet passes through ordinary values and undefined ctx", () => {
  assert.equal(safeGet({ webServer: 1 }, "webServer"), 1);
  assert.equal(safeGet(null, "webServer"), undefined);
  assert.equal(safeGet(undefined, "webServer"), undefined);
});

test("safeGet does not mask an error thrown by a real getter of the same name", () => {
  // Only the missing-property path is swallowed; anything already on the
  // object behaves normally.
  const ctx = { ok: 1 };
  assert.equal(safeGet(ctx, "ok"), 1);
  assert.equal(safeGet(ctx, "nope"), undefined);
});

test("readModelListFromHost reads the host llm service in three steps", async () => {
  const infoCalls = [];
  const llm = {
    listProviders: () => [{ id: "prov-a", name: "Provider A" }],
    listModels: async (providerId) => {
      assert.equal(providerId, "prov-a");
      return [
        { provider: "prov-a", id: "model-one", name: "Model One · x0.00", description: "fast" },
        { provider: "prov-a", id: "model-two", name: "Model Two · x0.50" }
      ];
    },
    resolveModelInfo: async (provider, model) => {
      infoCalls.push(`${provider}/${model}`);
      return {
        context: { contextWindow: 200000 },
        reasoning: { efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "low" }
      };
    }
  };

  const records = await readModelListFromHost(throwingCtx({ llm }));

  assert.equal(records.length, 2);
  assert.deepEqual(infoCalls, ["prov-a/model-one", "prov-a/model-two"]);

  const first = records[0];
  assert.equal(first.id, "prov-a/model-one");
  assert.equal(first.provider, "prov-a");
  assert.equal(first.model, "model-one");
  assert.equal(first.name, "Model One · x0.00");
  assert.equal(first.description, "fast");
  assert.equal(first.contextWindow, 200000);
  assert.deepEqual(first.reasoningEfforts, ["low", "high"]);
  assert.equal(first.defaultEffort, "low");
  assert.equal(first.highestEffort, "high");
  assert.equal(first.tier, undefined);

  // second model has no description -> empty string, not undefined
  assert.equal(records[1].description, "");
});

test("readModelListFromHost keeps other providers when one adapter fails", async () => {
  const llm = {
    listProviders: () => [{ id: "broken" }, { id: "healthy" }],
    listModels: async (providerId) => {
      if (providerId === "broken") throw new Error("adapter exploded");
      return [{ provider: "healthy", id: "m1", name: "M1" }];
    },
    resolveModelInfo: async () => {
      throw new Error("no info for you");
    }
  };

  const records = await readModelListFromHost(throwingCtx({ llm }));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "healthy/m1");
  // resolveModelInfo failure must not abort; efforts simply stay empty
  assert.deepEqual(records[0].reasoningEfforts, []);
  assert.equal(records[0].defaultEffort, null);
  assert.equal(records[0].contextWindow, undefined);
});

test("readModelListFromHost falls back to a grouped catalog when llm is absent", async () => {
  const ctx = throwingCtx({
    listModels: async () => ({
      groups: [
        {
          id: "ollama",
          name: "Ollama",
          models: [{ id: "qwen", name: "Qwen", description: "local", reasoning: { efforts: [{ id: "max" }] } }]
        }
      ]
    })
  });

  const records = await readModelListFromHost(ctx);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "ollama/qwen");
  assert.equal(records[0].name, "Qwen");
  assert.equal(records[0].description, "local");
  assert.equal(records[0].highestEffort, "max");
});

test("readModelListFromHost throws a directive error when neither source exists", async () => {
  await assert.rejects(
    () => readModelListFromHost(throwingCtx({ webServer: {} })),
    /no model catalog on this DSH build.*inject/s
  );
});

test("readModelListFromHost reports provider failures when every provider is empty", async () => {
  const llm = {
    listProviders: () => [{ id: "only" }],
    listModels: async () => { throw new Error("down"); },
    resolveModelInfo: async () => null
  };
  await assert.rejects(
    () => readModelListFromHost(throwingCtx({ llm })),
    /no usable models across 1 provider\(s\).*only: down/s
  );
});

// ---- whole-provider exclusion (cline) ------------------------------------

test("built-in exclusion list contains cline", () => {
  assert.deepEqual([...DEFAULT_EXCLUDED_PROVIDERS], ["cline"]);
});

test("resolveExcludedProviders merges config entries case-insensitively", () => {
  assert.deepEqual(resolveExcludedProviders(undefined), ["cline"]);
  assert.deepEqual(resolveExcludedProviders(["CLINE", "Trae"]), ["cline", "trae"]);
  assert.deepEqual(resolveExcludedProviders(["cline"]), ["cline"]);
});

test("resolveExcludedProviders honours an explicit empty array as 'exclude nothing'", () => {
  assert.deepEqual(resolveExcludedProviders([]), []);
});

test("isExcludedProvider matches case-insensitively and ignores blanks", () => {
  const ex = resolveExcludedProviders(undefined);
  assert.equal(isExcludedProvider("cline", ex), true);
  assert.equal(isExcludedProvider("Cline", ex), true);
  assert.equal(isExcludedProvider(" workbuddy ", ex), false);
  assert.equal(isExcludedProvider("", ex), false);
  assert.equal(isExcludedProvider(undefined, ex), false);
});

test("readModelListFromHost never calls the adapter of an excluded provider", async () => {
  const called = [];
  const llm = {
    listProviders: () => [{ id: "cline" }, { id: "workbuddy" }],
    listModels: async (p) => {
      called.push(p);
      if (p === "cline") throw new Error("must never be reached");
      return [{ provider: "workbuddy", id: "hy3", name: "Hy3" }];
    },
    resolveModelInfo: async () => null
  };
  const records = await readModelListFromHost(throwingCtx({ llm }), {
    excludedProviders: resolveExcludedProviders(undefined)
  });
  assert.deepEqual(called, ["workbuddy"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "workbuddy/hy3");
});

test("readModelListFromHost keeps cline when the exclusion list is emptied", async () => {
  const called = [];
  const llm = {
    listProviders: () => [{ id: "cline" }],
    listModels: async (p) => {
      called.push(p);
      return [{ provider: p, id: "x", name: "X" }];
    },
    resolveModelInfo: async () => null
  };
  const records = await readModelListFromHost(throwingCtx({ llm }), {
    excludedProviders: resolveExcludedProviders([])
  });
  assert.deepEqual(called, ["cline"]);
  assert.equal(records.length, 1);
});

test("readModelListFromHost error names the excluded providers", async () => {
  const llm = {
    listProviders: () => [{ id: "cline" }],
    listModels: async () => [{ id: "a", name: "A" }],
    resolveModelInfo: async () => null
  };
  await assert.rejects(
    () => readModelListFromHost(throwingCtx({ llm }), {
      excludedProviders: resolveExcludedProviders(undefined)
    }),
    /Excluded by config\.excludedProviders: cline/
  );
});

test("Router.refreshModels drops excluded providers from a custom source", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "cline/x", provider: "cline", model: "x", name: "X" },
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00" }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: [], optional: [] }));
  const models = await router.refreshModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "workbuddy");
});

test("Router can keep a provider when excludedProviders is emptied", async () => {
  const source = {
    async getModelList() {
      return [{ id: "cline/x", provider: "cline", model: "x", name: "X" }];
    }
  };
  const router = new Router({ excludedProviders: [] }, source, () => ({ required: [], optional: [] }));
  const models = await router.refreshModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "cline");
});




// ---- task classifier: explicit category + Chinese keywords -----------------

test("defaultTaskClassifier lets an explicit category define the required set", () => {
  // Before: category was accepted and then ignored, so every explicit request
  // fell back to describing the prompt — an explicit "coding" task with a
  // prompt free of English keywords became "general".
  assert.deepEqual(
    defaultTaskClassifier("coding", { description: "写一个快速排序" }),
    { required: ["coding"], optional: [] }
  );
  assert.deepEqual(
    defaultTaskClassifier("analysis", { description: "" }),
    { required: ["analysis"], optional: [] }
  );
  // description domains are demoted to optional, never allowed to override
  assert.deepEqual(
    defaultTaskClassifier("research", { description: "这个报错怎么修" }),
    { required: ["research"], optional: ["coding"] }
  );
});

test("defaultTaskClassifier treats empty/general/auto as 'read the prompt'", () => {
  for (const cat of ["", "general", "auto", "GENERAL", "  "]) {
    const got = defaultTaskClassifier(cat, { description: "写一个快速排序" });
    assert.deepEqual(got, { required: ["coding"], optional: [] }, `category=${JSON.stringify(cat)}`);
  }
});

test("defaultTaskClassifier understands Chinese task text", () => {
  const cases = [
    ["写一个快速排序", "coding"],
    ["帮我查资料", "research"],
    ["写一篇关于AI的文章", "writing"],
    ["总结这段文字", "summarize"],
    ["分析一下这个方案", "analysis"],
    ["这个报错怎么修", "coding"],
    ["调试一下这个函数", "coding"],
    ["翻译成英文", "writing"],
    ["评估这两个方案", "analysis"]
  ];
  for (const [text, expected] of cases) {
    const got = defaultTaskClassifier("", { description: text });
    assert.ok(got.required.includes(expected), `"${text}" should map to ${expected}, got ${JSON.stringify(got)}`);
  }
});

test("defaultTaskClassifier keeps coding tasks out of writing", () => {
  // "写一个快速排序" contains "写", which a naive keyword list turned into a
  // writing task and then picked a summarizer model for.
  const got = defaultTaskClassifier("", { description: "写一个快速排序" });
  assert.ok(!got.required.includes("writing"), JSON.stringify(got));
  assert.deepEqual(got.required, ["coding"]);
});

test("defaultTaskClassifier falls back to general when nothing matches", () => {
  assert.deepEqual(
    defaultTaskClassifier("", { description: "随便聊聊今天天气" }),
    { required: ["general"], optional: [] }
  );
  assert.deepEqual(defaultTaskClassifier("", {}), { required: ["general"], optional: [] });
});

test("inferCategory recognizes Chinese subagent tasks", () => {
  assert.equal(inferCategory("写一个快速排序"), "coding");
  assert.equal(inferCategory("帮我查资料"), "research");
  assert.equal(inferCategory("写一篇关于AI的文章"), "writing");
  assert.equal(inferCategory("总结这段话"), "summarize");
  assert.equal(inferCategory("分析这个方案的优缺点"), "analysis");
  assert.equal(inferCategory("随便聊聊"), "");
  assert.equal(inferCategory(""), "");
});

test("a Chinese coding task now routes away from a broad generalist model", async () => {
  // End-to-end shape of the bug that was visible in the live panel: the
  // generalist is free + great at "general", the coder costs 0.11 and is good
  // at "coding". With the fixed classifier the coder must win.
  const source = {
    async getModelList() {
      return [
        { id: "w/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "free", goodAt: ["general", "summarize"], badAt: ["coding"], remainingCredit: 100 },
        { id: "w/flash", provider: "workbuddy", model: "flash", name: "Flash · x0.11", tier: "free_quota", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, defaultTaskClassifier);
  await router.refreshModels();

  const task = "写一个快速排序";
  const result = router.select({ category: inferCategory(task), description: task });
  assert.equal(result.model.model, "flash", JSON.stringify(result));

  // A prompt that is genuinely general still prefers the free generalist.
  const general = router.select({ category: "", description: "随便聊聊" });
  assert.equal(general.model.model, "hy3");
});

// ---- end task classifier --------------------------------------------------


test("inferCategory weights by matched keyword length, not table order", () => {
  // 「实现」 alone used to hand this to coding, because coding was listed
  // first and any hit won. The research evidence is longer/specific.
  assert.equal(inferCategory("调研一下把模型路由按能力标签匹配任务的成熟实现思路"), "research");
  assert.equal(inferCategory("调研一下模型路由的业界做法"), "research");
  // Genuine coding tasks still land in coding.
  assert.equal(inferCategory("写一个快速排序"), "coding");
  assert.equal(inferCategory("写一个函数把数组排序"), "coding");
  assert.equal(inferCategory("修复这个编译错误"), "coding");
});

test("the two real subagent prompts classify differently", () => {
  // These are the actual prompts used for the live two-subagent check. Both
  // used to resolve to coding, so both subagents got the same model.
  const codingPrompt = "写一个 JavaScript 快速排序实现，并说明它为什么是 O(n log n)。只输出代码和 3 句话以内的说明，不要写文件。";
  const researchPrompt = "调研一下：把「模型路由」按能力标签匹配任务这种做法，业界有哪些成熟的实现思路。给 3 条要点，每条一句话，不要联网，凭你已有知识回答。";

  assert.equal(inferCategory(codingPrompt), "coding");
  assert.equal(inferCategory(researchPrompt), "research");
  assert.notEqual(inferCategory(codingPrompt), inferCategory(researchPrompt));
});

test("classification is stable for a coding prompt that also mentions analysis", () => {
  // 「分析这段代码的性能问题」 hits coding(代码) and analysis(分析). Coding evidence
  // must win: it is a code task that happens to ask for analysis.
  assert.equal(inferCategory("分析这段代码的性能问题"), "coding");
});

// ---- cheap band: free + free_quota ranked together -------------------------

test("resolveTierBands merges free and free_quota into one band", () => {
  assert.deepEqual(resolveTierBands(["free", "free_quota", "paid"]), [["free", "free_quota"], ["paid"]]);
  // custom order is preserved
  assert.deepEqual(resolveTierBands(["paid", "free", "free_quota"]), [["paid"], ["free", "free_quota"]]);
  // empty cheap list = every tier is its own band (the old strict behaviour)
  assert.deepEqual(resolveTierBands(["free", "free_quota", "paid"], []), [["free"], ["free_quota"], ["paid"]]);
  // only one cheap tier present
  assert.deepEqual(resolveTierBands(["free_quota", "paid"]), [["free_quota"], ["paid"]]);
  // a lone cheap band survives
  assert.deepEqual(resolveTierBands(["free", "free_quota"]), [["free", "free_quota"]]);
  assert.deepEqual(resolveTierBands([]), []);
});

test("Router ranks free and free_quota together when they are one band", async () => {
  const source = {
    async getModelList() {
      return [
        // free but explicitly bad at coding
        { id: "w/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "free", goodAt: ["general"], badAt: ["coding"], remainingCredit: 100 },
        // slightly costly but genuinely good at coding
        { id: "w/flash", provider: "workbuddy", model: "flash", name: "Flash · x0.11", tier: "free_quota", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();

  const result = router.select({ category: "coding" });
  // The old tier-walking picked hy3 here just for being free; the band rule
  // picks the model that can actually do the task.
  assert.equal(result.model.model, "flash");
  assert.match(result.reason, /band-match free\+free_quota/);
  assert.deepEqual(result.band, ["free", "free_quota"]);
});

test("Router still prefers the free model when both score the same", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/paidish", provider: "workbuddy", model: "paidish", name: "Paidish · x0.11", tier: "free_quota", goodAt: ["coding"], badAt: [], remainingCredit: 100 },
        { id: "w/free", provider: "workbuddy", model: "free", name: "Free · x0.00", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  const result = router.select({ category: "coding" });
  // Same score — directory order decides, but band membership does not penalise
  // the free one, so a stable sort keeps the free entry first here.
  assert.ok(["free", "paidish"].includes(result.model.model));
  assert.equal(result.band.length, 2);
});

test("escalation: a cheap band with no match is skipped when a pricier band actually matches", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/cheap", provider: "workbuddy", model: "cheap", name: "Cheap · x0.08", tier: "free_quota", goodAt: ["coding"], badAt: ["research"], remainingCredit: 100 },
        { id: "w/big", provider: "workbuddy", model: "big", name: "Big · x0.69", tier: "paid", goodAt: ["research"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, (c) => ({ required: [c], optional: [] }));
  await router.refreshModels();

  // research: the cheap model is explicitly BAD at it (-10), the paid one
  // claims it (+10). Paying more for a real match beats saving money on a model
  // that says it cannot do the job.
  const research = router.select({ category: "research" });
  assert.equal(research.model.model, "big");
  assert.deepEqual(research.band, ["paid"]);
  assert.equal(research.matched, true);
  assert.equal(research.escalated, true);
  // the trade-off is recorded, not hidden
  assert.equal(research.skipped.modelId, "w/cheap");
  assert.equal(research.skipped.score, -10);
  assert.equal(research.skipped.band.join("+"), "free+free_quota");

  // coding: the cheap band DOES match, so no money is spent.
  const coding = router.select({ category: "coding" });
  assert.equal(coding.model.model, "cheap");
  assert.equal(coding.escalated, undefined);

  // Empty the cheap band (blacklist) and paid is reached the ordinary way.
  router.setBlacklist(["w/cheap"]);
  const afterBan = router.select({ category: "research" });
  assert.equal(afterBan.model.model, "big");
  assert.deepEqual(afterBan.band, ["paid"]);
});

test("escalation never pays more for another 0-score guess", async () => {
  // The expensive model has NO tags at all. Escalating to it would cost several
  // times more for the exact same coin flip, so the cheap pick must survive.
  const source = {
    async getModelList() {
      return [
        { id: "w/cheap", provider: "workbuddy", model: "cheap", name: "Cheap · x0.08", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 },
        { id: "w/big", provider: "workbuddy", model: "big", name: "Big · x1.62", tier: "paid", goodAt: [], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: ["research"], optional: [] }));
  await router.refreshModels();
  const r = router.select({ category: "research" });
  assert.equal(r.model.model, "cheap");
  assert.equal(r.matched, false);
  assert.equal(r.escalated, undefined);
});

test("escalateOnMiss: false restores strict band-first behavior", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/cheap", provider: "workbuddy", model: "cheap", name: "Cheap · x0.08", tier: "free_quota", goodAt: ["coding"], badAt: ["research"], remainingCredit: 100 },
        { id: "w/big", provider: "workbuddy", model: "big", name: "Big · x0.69", tier: "paid", goodAt: ["research"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"], escalateOnMiss: false }, source, () => ({ required: ["research"], optional: [] }));
  await router.refreshModels();
  const r = router.select({ category: "research" });
  assert.equal(r.model.model, "cheap");
  assert.equal(r.matched, false);
});

test("escalateMinScore can require a stronger match before spending more", async () => {
  // A +2 optional-domain match is weak evidence. With escalateMinScore raised
  // the router stays cheap instead of paying 8x for it.
  const source = {
    async getModelList() {
      return [
        { id: "w/cheap", provider: "workbuddy", model: "cheap", name: "Cheap · x0.08", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 },
        { id: "w/big", provider: "workbuddy", model: "big", name: "Big · x0.69", tier: "paid", goodAt: ["research"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const classifier = () => ({ required: ["coding"], optional: ["research"] });
  const weak = new Router({ modelTiers: ["free", "free_quota", "paid"], escalateMinScore: 10 }, source, classifier);
  await weak.refreshModels();
  assert.equal(weak.select({ category: "coding" }).model.model, "cheap");

  const strong = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, classifier);
  await strong.refreshModels();
  // default threshold is 1, so the +2 optional match is enough
  assert.equal(strong.select({ category: "coding" }).model.model, "big");
});

test("cheapBand: [] restores strict one-tier-at-a-time walking", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "free", goodAt: [], badAt: ["coding"], remainingCredit: 100 },
        { id: "w/flash", provider: "workbuddy", model: "flash", name: "Flash · x0.11", tier: "free_quota", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  // `cheapBand: []` and `escalateOnMiss: false` are separate switches: the first
  // controls how tiers are grouped, the second whether a miss may look upward.
  // Only with BOTH off do we get the old strict behavior back.
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"], cheapBand: [], escalateOnMiss: false }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  assert.deepEqual(router.tierBands, [["free"], ["free_quota"], ["paid"]]);
  // Old behaviour: the free tier is non-empty, so it wins despite -10.
  assert.equal(router.select({ category: "coding" }).model.model, "hy3");
});

test("_pickFallback also walks bands, not single tiers", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/a", provider: "workbuddy", model: "a", name: "A · x0.00", tier: "free", goodAt: ["coding"], badAt: [], remainingCredit: 5 },
        { id: "w/b", provider: "workbuddy", model: "b", name: "B · x0.11", tier: "free_quota", goodAt: ["coding"], badAt: [], remainingCredit: 5000 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  const chosen = router.models.find((m) => m.id === "w/a");
  const fb = router._pickFallback(chosen, { required: ["coding"], optional: [] });
  // w/b lives in the same band, so it is a legitimate fallback.
  assert.equal(fb.id, "w/b");
});

// ---- end cheap band -------------------------------------------------------

// ---- account-backed providers (no balance route, but still real accounts) ---

test("DEFAULT_ACCOUNT_BACKED_PROVIDERS includes the quota-aware set plus trae/deepseek-account", () => {
  const list = [...DEFAULT_ACCOUNT_BACKED_PROVIDERS].sort();
  assert.deepEqual(list, ["deepseek-account", "qoder", "trae", "workbuddy"]);
  // our-free-model has no account, no login state, no usage route.
  assert.equal(list.includes("our-free-model"), false);
});

test("resolveAccountBackedProviders unions without dropping the built-ins", () => {
  const got = resolveAccountBackedProviders(["MyProv", "trae"]);
  assert.ok(got.includes("trae"));
  assert.ok(got.includes("workbuddy"));
  assert.ok(got.includes("myprov"));
  assert.equal(got.filter((p) => p === "trae").length, 1);
  // [] does not clear the built-in set — union only.
  assert.deepEqual(resolveAccountBackedProviders([]).sort(), ["deepseek-account", "qoder", "trae", "workbuddy"]);
  assert.deepEqual(resolveAccountBackedProviders().sort(), ["deepseek-account", "qoder", "trae", "workbuddy"]);
});

test("isAccountBackedProvider is case-insensitive and rejects empty", () => {
  assert.equal(isAccountBackedProvider("Trae"), true);
  assert.equal(isAccountBackedProvider(" deepseek-account "), true);
  assert.equal(isAccountBackedProvider("our-free-model"), false);
  assert.equal(isAccountBackedProvider(""), false);
  assert.equal(isAccountBackedProvider(null), false);
});

test("routeGate lets account-backed-but-unreadable providers through", () => {
  const aware = resolveQuotaAwareProviders();
  const backed = resolveAccountBackedProviders();
  const trae = { provider: "trae", id: "trae/glm-5.3", model: "glm-5.3", name: "GLM-5.3" };
  // trae publishes no balance route, but it is a signed-in account.
  assert.deepEqual(routeGate(trae, { quotaAwareProviders: aware, accountBackedProviders: backed }), {
    routable: true,
    reason: ROUTE_GATE.ACCOUNT_BACKED
  });
  // quota-aware wins over account-backed when both apply.
  const wb = { provider: "workbuddy", id: "workbuddy/hy3", model: "hy3", name: "Hy3" };
  assert.equal(routeGate(wb, { quotaAwareProviders: aware, accountBackedProviders: backed }).reason, ROUTE_GATE.QUOTA_AWARE);
  // our-free-model is in neither list and stays blocked.
  const ofm = { provider: "our-free-model", id: "our-free-model/x", model: "x", name: "X" };
  assert.equal(routeGate(ofm, { quotaAwareProviders: aware, accountBackedProviders: backed }).routable, false);
});

test("routeGate without an account-backed list degrades to the old quota-only rule", () => {
  const aware = resolveQuotaAwareProviders();
  const trae = { provider: "trae", id: "trae/x", model: "x", name: "X" };
  // No accountBackedProviders passed = caller opted out of that axis.
  assert.equal(routeGate(trae, { quotaAwareProviders: aware }).routable, false);
});

test("Router puts trae and deepseek-account back in the pool, our-free-model stays out", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "our-free-model/x", provider: "our-free-model", model: "x", name: "X", tier: "free", goodAt: ["coding"] },
        { id: "trae/glm-5.3", provider: "trae", model: "glm-5.3", name: "GLM-5.3", tier: "paid", goodAt: ["coding"] },
        { id: "deepseek-account/deepseek-flash", provider: "deepseek-account", model: "deepseek-flash", name: "DeepSeek-Flash", tier: "paid", goodAt: ["coding"] }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();

  const ofm = router.models.find((m) => m.id === "our-free-model/x");
  assert.equal(ofm.routable, false);
  assert.equal(ofm.gateReason, ROUTE_GATE.NO_QUOTA_SOURCE);

  const trae = router.models.find((m) => m.id === "trae/glm-5.3");
  assert.equal(trae.routable, true);
  assert.equal(trae.gateReason, ROUTE_GATE.ACCOUNT_BACKED);

  const ds = router.models.find((m) => m.id === "deepseek-account/deepseek-flash");
  assert.equal(ds.routable, true);

  // The free-tier model is gated, so the paid account-backed one wins.
  const result = router.select({ category: "coding" });
  assert.ok(["trae", "deepseek-account"].includes(result.model.provider));
});

test("accountBackedProviders config is additive so a custom account provider joins the gate", async () => {
  const source = {
    async getModelList() {
      return [{ id: "myprov/m1", provider: "myprov", model: "m1", name: "M1", tier: "free", goodAt: ["coding"] }];
    }
  };
  const blocked = new Router({ modelTiers: ["free"] }, source, () => ({ required: ["coding"], optional: [] }));
  await blocked.refreshModels();
  assert.equal(blocked.select({ category: "coding" }).model, null);

  const allowed = new Router({ modelTiers: ["free"], accountBackedProviders: ["myprov"] }, source, () => ({ required: ["coding"], optional: [] }));
  await allowed.refreshModels();
  assert.equal(allowed.select({ category: "coding" }).model.provider, "myprov");
});

// ---- end account-backed providers -----------------------------------------

// ---- eligibility gate: only balance-readable providers may route ----------

test("resolveQuotaAwareProviders unions built-ins with user additions", () => {
  assert.deepEqual([...DEFAULT_QUOTA_AWARE_PROVIDERS].sort(), ["qoder", "workbuddy"]);
  const got = resolveQuotaAwareProviders(["MyProv", "workbuddy"]);
  assert.ok(got.includes("workbuddy"));
  assert.ok(got.includes("qoder"));
  assert.ok(got.includes("myprov"));
  // deduped, lowercase
  assert.equal(got.filter((p) => p === "workbuddy").length, 1);
});

test("resolveQuotaAwareProviders keeps built-ins when passed nothing or garbage", () => {
  assert.deepEqual(resolveQuotaAwareProviders(), ["workbuddy", "qoder"]);
  assert.deepEqual(resolveQuotaAwareProviders(null), ["workbuddy", "qoder"]);
  assert.deepEqual(resolveQuotaAwareProviders("nope"), ["workbuddy", "qoder"]);
});

test("isQuotaAwareProvider is case-insensitive and rejects empty", () => {
  const aware = resolveQuotaAwareProviders();
  assert.equal(isQuotaAwareProvider("WorkBuddy", aware), true);
  assert.equal(isQuotaAwareProvider(" our-free-model ", aware), false);
  assert.equal(isQuotaAwareProvider("", aware), false);
  assert.equal(isQuotaAwareProvider(null, aware), false);
});

test("routeGate allows quota-aware providers, blocks the rest", () => {
  const aware = resolveQuotaAwareProviders();
  const g1 = routeGate({ provider: "workbuddy", id: "workbuddy/hy3", model: "hy3", name: "Hy3" }, { quotaAwareProviders: aware });
  assert.deepEqual(g1, { routable: true, reason: ROUTE_GATE.QUOTA_AWARE });

  const g2 = routeGate({ provider: "our-free-model", id: "our-free-model/big-pickle", model: "big-pickle", name: "Big Pickle" }, { quotaAwareProviders: aware });
  assert.deepEqual(g2, { routable: false, reason: ROUTE_GATE.NO_QUOTA_SOURCE });
});

test("routeGate honours a per-model routableOverrides whitelist", () => {
  const aware = resolveQuotaAwareProviders();
  const m = { provider: "our-free-model", id: "our-free-model/big-pickle", model: "big-pickle", name: "Big Pickle" };
  // by canonical id
  assert.equal(routeGate(m, { quotaAwareProviders: aware, routableOverrides: ["our-free-model/big-pickle"] }).reason, ROUTE_GATE.OVERRIDE);
  // by bare model id
  assert.equal(routeGate(m, { quotaAwareProviders: aware, routableOverrides: ["big-pickle"] }).routable, true);
  // an unrelated override does not leak
  assert.equal(routeGate(m, { quotaAwareProviders: aware, routableOverrides: ["something-else"] }).routable, false);
});

test("Router gates models from unreadable-balance providers out of the pool", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "our-free-model/big-pickle", provider: "our-free-model", model: "big-pickle", name: "Big Pickle", tier: "free", goodAt: ["coding"], remainingCredit: 999 },
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "paid", goodAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();

  const pickle = router.models.find((m) => m.id === "our-free-model/big-pickle");
  assert.equal(pickle.routable, false);
  assert.equal(pickle.gateReason, ROUTE_GATE.NO_QUOTA_SOURCE);
  // Still listed and still available — visible in the panel, just not routable.
  assert.equal(pickle.status, "available");

  // The free-tier model is blocked, so the paid quota-aware one wins despite
  // the free-first rule.
  const result = router.select({ category: "coding" });
  assert.equal(result.model.provider, "workbuddy");
});

test("Router reports no-quota-aware-candidates instead of silently pretending empty", async () => {
  const source = {
    async getModelList() {
      return [{ id: "our-free-model/x", provider: "our-free-model", model: "x", name: "X", tier: "free", goodAt: [], remainingCredit: 999 }];
    }
  };
  const router = new Router({ modelTiers: ["free"] }, source, () => ({ required: [], optional: [] }));
  await router.refreshModels();
  const result = router.select({ category: "general" });
  assert.equal(result.model, null);
  assert.match(result.reason, /no-quota-aware-candidates/);
  assert.deepEqual(result.gatedProviders, ["our-free-model"]);
});

test("requireQuotaAware:false restores the old any-provider behaviour", async () => {
  const source = {
    async getModelList() {
      return [{ id: "our-free-model/x", provider: "our-free-model", model: "x", name: "X", tier: "free", goodAt: ["coding"], remainingCredit: 999 }];
    }
  };
  const router = new Router({ modelTiers: ["free"], requireQuotaAware: false }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  const result = router.select({ category: "coding" });
  assert.equal(result.model.provider, "our-free-model");
});

test("routableOverrides lets one listed-but-unreadable model route again", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "our-free-model/a", provider: "our-free-model", model: "a", name: "A", tier: "free", goodAt: ["coding"], remainingCredit: 999 },
        { id: "our-free-model/b", provider: "our-free-model", model: "b", name: "B", tier: "free", goodAt: [], remainingCredit: 999 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free"], routableOverrides: ["our-free-model/b"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  const result = router.select({ category: "coding" });
  assert.equal(result.model.model, "b");
});

test("QUOTA_SOURCES parse workbuddy account-credits payload", () => {
  const json = {
    accounts: [
      { id: "1", accountName: "other", selected: false, credits: 10 },
      { id: "2", accountName: "main", selected: true, credits: 2891.74 }
    ]
  };
  const parsed = QUOTA_SOURCES.workbuddy.parse(json);
  assert.equal(parsed.remaining, 2891.74);
  assert.equal(parsed.label, "main");
});

test("QUOTA_SOURCES parse qoder usage payload", () => {
  const json = { regions: [{ userType: "personal_professional_trial", userQuota: { total: 300, used: 37, remaining: 263 } }] };
  const parsed = QUOTA_SOURCES.qoder.parse(json);
  assert.equal(parsed.remaining, 263);
  assert.equal(parsed.total, 300);
});

test("QUOTA_SOURCES parsers return null on unexpected payloads", () => {
  assert.equal(QUOTA_SOURCES.workbuddy.parse({}), null);
  assert.equal(QUOTA_SOURCES.workbuddy.parse({ accounts: [{ credits: "x" }] }), null);
  assert.equal(QUOTA_SOURCES.qoder.parse({ regions: [] }), null);
  assert.equal(QUOTA_SOURCES.qoder.parse(null), null);
});

test("readProviderQuotas reads only known providers and isolates failures", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/plugins/dsh-connect-workbuddy/account-credits")) {
      return { ok: true, status: 200, async json() { return { accounts: [{ selected: true, accountName: "main", credits: 42 }] }; } };
    }
    return { ok: false, status: 500, async json() { return {}; } };
  };
  const { quotas, failures } = await readProviderQuotas("http://127.0.0.1:64754", ["workbuddy", "qoder", "our-free-model"], { fetchImpl });

  assert.equal(quotas.get("workbuddy").remaining, 42);
  assert.equal(quotas.has("our-free-model"), false);
  assert.ok(failures.some((f) => f.startsWith("qoder:")));
  // only the two providers we have sources for were hit
  assert.equal(calls.length, 2);
});

test("readProviderQuotas never throws when fetch blows up", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const { quotas, failures } = await readProviderQuotas("http://127.0.0.1:1", ["workbuddy"], { fetchImpl });
  assert.equal(quotas.size, 0);
  assert.match(failures[0], /ECONNREFUSED/);
});

test("readProviderQuotas returns early without an origin or fetch", async () => {
  const a = await readProviderQuotas("", ["workbuddy"]);
  assert.deepEqual(a.failures, ["no web server origin"]);
  const b = await readProviderQuotas("http://x", ["workbuddy"], { fetchImpl: null });
  assert.equal(b.quotas.size, 0);
});

test("Router.refreshQuotas attaches provider balance to every model of that provider", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3 · x0.00", tier: "free" },
        { id: "qoder/kmodel", provider: "qoder", model: "kmodel", name: "KModel", tier: "paid" },
        { id: "our-free-model/x", provider: "our-free-model", model: "x", name: "X", tier: "free" }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, () => ({ required: [], optional: [] }));
  await router.refreshModels();

  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (url.includes("workbuddy")) return { accounts: [{ selected: true, accountName: "main", credits: 500 }] };
      return { regions: [{ userQuota: { remaining: 263, total: 300 } }] };
    }
  });
  router.modelSource = router.modelSource; // no-op, keeps shape explicit
  const res = await router.refreshQuotas("http://127.0.0.1:64754", { fetchImpl });

  assert.equal(res.ok, true);
  const hy3 = router.models.find((m) => m.id === "workbuddy/hy3");
  assert.equal(hy3.remainingCredit, 500);
  assert.equal(hy3.quotaLabel, "main");
  const km = router.models.find((m) => m.id === "qoder/kmodel");
  assert.equal(km.remainingCredit, 263);
  // the provider with no balance route keeps the unknown marker
  const ofm = router.models.find((m) => m.id === "our-free-model/x");
  assert.equal(ofm.remainingCredit, -1);
});

test("Router drops a provider entirely once its balance reads zero", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3", tier: "free", goodAt: ["coding"] },
        { id: "qoder/kmodel", provider: "qoder", model: "kmodel", name: "KModel", tier: "paid", goodAt: [] }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "paid"] }, source, () => ({ required: ["coding"], optional: [] }));
  await router.refreshModels();
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (url.includes("workbuddy")) return { accounts: [{ selected: true, credits: 0 }] };
      return { regions: [{ userQuota: { remaining: 263, total: 300 } }] };
    }
  });
  await router.refreshQuotas("http://127.0.0.1:64754", { fetchImpl });
  router._indexByTier();

  const result = router.select({ category: "coding" });
  assert.equal(result.model.provider, "qoder");
});

// ---- end eligibility gate -------------------------------------------------

// ---- start Chinese domain aliases -----------------------------------------
// Canonical ids must stay English: matchScore compares raw strings and the task
// classifier emits English ids. Accepting Chinese at the input boundary is what
// lets a user write "goodAt": ["编码"] and have it actually work — storing the
// raw Chinese would make the tag silently never match.

test("canonicalDomain maps Chinese domains to the English ids routing uses", () => {
  assert.equal(canonicalDomain("编码"), "coding");
  assert.equal(canonicalDomain("调研"), "research");
  assert.equal(canonicalDomain("摘要"), "summarize");
  assert.equal(canonicalDomain("长文本"), "long-context");
  assert.equal(canonicalDomain("写作"), "writing");
  assert.equal(canonicalDomain("视觉"), "vision");
  assert.equal(canonicalDomain("通用"), "general");
});

test("canonicalDomain is case-insensitive on the English side", () => {
  // "Coding" and "coding" would otherwise be two different tags and only one
  // of them would ever match the classifier.
  assert.equal(canonicalDomain("Coding"), "coding");
  assert.equal(canonicalDomain("  RESEARCH  "), "research");
  assert.equal(canonicalDomain("Long-Context"), "long-context");
});

test("canonicalDomain leaves unknown domains alone instead of dropping them", () => {
  // A user's custom domain must survive; silently discarding it would look
  // like the tag was never saved.
  assert.equal(canonicalDomain("化学"), "化学");
  assert.equal(canonicalDomain("my-own-domain"), "my-own-domain");
  assert.equal(canonicalDomain(""), null);
  assert.equal(canonicalDomain("   "), null);
  assert.equal(canonicalDomain(null), null);
});

test("normalizeTag canonicalizes Chinese but still rejects invalid characters", () => {
  assert.equal(normalizeTag("编码"), "coding");
  assert.equal(normalizeTag("  调研 "), "research");
  assert.equal(normalizeTag("a b"), null); // space is not a valid domain char
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag(null), null);
});

test("parseTags handles a mixed Chinese/English tag string", () => {
  assert.deepEqual(parseTags("编码, 摘要; analysis|长文本"), ["coding", "summarize", "analysis", "long-context"]);
  assert.deepEqual(parseTags(["编码", "vision", "  "]), ["coding", "vision"]);
});

test("config written in Chinese actually changes routing", async () => {
  // End-to-end: a Chinese config.tags entry must produce the same routing as
  // the English spelling. This is the test that would have caught the bug where
  // "编码" was stored verbatim and silently never matched "coding".
  const source = {
    async getModelList() {
      return [
        { id: "w/cheap", provider: "workbuddy", model: "cheap", name: "Cheap · x0.08", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 },
        { id: "w/other", provider: "workbuddy", model: "other", name: "Other · x0.05", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const make = (tags) =>
    new Router(
      { modelTiers: ["free", "free_quota", "paid"], tags },
      source,
      (c) => ({ required: [c], optional: [] })
    );

  const zh = make({ "w/other": { goodAt: ["编码"], badAt: [] } });
  await zh.refreshModels();
  const zhPick = zh.select({ category: "coding" });
  assert.equal(zhPick.model.id, "w/other");
  assert.equal(zhPick.matched, true);

  const en = make({ "w/other": { goodAt: ["coding"], badAt: [] } });
  await en.refreshModels();
  const enPick = en.select({ category: "coding" });
  // same model, same score, same match verdict as the English spelling
  assert.equal(enPick.model.id, zhPick.model.id);
  assert.equal(enPick.score, zhPick.score);
  assert.equal(enPick.matched, zhPick.matched);
});

test("a Chinese badAt tag excludes the model as effectively as English", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/a", provider: "workbuddy", model: "a", name: "A · x0.05", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 },
        { id: "w/b", provider: "workbuddy", model: "b", name: "B · x0.08", tier: "free_quota", goodAt: [], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "free_quota", "paid"], tags: { "w/a": { goodAt: [], badAt: ["视觉"] } } },
    source,
    (c) => ({ required: [c], optional: [] })
  );
  await router.refreshModels();
  const a = router.models.find((m) => m.id === "w/a");
  // stored canonical, not as the Chinese string
  assert.deepEqual(a.badAt, ["vision"]);
  const r = router.select({ category: "vision" });
  assert.equal(r.model.id, "w/b");
});

test("DOMAIN_ALIASES covers every domain the classifier emits", () => {
  // If the classifier grows a domain that has no alias, a Chinese user writing
  // that domain would silently get a tag that never matches.
  for (const id of ["coding", "research", "writing", "summarize", "analysis", "vision", "long-context", "agentic", "office", "background", "general"]) {
    const aliases = Object.entries(DOMAIN_ALIASES).filter(([, v]) => v === id);
    assert.ok(aliases.length > 0, `no Chinese alias for ${id}`);
  }
});

// ---- end Chinese domain aliases -------------------------------------------

// ---- start Chinese category + price ranges --------------------------------
// Two boundaries that fail silently if unhandled: a Chinese `category` reaching
// the classifier, and a provider publishing a price *range* instead of a value.

test("a Chinese category reaches the classifier as its English domain", async () => {
  // /select?category=编码 and routingTable entries may arrive in Chinese. Without
  // canonicalization the required set would be ["编码"], which never equals a
  // tagged "coding" — every such call would collapse to a 0-score fallback while
  // looking like it worked.
  const task = defaultTaskClassifier("编码", { description: "" });
  assert.deepEqual(task.required, ["coding"]);

  assert.deepEqual(defaultTaskClassifier("调研", {}).required, ["research"]);
  assert.deepEqual(defaultTaskClassifier("长文本", {}).required, ["long-context"]);

  // English still works, and an unknown category is preserved rather than dropped.
  assert.deepEqual(defaultTaskClassifier("coding", {}).required, ["coding"]);
  assert.deepEqual(defaultTaskClassifier("化学", {}).required, ["化学"]);
});

test("a Chinese category actually selects the model good at that domain", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/a", provider: "workbuddy", model: "a", name: "A · x0.05", tier: "free_quota", goodAt: ["coding", "summarize"], badAt: [], remainingCredit: 100 },
        { id: "w/b", provider: "workbuddy", model: "b", name: "B · x0.08", tier: "free_quota", goodAt: ["research"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, defaultTaskClassifier);
  await router.refreshModels();

  const zh = router.select({ category: "编码", description: "" });
  assert.equal(zh.model.id, "w/a");
  assert.equal(zh.matched, true);

  const en = router.select({ category: "coding", description: "" });
  assert.equal(en.model.id, zh.model.id);
  assert.equal(en.score, zh.score);
});

test("parsePriceMultiplier resolves a range to the higher end", () => {
  // The multiplier decides the price band, and the band is a spending decision.
  // A model that MAY cost 0.12 must not be filed under "burn freely" because it
  // can drop to 0.06 — over-filing an expensive model into the cheap band is the
  // only error direction that costs money.
  assert.equal(parsePriceMultiplier("Seed-Code · x0.12→x0.06"), 0.12);
  assert.equal(parsePriceMultiplier("Seed-2.1-Turbo · x0.4→x0.2"), 0.4);
  assert.equal(parsePriceMultiplier("X · x0.2 -> x0.5"), 0.5);
  // single values are untouched
  assert.equal(parsePriceMultiplier("Hy3 · x0.00"), 0);
  assert.equal(parsePriceMultiplier("Flash · x0.11"), 0.11);
  // and version numbers are still not prices
  assert.equal(parsePriceMultiplier("GLM-5.3"), null);
});

test("stripPriceSuffix also removes a range suffix", () => {
  assert.equal(stripPriceSuffix("Seed-Code · x0.12→x0.06"), "Seed-Code");
  assert.equal(stripPriceSuffix("DeepSeek-V4.1-Flash · x0.12→x0.06"), "DeepSeek-V4.1-Flash");
  assert.equal(stripPriceSuffix("Hy3 · x0.00"), "Hy3");
});

test("a range-priced model lands in the band its worst case belongs to", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "t/ranged", provider: "trae", model: "ranged", name: "Flash · x0.12→x0.06", goodAt: ["coding"], badAt: [], remainingCredit: 100 },
        { id: "t/plain", provider: "trae", model: "plain", name: "Other · x0.50", goodAt: ["coding"], badAt: [], remainingCredit: 100 }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, defaultTaskClassifier);
  await router.refreshModels();
  const ranged = router.models.find((m) => m.model === "ranged");
  // x0.12 > quotaMultiplierMax (0.15)? No — 0.12 <= 0.15, so free_quota.
  // The point is that it is NOT free: the previous parser returned null and the
  // model fell through to `paid` for the wrong reason (unparsed, not expensive).
  assert.equal(ranged.priceMultiplier, 0.12);
  assert.equal(ranged.rawTier, "free_quota");
});

// ---- end Chinese category + price ranges ----------------------------------

// ---- start capability-match disclosure ------------------------------------
// A 0 score is ambiguous: it can mean "this model has tags and none of them
// apply", or "this model has no tags at all". `matched` disambiguates, and the
// difference is what tells a user whether a routing decision was earned or
// merely fell through to catalog order.

test("hasPositiveMatch is true only when a good tag actually applies", () => {
  const task = { required: ["coding"], optional: [] };
  assert.equal(hasPositiveMatch({ goodAt: ["coding"], badAt: [] }, task), true);
  assert.equal(hasPositiveMatch({ goodAt: ["coding", "vision"], badAt: [] }, { required: ["research"], optional: [] }), false);
  // no tags at all: not a match, even though the score is also 0
  assert.equal(hasPositiveMatch({ goodAt: [], badAt: [] }, task), false);
  // bad at the required domain: definitely not a positive match
  assert.equal(hasPositiveMatch({ goodAt: [], badAt: ["coding"] }, task), false);
});

test("hasPositiveMatch ignores a domain tagged on both sides", () => {
  // matchScore treats good+bad as no opinion; the match flag must agree,
  // otherwise the panel would claim a match the score refused to award.
  const m = { goodAt: ["coding"], badAt: ["coding"] };
  assert.equal(hasPositiveMatch(m, { required: ["coding"], optional: [] }), false);
});

test("hasPositiveMatch counts an optional domain as a real match", () => {
  const m = { goodAt: ["summarize"], badAt: [] };
  assert.equal(hasPositiveMatch(m, { required: ["coding"], optional: ["summarize"] }), true);
});

test("rankWithinTier reports matched alongside score", () => {
  const models = [
    { id: "a", provider: "p", model: "a", name: "A", status: "available", tier: "free", goodAt: ["coding"], badAt: [] },
    { id: "b", provider: "p", model: "b", name: "B", status: "available", tier: "free", goodAt: [], badAt: [] }
  ];
  const ranked = rankWithinTier(models, { required: ["coding"], optional: [] });
  assert.equal(ranked[0].model.id, "a");
  assert.equal(ranked[0].score, 10);
  assert.equal(ranked[0].matched, true);
  assert.equal(ranked[1].score, 0);
  assert.equal(ranked[1].matched, false);
});

test("select() exposes score, matched and candidates on a band match", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3", tier: "free", goodAt: ["summarize"], badAt: ["research"] },
        { id: "workbuddy/flash", provider: "workbuddy", model: "flash", name: "Flash", tier: "free_quota", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, (c) => ({ required: [c], optional: [] }));
  await router.refreshModels();

  const hit = router.select({ category: "summarize" });
  assert.equal(hit.model.id, "workbuddy/hy3");
  assert.equal(hit.score, 10);
  assert.equal(hit.matched, true);
  assert.equal(hit.candidates, 2);

  // research: hy3 is BAD (-10), flash is neutral (0) → flash wins on 0
  const miss = router.select({ category: "research" });
  assert.equal(miss.model.id, "workbuddy/flash");
  assert.equal(miss.score, 0);
  assert.equal(miss.matched, false);
});

test("select() flags an all-negative band instead of pretending it is a tie", async () => {
  // Every model actively declares itself bad here. That is a different (worse)
  // situation than a 0-score tie, and the caller must be able to tell.
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3", tier: "free", goodAt: ["general"], badAt: ["research"] }
      ];
    }
  };
  const router = new Router({ modelTiers: ["free", "free_quota", "paid"] }, source, (c) => ({ required: [c], optional: [] }));
  await router.refreshModels();
  const r = router.select({ category: "research" });
  assert.equal(r.reason.startsWith("band-match"), true);
  assert.equal(r.score, -10);
  assert.equal(r.matched, false);
});

test("select() reports matched=null for a route-table pick (no scoring happened)", async () => {
  const source = {
    async getModelList() {
      return [{ id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3", tier: "free", goodAt: ["coding"], badAt: [] }];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], routingTable: [{ category: "coding", defaultModel: "workbuddy/hy3" }] },
    source,
    (c) => ({ required: [c], optional: [] })
  );
  await router.refreshModels();
  const r = router.select({ category: "coding" });
  assert.equal(r.reason, "route-table");
  assert.equal(r.score, null);
  // null, not true: reporting a match here would be a lie, the table picked it
  assert.equal(r.matched, null);
});

test("refreshModels tags every model with its tag source", async () => {
  const source = {
    async getModelList() {
      return [
        // preset-covered family
        { id: "workbuddy/glm-5.3", provider: "workbuddy", model: "glm-5.3", name: "GLM-5.3", tier: "paid", goodAt: [], badAt: [] },
        // no family rule, no config tag
        { id: "qoder/mystery", provider: "qoder", model: "mystery", name: "Mystery-XYZ", tier: "paid", goodAt: [], badAt: [] },
        // hand-written config tag
        { id: "workbuddy/own", provider: "workbuddy", model: "own", name: "Own-Model", tier: "paid", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], tags: { "workbuddy/own": { goodAt: ["coding"], badAt: [] } } },
    source,
    (c) => ({ required: [c], optional: [] })
  );
  await router.refreshModels();

  const byId = (k) => router.models.find((m) => m.id === k);
  assert.equal(byId("workbuddy/glm-5.3").tagSource, "preset");
  assert.equal(byId("qoder/mystery").tagSource, "");
  // config wins over preset, and is marked as such
  assert.equal(byId("workbuddy/own").tagSource, "config");
  assert.deepEqual(byId("workbuddy/own").goodAt, ["coding"]);
});

// ---- end capability-match disclosure --------------------------------------

// ---- start manual priority overrides --------------------------------------
//
// The panel's ↑/↓ control writes here. What matters is not "it saves a number"
// but that the number actually changes routing, and that a missing/corrupt file
// degrades to "automatic" rather than breaking the plugin.

import { mkdtempSync, rmSync, writeFileSync as writeRaw, readFileSync as readRaw } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

const tempDir = () => mkdtempSync(joinPath(tmpdir(), "subagent-switch-test-"));

test("clampPriority rounds and bounds to the documented range", () => {
  assert.equal(clampPriority(3.4), 3);
  assert.equal(clampPriority(1e9), PRIORITY_MAX);
  assert.equal(clampPriority(-1e9), PRIORITY_MIN);
  assert.equal(clampPriority("7"), 7);
  assert.equal(clampPriority(undefined), 0);
});

test("sanitizeOverrides drops unknown keys, non-numbers and zero priorities", () => {
  const clean = sanitizeOverrides({
    priority: { "a/one": 5, "a/zero": 0, "a/bad": "NaN", "a/huge": 9999, "": 3 },
    routable: { "a/one": true, "a/no": false, "a/str": "true" },
    garbage: { whatever: 1 }
  });
  assert.deepEqual(clean.priority, { "a/one": 5, "a/huge": PRIORITY_MAX });
  // Only a literal `true` counts. A string "true" is not a claim.
  assert.deepEqual(clean.routable, { "a/one": true });
  assert.equal(clean.garbage, undefined);
});

test("sanitizeOverrides tolerates null / arrays / primitives", () => {
  for (const input of [null, undefined, [], "x", 7]) {
    assert.deepEqual(sanitizeOverrides(input), emptyOverrides());
  }
  // emptyOverrides() must hand back a fresh object every time, or a caller
  // writing into it would corrupt the "empty" constant for everyone else.
  assert.notEqual(emptyOverrides(), emptyOverrides());
});

test("withPriority is pure and treats 0 as 'no opinion' (deletes the key)", () => {
  const base = emptyOverrides();
  const raised = withPriority(base, "workbuddy/hy3", 4);
  assert.deepEqual(raised.priority, { "workbuddy/hy3": 4 });
  assert.deepEqual(base.priority, {}, "the input store must not be mutated");
  const cleared = withPriority(raised, "workbuddy/hy3", 0);
  assert.deepEqual(cleared.priority, {});
});

test("withRoutable records only positive claims", () => {
  const granted = withRoutable(emptyOverrides(), "our-free-model/big-pickle", true);
  assert.equal(isRoutableOverride(granted, "our-free-model/big-pickle"), true);
  const revoked = withRoutable(granted, "our-free-model/big-pickle", false);
  assert.equal(isRoutableOverride(revoked, "our-free-model/big-pickle"), false);
  assert.deepEqual(revoked.routable, {});
});

test("priorityOf / isRoutableOverride are safe on blank ids and empty stores", () => {
  assert.equal(priorityOf(emptyOverrides(), "nope/x"), 0);
  assert.equal(priorityOf(null, "nope/x"), 0);
  assert.equal(priorityOf(emptyOverrides(), ""), 0);
  assert.equal(isRoutableOverride(emptyOverrides(), "nope/x"), false);
  assert.equal(isRoutableOverride(undefined, "nope/x"), false);
});

test("pinnedList returns non-zero priorities, highest first", () => {
  const store = sanitizeOverrides({
    priority: { "a/low": 1, "a/high": 9, "a/mid": 5 }
  });
  assert.deepEqual(pinnedList(store), [
    { id: "a/high", priority: 9 },
    { id: "a/mid", priority: 5 },
    { id: "a/low", priority: 1 }
  ]);
});

test("readOverrides returns the empty store for a missing or corrupt file", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readOverrides(joinPath(dir, "absent.json")), emptyOverrides());
    const corrupt = joinPath(dir, "corrupt.json");
    writeRaw(corrupt, "{ not json", "utf8");
    // Losing a manual tweak is annoying; refusing to load the plugin is worse.
    assert.deepEqual(readOverrides(corrupt), emptyOverrides());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOverrides round-trips through disk and leaves no .tmp behind", () => {
  const dir = tempDir();
  const file = joinPath(dir, "nested", "overrides.json");
  try {
    const saved = writeOverrides({ priority: { "a/one": 2 }, routable: { "a/one": true } }, file);
    assert.equal(saved.ok, true);
    assert.deepEqual(readOverrides(file), { priority: { "a/one": 2 }, routable: { "a/one": true } });
    // tmp + rename: a crash mid-write must not leave a half file.
    assert.equal(readRaw(file, "utf8").includes("a/one"), true);
    assert.throws(() => readRaw(`${file}.tmp`, "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Router reads priority from the overrides file at construction", async () => {
  const dir = tempDir();
  const file = joinPath(dir, "overrides.json");
  try {
    writeOverrides({ priority: { "workbuddy/hy3": 3 } }, file);
    const router = new Router(
      { modelTiers: ["free", "paid"], overridesPath: file },
      {
        async getModelList() {
          return [
            { id: "workbuddy/hy3", provider: "workbuddy", model: "hy3", name: "Hy3", tier: "free", goodAt: [], badAt: [] }
          ];
        }
      },
      () => ({ required: [], optional: [] })
    );
    await router.refreshModels();
    assert.equal(router.priorityFor(router.models[0]), 3);
    assert.equal(router.models[0].priority, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual priority beats capability score inside a band", async () => {
  // The whole point of the control: if score still won, raising the priority of
  // an untagged model would do nothing and the ↑ button would be a lie.
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/good", provider: "workbuddy", model: "good", name: "Good", tier: "free", goodAt: ["coding"], badAt: [] },
        { id: "workbuddy/plain", provider: "workbuddy", model: "plain", name: "Plain", tier: "free", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], overridesPath: "" },
    source,
    () => ({ required: ["coding"], optional: [] })
  );
  await router.refreshModels();
  assert.equal(router.select({ category: "coding" }).model.id, "workbuddy/good", "score wins by default");

  router.setOverrides({ priority: { "workbuddy/plain": 1 }, routable: {} });
  const pinned = router.select({ category: "coding" });
  assert.equal(pinned.model.id, "workbuddy/plain");
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.priority, 1);
});

test("a pin suppresses escalation instead of being traded for a pricier model", async () => {
  const source = {
    async getModelList() {
      return [
        // No coding tag anywhere in the cheap band: escalation would normally fire.
        { id: "workbuddy/cheap", provider: "workbuddy", model: "cheap", name: "Cheap", tier: "free", goodAt: [], badAt: [] },
        { id: "workbuddy/pricey", provider: "workbuddy", model: "pricey", name: "Pricey", tier: "paid", goodAt: ["coding"], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], escalateOnMiss: true, overridesPath: "" },
    source,
    () => ({ required: ["coding"], optional: [] })
  );
  await router.refreshModels();
  assert.equal(router.select({ category: "coding" }).model.id, "workbuddy/pricey", "escalates without a pin");

  router.setOverrides({ priority: { "workbuddy/cheap": 2 }, routable: {} });
  const pinned = router.select({ category: "coding" });
  assert.equal(pinned.model.id, "workbuddy/cheap", "the user chose this one; do not spend more");
  assert.equal(pinned.escalated, undefined);
});

test("a pin competes globally, bypassing band order", async () => {
  // Pinning a paid model has to work, or the control is useless whenever the
  // cheap band is non-empty — which is practically always.
  const source = {
    async getModelList() {
      return [
        { id: "workbuddy/cheap", provider: "workbuddy", model: "cheap", name: "Cheap", tier: "free", goodAt: ["coding"], badAt: [] },
        { id: "workbuddy/pricey", provider: "workbuddy", model: "pricey", name: "Pricey", tier: "paid", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], overridesPath: "" },
    source,
    () => ({ required: ["coding"], optional: [] })
  );
  await router.refreshModels();
  assert.equal(router.select({ category: "coding" }).model.id, "workbuddy/cheap");

  router.setOverrides({ priority: { "workbuddy/pricey": 1 }, routable: {} });
  const result = router.select({ category: "coding" });
  assert.equal(result.model.id, "workbuddy/pricey");
  assert.equal(result.pinned, true);
  assert.match(result.reason, /pinned, band order bypassed/);
});

test("a higher pin wins over a lower one regardless of score", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "w/a", provider: "w", model: "a", name: "A", tier: "paid", goodAt: ["coding"], badAt: [] },
        { id: "w/b", provider: "w", model: "b", name: "B", tier: "free", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], overridesPath: "", accountBackedProviders: ["w"] },
    source,
    () => ({ required: ["coding"], optional: [] })
  );
  await router.refreshModels();
  router.setOverrides({ priority: { "w/a": 1, "w/b": 5 }, routable: {} });
  assert.equal(router.select({ category: "coding" }).model.id, "w/b");
});

test("a routable override lifts exactly one gated model into the pool", async () => {
  const source = {
    async getModelList() {
      return [
        { id: "our-free-model/one", provider: "our-free-model", model: "one", name: "One", tier: "free", goodAt: [], badAt: [] },
        { id: "our-free-model/two", provider: "our-free-model", model: "two", name: "Two", tier: "free", goodAt: [], badAt: [] }
      ];
    }
  };
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], overridesPath: "" },
    source,
    () => ({ required: [], optional: [] })
  );
  await router.refreshModels();
  // No balance route and not account-backed → both listed but unroutable.
  assert.equal(router.models.every((m) => m.routable === false), true);
  assert.equal(router.select({ category: "general" }).model, null);

  router.setOverrides({ priority: {}, routable: { "our-free-model/two": true } });
  const one = router.models.find((m) => m.id === "our-free-model/one");
  const two = router.models.find((m) => m.id === "our-free-model/two");
  assert.equal(one.routable, false, "releasing one must not release its siblings");
  assert.equal(two.routable, true);
  assert.equal(two.gateReason, "override");
  assert.equal(router.select({ category: "general" }).model.id, "our-free-model/two");
});

test("setOverrides re-indexes so a change applies without re-reading the catalog", async () => {
  let reads = 0;
  const router = new Router(
    { modelTiers: ["free", "paid"], cheapBand: ["free"], overridesPath: "" },
    {
      async getModelList() {
        reads += 1;
        return [
          { id: "our-free-model/one", provider: "our-free-model", model: "one", name: "One", tier: "free", goodAt: [], badAt: [] }
        ];
      }
    },
    () => ({ required: [], optional: [] })
  );
  await router.refreshModels();
  const before = reads;
  router.setOverrides({ priority: {}, routable: { "our-free-model/one": true } });
  assert.equal(reads, before, "must not re-read the model directory");
  assert.equal(router.select({ category: "general" }).model.id, "our-free-model/one");
});
// ---- end manual priority overrides ----------------------------------------

// ---- start config shape (flat patch vs nested example) --------------------

test("unwrapPluginConfig strips the wrapper when present", () => {
  assert.deepEqual(unwrapPluginConfig({ "subagent-switch": { enabled: false } }), { enabled: false });
});

test("unwrapPluginConfig passes a flat body through untouched", () => {
  assert.deepEqual(unwrapPluginConfig({ enabled: false, panelTitle: "x" }), { enabled: false, panelTitle: "x" });
});

test("unwrapPluginConfig tolerates null, arrays and primitives", () => {
  assert.deepEqual(unwrapPluginConfig(null), {});
  assert.deepEqual(unwrapPluginConfig(undefined), {});
  assert.deepEqual(unwrapPluginConfig([1, 2]), {});
  assert.deepEqual(unwrapPluginConfig("nope"), {});
});

test("a flat patch config overrides the shipped defaults (the dropped-config bug)", () => {
  const example = { "subagent-switch": { enabled: true, panelTitle: "default", escalateOnMiss: true, blacklist: [] } };
  const patch = { enabled: true, panelTitle: "from patch", escalateOnMiss: false };
  const opts = resolvePluginConfig(example, patch);
  assert.equal(opts.panelTitle, "from patch");
  assert.equal(opts.escalateOnMiss, false);
  assert.equal(Object.prototype.hasOwnProperty.call(opts, PLUGIN_KEY), false, "result must be flat, never wrapped");
});

test("a nested config block still overrides the shipped defaults", () => {
  const example = { "subagent-switch": { panelTitle: "default", enabled: true } };
  const patch = { "subagent-switch": { panelTitle: "nested patch" } };
  const opts = resolvePluginConfig(example, patch);
  assert.equal(opts.panelTitle, "nested patch");
  assert.equal(opts.enabled, true, "unmentioned defaults survive");
});

test("missing config falls back to the shipped defaults", () => {
  const example = { "subagent-switch": { panelTitle: "default" } };
  assert.equal(resolvePluginConfig(example, undefined).panelTitle, "default");
  assert.equal(resolvePluginConfig(example, null).panelTitle, "default");
});

test("patch overridesPath reaches the router config", () => {
  const example = { "subagent-switch": { overridesPath: "" } };
  const opts = resolvePluginConfig(example, { overridesPath: "X:/custom/o.json" });
  assert.equal(opts.overridesPath, "X:/custom/o.json");
});

// ---- end config shape -----------------------------------------------------

// ---- start config arrays replace ------------------------------------------

test("a patch array REPLACES the default array instead of growing it", () => {
  const example = { "subagent-switch": { modelTiers: ["free", "free_quota", "paid"] } };
  const opts = resolvePluginConfig(example, { modelTiers: ["free"] });
  assert.deepEqual(opts.modelTiers, ["free"], "narrowing a list must not widen it");
});

test("an empty patch array clears the default list", () => {
  const example = { "subagent-switch": { blacklist: ["a", "b"] } };
  const opts = resolvePluginConfig(example, { blacklist: [] });
  assert.deepEqual(opts.blacklist, []);
});

test("nested objects still merge key by key, arrays inside them still replace", () => {
  const example = { "subagent-switch": { quota: { checkIntervalMs: 300000, logQuotaEvents: true } } };
  const opts = resolvePluginConfig(example, { quota: { checkIntervalMs: 1000 } });
  assert.equal(opts.quota.checkIntervalMs, 1000);
  assert.equal(opts.quota.logQuotaEvents, true, "unmentioned nested keys survive");
});

test("an array of objects in the patch replaces wholesale", () => {
  const example = {
    "subagent-switch": {
      routingTable: [
        { category: "coding", defaultModel: "a" },
        { category: "research", defaultModel: "b" }
      ]
    }
  };
  const opts = resolvePluginConfig(example, { routingTable: [{ category: "coding", defaultModel: "c" }] });
  assert.deepEqual(opts.routingTable, [{ category: "coding", defaultModel: "c" }]);
});

test("union-style lists are still additive where the resolver does the union", () => {
  // excludedProviders / quotaAwareProviders / accountBackedProviders rely on
  // resolve*() to add, not on mergeDeep. A patch list must not be re-unioned
  // here, or the resolver would see duplicates.
  const example = { "subagent-switch": { accountBackedProviders: ["x"] } };
  const opts = resolvePluginConfig(example, { accountBackedProviders: ["y"] });
  assert.deepEqual(opts.accountBackedProviders, ["y"]);
});

// ---- end config arrays replace --------------------------------------------


