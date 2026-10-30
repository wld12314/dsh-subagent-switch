// models.js — model list & state normalization
//
// DSH's session model bar already shows the models the user has available.
// This module converts whatever DSH hands us into a flat, normalized model
// record that the router can score and the UI can render.
//
// A "model source" is anything that resolves to an array of model objects.
// The plugin wires the real DSH read path in apply.js; this module only
// shapes the data. Until that hook is mounted, we return a controlled empty
// source plus a well-known diagnostic error so the UI can show a clear
// "please reload DSH" state instead of crashing.

export const MODEL_STATUS = Object.freeze({
  AVAILABLE: "available",
  EXHAUSTED: "exhausted",   // quota reached zero
  EXCLUDED: "excluded",     // in user blacklist
  UNAVAILABLE: "unavailable" // removed from directory / unreadable
});

// ---- whole-provider exclusion -------------------------------------------
//
// Some providers are aggregators that re-list hundreds of third-party models,
// most of them already obsolete. `cline` on this machine advertises 459 models
// out of a 561-model catalog — 82% of the list — which (a) swamps the panel,
// (b) costs one `resolveModelInfo` round-trip per model on every refresh, and
// (c) buries the user's own account models under older duplicates.
//
// The rule lives HERE, in the core, not only in config: a fresh install must
// behave the same way even if the conf block is missing or hand-edited.
// Users who want a provider back can either remove it from
// `config.excludedProviders` or blacklist individual models.
export const DEFAULT_EXCLUDED_PROVIDERS = Object.freeze(["cline"]);

/**
 * Merge the built-in exclusion list with the user's, case-insensitively.
 *
 * @param {string[]} [extraProviders] from `config.excludedProviders`
 * @returns {string[]} lowercase provider ids
 */
export function resolveExcludedProviders(extraProviders) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const p of DEFAULT_EXCLUDED_PROVIDERS) push(p);
  // `excludedProviders: []` is the documented way to disable the built-in
  // default entirely, so an explicit empty array is honoured as "keep none".
  if (Array.isArray(extraProviders)) {
    if (extraProviders.length === 0) return [];
    for (const p of extraProviders) push(p);
  }
  return out;
}

/**
 * Is this provider excluded from the candidate pool?
 *
 * @param {string} provider
 * @param {string[]} [excluded] lowercase ids from resolveExcludedProviders()
 * @returns {boolean}
 */
export function isExcludedProvider(provider, excluded = DEFAULT_EXCLUDED_PROVIDERS) {
  const p = String(provider ?? "").trim().toLowerCase();
  if (!p) return false;
  return (excluded || []).some((e) => String(e).trim().toLowerCase() === p);
}

// ---- routing eligibility gate -------------------------------------------
//
// The router only spends a subagent on a model whose remaining balance it can
// actually observe. Two reasons:
//
//  1. Correctness — a model that can lose its credits at any moment can fail a
//     task mid-flight, and we would have had no warning.
//  2. It is the only defensible default: free-tier aggregators (e.g.
//     `our-free-model`) are routinely emptied by other users, while
//     account-backed providers (workbuddy, qoder) publish a real balance.
//
// So models from providers WITHOUT a readable balance stay in the panel —
// visible, tagged, blacklistable — but only enter the automatic pool if the
// provider is *account-backed*: the user signed into a real account for it,
// so the pool is a subscription rather than a rotating free firehose. `trae`
// and `deepseek-account` qualify that way even though their balance routes are
// all 404. A user who insists on a non-account provider can whitelist
// individual models through `config.routableOverrides`, or reorder priorities
// by hand in the panel.
export const ROUTE_GATE = Object.freeze({
  // provider exposes an account balance we can read → routable
  QUOTA_AWARE: "quota-aware",
  // provider is signed-in/account-backed but publishes no balance → routable
  ACCOUNT_BACKED: "account-backed",
  // explicitly whitelisted by the user → routable regardless
  OVERRIDE: "override",
  // provider has no readable balance, no account, and is not whitelisted
  NO_QUOTA_SOURCE: "no-quota-source"
});

/**
 * Decide whether a model may be chosen for an automatic subagent route.
 *
 * @param {object} model normalized model record
 * @param {object} [opts]
 * @param {string[]} [opts.quotaAwareProviders] lowercase provider ids
 * @param {string[]} [opts.accountBackedProviders] lowercase provider ids
 * @param {string[]} [opts.routableOverrides] model ids / bare ids / names
 * @returns {{ routable: boolean, reason: string }}
 */
