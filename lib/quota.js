// quota.js — quota estimation & monitoring
//
// Two concerns:
//  1. estimateCost(subagent) — predict how much of a model's credit a
//     subagent is likely to consume, so we don't start a task the model
//     will run out of mid-flight.
//  2. pollQuota(model) — ask DSH for the model's current remaining credit,
//     so we can switch before it hits zero.
//
// DSH does not publish a standard "remaining credit" field on its model
// records yet. We keep the hook overridable and default to "unknown":
// unknown means "assume OK, but log a warning so the user can plug in a
// real source later". This keeps the plugin functional today and honest
// about the approximation.

/** Arbitrary cost unit; the plugin treats all costs in the same internal unit. */
export const Quota = Object.freeze({
  UNKNOWN: -1,
  NONE: 0
});

/**
 * Estimate the credit cost of a subagent task.
 *
 * The estimate is intentionally coarse and configurable. It is used only
 * at startup to avoid choosing a model that will exhaust before the task
 * finishes.
 *
 * @param {object} subtask
 * @param {string} subtask.category
 * @param {string} [subtask.description]
 * @param {number} [subtask.estimatedTokens]
 * @param {number} [subtask.searchDepth]  larger → more tool calls
 * @param {boolean} [subtask.needsTools]  true → heavier use of tools
 * @returns {number} estimated cost in internal units, >= 0, or -1 if unknown
 */
export function estimateCost(subtask = {}) {
  const category = String(subtask.category || "").toLowerCase();
  const description = String(subtask.description || "");
  const estimatedTokens = Number(subtask.estimatedTokens);
  const searchDepth = Number(subtask.searchDepth || 0);
  const needsTools = Boolean(subtask.needsTools);

  // Base tier: category determines the floor. Coding/research are bigger;
  // writing/summarizing are smaller; background/brief tasks are smallest.
  let base = 0;
  if (["coding", "code", "research"].includes(category)) base = 80;
  else if (["analysis", "summarize", "summarization"].includes(category)) base = 40;
  else if (["writing", "edit", "review", "design"].includes(category)) base = 45;
  else base = 30;

  // Duration/difficulty ramp.
  let ramp = 0;
  if (estimatedTokens) ramp += estimatedTokens / 400000;
  ramp += Math.min(searchDepth || 0, 6) * 0.15;
  if (needsTools) ramp += 0.4;

  const raw = base + ramp;
  if (raw < 0 || !Number.isFinite(raw)) return Quota.UNKNOWN;
  return Math.max(0, Math.round(raw * 100));
}

// ---- provider account balance -------------------------------------------
//
// Some DSH providers expose their account balance over a local HTTP route on
// the host web server. Those are the ONLY providers whose remaining quota this
// plugin can actually observe, which makes them the only ones the router can
// treat as dependable (see `requireQuotaAware` in the router).
//
// Verified against this build (paths are relative to the web server origin,
// and — importantly — they do NOT carry the npm scope):
//   workbuddy  GET /plugins/dsh-connect-workbuddy/account-credits
//              → { accounts: [{ id, accountName, selected, credits }] }
//   qoder      GET /plugins/dsh-connect-qoder/usage
//              → { regions: [{ userQuota: { remaining, total, used } }] }
//
// Providers with no such route (trae, deepseek-account, our-free-model, …)
// are deliberately absent: their balance can change or vanish without us ever
// seeing it, so they stay visible in the panel but out of the routing pool.
export const QUOTA_SOURCES = Object.freeze({
  workbuddy: {
    path: "/plugins/dsh-connect-workbuddy/account-credits",
    // Multi-account: use the account the user selected in DSH, else the first.
    parse(json) {
      const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
      if (accounts.length === 0) return null;
      const picked = accounts.find((a) => a && a.selected === true) || accounts[0];
      const credits = Number(picked?.credits);
      if (!Number.isFinite(credits)) return null;
      return { remaining: credits, total: undefined, label: picked?.accountName };
    }
  },
  qoder: {
    path: "/plugins/dsh-connect-qoder/usage",
    parse(json) {
      const regions = Array.isArray(json?.regions) ? json.regions : [];
      for (const region of regions) {
        const quota = region?.userQuota;
        const remaining = Number(quota?.remaining);
        if (Number.isFinite(remaining)) {
          const total = Number(quota?.total);
          return {
            remaining,
            total: Number.isFinite(total) ? total : undefined,
            label: region?.userType
          };
        }
      }
      return null;
    }
  }
});

/** Providers whose balance this plugin can read out of the box. */
export const DEFAULT_QUOTA_AWARE_PROVIDERS = Object.freeze(Object.keys(QUOTA_SOURCES));

// ---------------------------------------------------------------------------
// Account-backed providers
//
// Separate axis from "can we read its balance". A provider is account-backed
// when the user signs into a real account for it, so the pool behind it is a
// paid/quota subscription rather than a rotating free firehose. We cannot read
// `trae`'s or `deepseek-account`'s balance (probed 10 candidate routes, all
// 404 — those plugins expose no usage API), but the models behind them are
// still the ones worth delegating to, so they stay routable on the strength of
// the account relationship alone.
//
// Deliberately NOT in here: `our-free-model` (33 models). It has no account,
// no login state and no usage endpoint — its credits are cleared whenever the
// upstream feels like it. Those models stay visible in the panel but out of
// the automatic pool, per the design decision that only account-backed
// providers get to spawn subagents.
// ---------------------------------------------------------------------------
export const DEFAULT_ACCOUNT_BACKED_PROVIDERS = Object.freeze([
  ...DEFAULT_QUOTA_AWARE_PROVIDERS,
  "trae",
  "deepseek-account"
]);