export function routeGate(model, opts = {}) {
  const aware = opts.quotaAwareProviders || [];
  if (isQuotaAwareProvider(model?.provider, aware)) {
    return { routable: true, reason: ROUTE_GATE.QUOTA_AWARE };
  }
  const backed = opts.accountBackedProviders || [];
  if (isAccountBackedProvider(model?.provider, backed)) {
    return { routable: true, reason: ROUTE_GATE.ACCOUNT_BACKED };
  }
  const overrides = Array.isArray(opts.routableOverrides) ? opts.routableOverrides : [];
  if (overrides.length && overrides.some((key) => modelMatchesKey(model, key))) {
    return { routable: true, reason: ROUTE_GATE.OVERRIDE };
  }
  return { routable: false, reason: ROUTE_GATE.NO_QUOTA_SOURCE };
}

/**
 * Is this provider one whose account balance we can read?
 *
 * The canonical predicate lives in quota.js next to the HTTP routes it is
 * based on. Imported (not just re-exported) because `routeGate` above calls it,
 * and a bare `export ... from` creates no local binding. No import cycle:
 * quota.js imports nothing from models.js.
 */
import { isQuotaAwareProvider, isAccountBackedProvider } from "./quota.js";
export { isQuotaAwareProvider, isAccountBackedProvider };

// Heuristic tier inference for directory-sourced models whose provider/name
// does not carry an explicit plan tier. Local / self-hosted providers are
// treated as free; "trial"/"quota" labelled ones as free_quota; everything
// else defaults to paid. The config `tierMap` (id → tier) overrides this.
const FREE_PROVIDER_HINTS = [
  "ollama", "lmstudio", "llamafile", "vllm", "localai", "kobold",
  "text-generation-webui", "open-webui", "jan", "gpt4all", "llamacpp"
];
const FREE_NAME_HINTS = ["free", "trial", "hobby", "dev", "community"];
const QUOTA_NAME_HINTS = ["quota", "trial", "preview", "beta-credit"];

// Default credit-multiplier cutoffs. See `parsePriceMultiplier` below: some
// providers (e.g. WorkBuddy) append the price to the *display name* as
// ` · x0.29`, which is the only price signal DSH's catalog exposes.
export const DEFAULT_PRICING = Object.freeze({
  // multiplier at or below this = genuinely free (no credits burned)
  freeMultiplierMax: 0,
  // multiplier at or below this = cheap enough to treat as "burn freely"
  quotaMultiplierMax: 0.15
});

// Providers may render the price as `Name · x0.29`, `Name • x0.29` or
// `Name x0.29`. Trea-style providers sometimes publish a *range*
// (`Name · x0.12→x0.06`) meaning "starts here, drops there". Capture the
// trailing multiplier only; anything else in the name (version numbers like
// `glm-5.3`) must not be mistaken for a price.
const PRICE_SUFFIX_RE =
  /\s*[·•|]\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(?:[→~]|->)\s*[x×]?\s*(\d+(?:\.\d+)?))?\s*$/i;

/**
 * Extract the credit multiplier a provider baked into the display name.
 *
 * DSH's `ctx.llm.listModels()` rebuilds each record as
 * `{provider, id, name, description?, inputModalities?}` — it drops quota and
 * price entirely. WorkBuddy therefore puts the price in the name via
 * `workBuddyDisplayName()`: `` `${name} · x${creditMultiplier.toFixed(2)}` ``.
 * That suffix is the only price signal a plugin can see.
 *
 * Ranges (`x0.12→x0.06`) resolve to the **higher** end. The multiplier decides
 * which price band a model sits in, and that band is a spending decision: a
 * model that *may* cost 0.12 must not be filed under "burn freely" just because
 * it can drop to 0.06. Taking the worst case keeps an expensive model out of
 * the cheap band, which is the only error direction that costs the user money.
 *
 * @param {string} name
 * @returns {number|null} multiplier, or null when the name carries none
 */
export function parsePriceMultiplier(name) {
  const m = PRICE_SUFFIX_RE.exec(String(name || ""));
  if (!m) return null;
  const first = Number(m[1]);
  if (!Number.isFinite(first)) return null;
  if (m[2] === undefined) return first;
  const second = Number(m[2]);
  if (!Number.isFinite(second)) return first;
  return Math.max(first, second);
}

/**
 * Strip a trailing ` · xN.NN` price suffix, leaving the plain model name.
 *
 * @param {string} name
 * @returns {string}
 */
export function stripPriceSuffix(name) {
  return String(name || "").replace(PRICE_SUFFIX_RE, "").trim();
}

/**
 * Infer a tier for a model record when none is declared.
 *
 * Order of authority:
 *  1. `config.tierMap` keyed by model id, then by plain name — explicit wins.
 *  2. Price multiplier parsed out of the display name — objective signal.
 *  3. Provider/name/description keyword heuristics — last resort.
 *
 * @param {string} id
 * @param {string} provider
 * @param {string} name
 * @param {string} [description]
 * @param {Record<string,string>} [tierMap] model id → explicit tier
 * @param {{freeMultiplierMax?:number, quotaMultiplierMax?:number}} [pricing]
 * @returns {"free"|"free_quota"|"paid"}
 */
export function inferTier(id, provider, name, description = "", tierMap = {}, pricing = {}) {
  const base = stripPriceSuffix(name);
  if (tierMap && typeof tierMap === "object") {
    if (tierMap[id]) return tierMap[id];
    if (tierMap[base]) return tierMap[base];
  }

  const multiplier = parsePriceMultiplier(name);
  if (multiplier !== null) {
    const freeMax = Number.isFinite(pricing.freeMultiplierMax)
      ? pricing.freeMultiplierMax : DEFAULT_PRICING.freeMultiplierMax;
    const quotaMax = Number.isFinite(pricing.quotaMultiplierMax)
      ? pricing.quotaMultiplierMax : DEFAULT_PRICING.quotaMultiplierMax;
    if (multiplier <= freeMax) return MODEL_TIER.FREE;
    if (multiplier <= quotaMax) return MODEL_TIER.FREE_QUOTA;
    return MODEL_TIER.PAID;
  }

  const prov = String(provider || "").toLowerCase();
  const hay = `${prov} ${base} ${description}`.toLowerCase();
  if (FREE_PROVIDER_HINTS.some((h) => prov.includes(h))) {
    return MODEL_TIER.FREE;
  }
  if (QUOTA_NAME_HINTS.some((h) => hay.includes(h))) {
    return MODEL_TIER.FREE_QUOTA;
  }
  if (FREE_NAME_HINTS.some((h) => hay.includes(h))) {
    return MODEL_TIER.FREE;
  }
  return MODEL_TIER.PAID;
}

/**
 * Project a normalized model record into the selection shape a subagent
 * actually carries when spawned. Confirmed against DSH's harness-client:
 *   { provider, model, reasoningEffort? }
 *
 * @param {object} record normalized model record (must retain provider/model)
 * @returns {{provider:string, model:string, reasoningEffort?:string}}
 */
export function selectionOf(record) {
  const provider = String(record.provider || "");
  const model = String(record.model || record.name || "");
  const reasoningEffort = record.defaultEffort != null ? String(record.defaultEffort) : undefined;
  const out = { provider, model };
  if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort;
  return out;
}

export const MODEL_TIER = Object.freeze({
  FREE: "free",
  FREE_QUOTA: "free_quota",
  PAID: "paid"
});

export const MODEL_TIER_WEIGHT = Object.freeze({
  free: 1.0,
  free_quota: 0.98,
  paid: 0.95
});

/**
 * Normalize a raw model record into our model record.
 *
 * @param {object} raw
 * @param {string} raw.name
 * @param {string} [raw.provider]
 * @param {string} [raw.tier]
 * @param {string} [raw.type]  e.g. free / pro / enterprise
 * @param {string[]} [raw.goodAt]
 * @param {string[]} [raw.badAt]
 * @returns {object}
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new TypeError("model record must have a non-empty string `name`");
  }

  const {
    tier,
    type,
    name: __name,
    provider: __provider,
    goodAt: __rawGoodAt,
    badAt: __rawBadAt,
    ...rest
  } = raw;

  const name = __name.trim();
  const provider = typeof __provider === "string" ? __provider.trim() : "";
  const rawTier = tier || type || "";
  const goodAt = Array.isArray(__rawGoodAt)
    ? __rawGoodAt.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const badAt = Array.isArray(__rawBadAt)
    ? __rawBadAt.map((s) => String(s).trim()).filter(Boolean)
    : [];

  // Providers may bake the price into the display name (`Hy3 · x0.00`). Keep
  // the full name for display but expose the plain name and the parsed
  // multiplier separately, so config keys / blacklist / logs can use the
  // stable form while the UI can still show the price.
  const parsedMultiplier = parsePriceMultiplier(name);

  return {
    name,
    plainName: stripPriceSuffix(name),
    provider,
    rawTier,
    goodAt,
    badAt,
    priceMultiplier: parsedMultiplier === null ? undefined : parsedMultiplier,
    status: MODEL_STATUS.AVAILABLE,
    ...rest
  };
}

/**
 * The stable identity keys one model can be blacklisted by.
 *
 * Blacklisting used to compare against `name` only. That breaks whenever two
 * catalog entries share a display name once the price suffix is stripped —
 * e.g. `Hy3 · x0.00` and `Hy3 · x0.05` are DIFFERENT models (`hy3` vs
 * `hy3-x`) and must be exclude-able independently. So we match on, in order:
 *
 *  1. `id`     — `provider/model`, the canonical key from the catalog
 *  2. `model`  — the bare model id
 *  3. `name`   — the full display name, kept only so older configs that
 *                blacklisted by display name still work
 *
 * `plainName` is deliberately NOT matched: it is the colliding form.
 *
 * @param {object} model
 * @returns {string[]}
 */