/**
 * Account-backed provider ids: the built-in set plus user additions.
 * Union semantics, same as the quota-aware set — `[]` does not clear it.
 *
 * @param {string[]} [extra] from `config.accountBackedProviders`
 * @returns {string[]} lowercase provider ids
 */
export function resolveAccountBackedProviders(extra) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const p of DEFAULT_ACCOUNT_BACKED_PROVIDERS) push(p);
  if (Array.isArray(extra)) for (const p of extra) push(p);
  return out;
}

/**
 * @param {string} provider
 * @param {string[]} [backed] lowercase ids from resolveAccountBackedProviders()
 * @returns {boolean}
 */
export function isAccountBackedProvider(provider, backed = DEFAULT_ACCOUNT_BACKED_PROVIDERS) {
  const p = String(provider ?? "").trim().toLowerCase();
  if (!p) return false;
  return (backed || []).some((a) => String(a).trim().toLowerCase() === p);
}

/**
 * Providers treated as "quota-aware": the built-in set plus anything the user
 * adds (a custom provider that also exposes a balance route, read through
 * `quotaCustomSources`). Union semantics — there is no way to subtract from
 * the built-in set, because the gate is about *observability*, not preference.
 * To route to a non-observable model anyway, whitelist the model itself
 * (`routableOverrides`) instead of disabling the gate globally.
 *
 * @param {string[]} [extra] from `config.quotaAwareProviders`
 * @returns {string[]} lowercase provider ids
 */
export function resolveQuotaAwareProviders(extra) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const p of DEFAULT_QUOTA_AWARE_PROVIDERS) push(p);
  if (Array.isArray(extra)) for (const p of extra) push(p);
  return out;
}

/**
 * @param {string} provider
 * @param {string[]} [aware] lowercase ids from resolveQuotaAwareProviders()
 * @returns {boolean}
 */
export function isQuotaAwareProvider(provider, aware = DEFAULT_QUOTA_AWARE_PROVIDERS) {
  const p = String(provider ?? "").trim().toLowerCase();
  if (!p) return false;
  return (aware || []).some((a) => String(a).trim().toLowerCase() === p);
}

/**
 * Read the account balance of every quota-aware provider over the host's own
 * web server. Never throws: a provider whose route is missing, slow or
 * unparsable is reported in `failures` and simply has no balance attached,
 * which the router handles as "unobservable" rather than "zero".
 *
 * @param {string} origin e.g. `http://127.0.0.1:64754` (webServer.getOrigin())
 * @param {string[]} providers lowercase provider ids to try
 * @param {object} [options]
 * @param {function} [options.fetchImpl] injectable for tests
 * @param {number} [options.timeoutMs] default 4000
 * @returns {Promise<{ quotas: Map<string, object>, failures: string[] }>}
 */
export async function readProviderQuotas(origin, providers, options = {}) {
  const quotas = new Map();
  const failures = [];
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base) return { quotas, failures: ["no web server origin"] };
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
  if (typeof fetchImpl !== "function") return { quotas, failures: ["no fetch implementation"] };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;

  await Promise.all(
    (providers || []).map(async (rawId) => {
      const id = String(rawId || "").trim().toLowerCase();
      const source = QUOTA_SOURCES[id];
      if (!source) return; // not a built-in quota-aware provider; nothing to read
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const res = await fetchImpl(base + source.path, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller?.signal
        });
        if (!res || !res.ok) {
          failures.push(`${id}: HTTP ${res?.status ?? "?"}`);
          return;
        }
        const parsed = source.parse(await res.json());
        if (!parsed) {
          failures.push(`${id}: unexpected payload`);
          return;
        }
        quotas.set(id, {
          remaining: parsed.remaining,
          total: parsed.total,
          label: parsed.label,
          source: source.path,
          readAt: Date.now()
        });
      } catch (err) {
        failures.push(`${id}: ${err?.message || String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );

  return { quotas, failures };
}

/**
 * Return the current remaining credit for a model, or Quota.UNKNOWN.
 *
 * Kept as a hook for callers that already know a model's balance; the real
 * reading happens per PROVIDER in `readProviderQuotas` above, because the
 * balance is an account property, not a per-model one.
 *
 * @type {function(model): number}
 */
export const pollQuota = (model) => {
  const remaining = Number(model?.remainingCredit);
  return Number.isFinite(remaining) && remaining >= 0 ? remaining : Quota.UNKNOWN;
};

/**
 * Pre-flight check: is `candidate` credit-safe for `subtask`?
 *
 * @param {object} candidate
 * @param {number} candidate.remainingCredit
 * @param {number} subtaskEst
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isCreditSafe(candidate, subtaskEst) {
  const remaining = Number(candidate.remainingCredit);
  if (!Number.isFinite(remaining) || remaining < 0) {
    return { ok: true, reason: "unknown-credits" };
  }
  if (remaining <= Quota.NONE) {
    return { ok: false, reason: "empty-quota" };
  }
  if (remaining < subtaskEst && subtaskEst > 0) {
    return { ok: false, reason: "quota-too-low" };
  }
  return { ok: true };
}

/**
 * Normalize a DSH model record into a model record that carries quota info.
 * The router then filters on `status`/`remainingCredit` rather than on the
 * raw `tier` only.
 */
export function enrichModelWithQuota(model, remainingCredit) {
  const m = { ...model };
  const remaining = Number(remainingCredit);
  if (Number.isFinite(remaining) && remaining >= 0) {
    m.remainingCredit = remaining;
  } else {
    m.remainingCredit = Quota.UNKNOWN;
  }
  return m;
}