export function blacklistKeys(model) {
  if (!model || typeof model !== "object") return [];
  const keys = [];
  for (const v of [model.id, model.model, model.name]) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && !keys.includes(s)) keys.push(s);
  }
  return keys;
}

/**
 * True when the model is excluded by the blacklist.
 *
 * @param {object} model
 * @param {string[]} blacklist
 * @returns {boolean}
 */
export function isBlacklisted(model, blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return false;
  const set = new Set(blacklist.map((v) => String(v).trim()).filter(Boolean));
  return blacklistKeys(model).some((k) => set.has(k));
}

/**
 * True when `key` refers to this model, using the same identity keys as the
 * blacklist (id → bare model id → full display name).
 *
 * Used wherever config points at a specific model (`defaultModel`,
 * `routingTable[].defaultModel`) so `hy3` and `hy3-x` stay distinguishable
 * even though both display as `Hy3 · xN.NN`.
 *
 * @param {object} model
 * @param {string} key
 * @returns {boolean}
 */
export function modelMatchesKey(model, key) {
  const want = String(key ?? "").trim();
  if (!want) return false;
  return blacklistKeys(model).includes(want);
}

/**
 * Find one model in a list by id / bare model id / full display name.
 *
 * @param {object[]} models
 * @param {string} key
 * @returns {object|undefined}
 */
export function findModel(models, key) {
  if (!Array.isArray(models)) return undefined;
  return models.find((m) => modelMatchesKey(m, key));
}

/**
 * Applies the user's plan-level filters:
 *  - excluded models → EXCLUDED
 *  - directory absent → UNAVAILABLE
 *
 * @param {object} model
 * @param {string[]} blacklist entries match by id, bare model id, or full name
 * @param {boolean} directoryHasModel
 * @returns {object}
 */
export function applyPlanFilters(model, blacklist, directoryHasModel) {
  const m = { ...model };

  if (!directoryHasModel && m.status === MODEL_STATUS.AVAILABLE) {
    m.status = MODEL_STATUS.UNAVAILABLE;
  }

  if (isBlacklisted(m, blacklist)) {
    m.status = MODEL_STATUS.EXCLUDED;
  }

  return m;
}

/**
 * Returns the ordered list of allowed model tiers. This is the single source
 * of truth for "cheap tiers first, paid last".
 *
 * @param {string[]} [customOrder]
 * @returns {string[]}
 */
export function resolveTierOrder(customOrder = []) {
  const defaults = ["free", "free_quota", "paid"];
  if (customOrder.length === 0) return defaults;
  const dedupe = [];
  for (const t of customOrder) {
    if (t && !dedupe.includes(t)) dedupe.push(t);
  }
  // Unknown items stay at the end so we never silently drop them, but we
  // only append the ones that weren't already a known default.
  for (const t of customOrder) {
    if (t && !defaults.includes(t) && !dedupe.includes(t)) {
      dedupe.push(t);
    }
  }
  return dedupe;
}

/**
 * Tiers that cost nothing, or so close to nothing that they should be ranked
 * against each other by capability instead of by price.
 *
 * `free` (multiplier 0) and `free_quota` (≤0.15) both draw from a subscription
 * the user already pays for, so preferring a 0-cost model that is *bad* at the
 * task over a 0.08-cost model that is *good* at it is a bad trade: the amount
 * saved rounds to nothing, while the quality loss is real.
 *
 * Used by Router to form a "cheap band" — everything in here is ranked
 * together by match score, and only when that band is exhausted does routing
 * fall through to `paid`.
 *
 * @param {string[]} [tiers]
 * @returns {string[]}
 */
export const DEFAULT_CHEAP_BAND = Object.freeze(["free", "free_quota"]);

/**
 * Split the tier order into bands: one band holding every "cheap" tier, then
 * one band per remaining tier. Order is preserved, so a custom `modelTiers`
 * order still decides which band is tried first.
 *
 * @param {string[]} tierOrder e.g. ["free", "free_quota", "paid"]
 * @param {string[]} [cheapTiers] tiers that merge into the first band
 * @returns {string[][]} e.g. [["free","free_quota"], ["paid"]]
 */
export function resolveTierBands(tierOrder = [], cheapTiers = DEFAULT_CHEAP_BAND) {
  const cheap = new Set((cheapTiers || []).map((t) => String(t).toLowerCase()));
  const band = [];
  const bands = [];
  for (const tier of tierOrder) {
    if (cheap.has(String(tier).toLowerCase())) {
      band.push(tier);
      continue;
    }
    if (band.length) {
      bands.push(band.splice(0));
    }
    bands.push([tier]);
  }
  if (band.length) bands.push(band);
  return bands;
}

/**
 * Rank available models within the same tier by capability match.
 * Higher wins.
 *
 * Each entry also carries `matched`: whether the score came from a REAL
 * positive capability match (`goodAt` hit) rather than from "nobody in this
 * tier is labelled" tie-breaking at 0. A 0-score winner is still returned —
 * the caller decides what to do with it — but callers and the panel must be
 * able to tell the two apart, otherwise a fallback looks like a match.
 *
 * @param {object[]} models
 * @param {object} task
 * @param {string[]} task.required
 * @param {string[]} task.optional
 * @returns {{ model: object, score: number, matched: boolean }[]}
 */
export function rankWithinTier(models, task) {
  const scored = models
    .filter((m) => m.status === MODEL_STATUS.AVAILABLE)
    .map((m) => {
      const s = matchScore(m, task);
      return { model: m, score: s, matched: hasPositiveMatch(m, task) };
    })
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Compute a capability match score for one model against one task.
 *
 * The intent:
 *  - required domains: if the model is good at them, big bonus;
 *    if the model is bad at them, heavy penalty.
 *  - optional domains: small bonus/penalty.
 * Results can be negative; `Number.isFinite` is used downstream to drop
 * degenerate matches.
 *
 * @param {object} model
 * @param {object} task
 * @param {string[]} task.required
 * @param {string[]} task.optional
 * @returns {number}
 */
export function matchScore(model, task) {
  const good = new Set(model.goodAt || []);
  const bad = new Set(model.badAt || []);

  const required = task.required || [];
  const optional = task.optional || [];
  const all = new Set([...required, ...optional]);

  let score = 0;
  for (const d of all) {
    const isRequired = required.includes(d);
    const inGood = good.has(d);
    const inBad = bad.has(d);

    if (inGood && inBad) {
      // contradictory label; treat as neutral to avoid double-counting
      continue;
    }
    if (inGood) {
      score += isRequired ? 10 : 2;
    } else if (inBad) {
      score += isRequired ? -10 : -2;
    }
  }
  return score;
}

/**
 * Does this model have a REAL positive capability claim for the task?
 *
 * `matchScore() === 0` is ambiguous: it can mean "the model is labelled and
 * simply not relevant", or "the model carries no tags at all". Only the first
 * is a considered outcome. This predicate answers "did a `goodAt` entry
 * actually fire for one of the task domains", which is what the panel needs in
 * order to label a pick as "matched" instead of "fallback".
 *
 * A domain tagged in BOTH lists counts as no statement (same rule as
 * `matchScore`), so it does not return true.
 *
 * @param {object} model
 * @param {object} task
 * @param {string[]} task.required
 * @param {string[]} task.optional
 * @returns {boolean}
 */
export function hasPositiveMatch(model, task) {
  const good = new Set(model.goodAt || []);
  const bad = new Set(model.badAt || []);
  const required = task.required || [];
  const optional = task.optional || [];
  for (const d of new Set([...required, ...optional])) {
    if (good.has(d) && !bad.has(d)) return true;
  }
  return false;
}

/**
 * Prefix a per-model diagnostic error onto the model record. Used when the
 * plugin cannot read the real model list from DSH.
 *
 * @param {object} model
 * @param {string} reason
 * @returns {object}
 */
export function withDiagnostic(model, reason) {
  return { ...model, __diagnostic__: reason };
}
