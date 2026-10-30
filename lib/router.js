// router.js — the core routing engine
//
// Public contract:
//  Router(config, modelSource, taskClassifier)
//    .select(subtask) → chosen model record, or null when nothing is usable.
//    .switchCost(modelA, modelB) → boolean, useful for decision logs.
//
// Algorithm:
//  1. Normalize the current model list (status: available/excluded/unavailable).
//  2. Group tiers into bands. By default `free` and `free_quota` form one
//     "cheap band" ranked by capability, and `paid` is its own band — both
//     cheap tiers come out of the same subscription, so preferring a free model
//     that is bad at the task over a 0.08-cost model that is good at it saves
//     nothing and costs quality.
//  3. Within each band, rank by manual priority first, capability match second.
//     A priority the user set by hand is a decision; a score is an inference
//     from tags that are often only a family-level guess.
//  4. Pick the top-scoring available model. If nobody in the band claims the
//     task domain, escalate to a pricier band only when that band has a REAL
//     match. A pinned model never escalates.
//  5. Fall through to the configured default model when nothing is usable.
//  6. Re-check credit at spawn time; if the chosen model is credit-safe,
//     commit. Otherwise, hand back a `fallback` instead of crashing.

import { normalizeModel, applyPlanFilters, resolveTierOrder, resolveTierBands, DEFAULT_CHEAP_BAND, rankWithinTier, matchScore, hasPositiveMatch, inferTier, findModel, blacklistKeys, resolveExcludedProviders, isExcludedProvider, routeGate } from "./models.js";
import { estimateCost, pollQuota, isCreditSafe, enrichModelWithQuota, resolveQuotaAwareProviders, resolveAccountBackedProviders, readProviderQuotas } from "./quota.js";
import { parseTags, mergeTags } from "./tags.js";
import { applyPresets } from "./presets.js";
import { readOverrides, priorityOf, isRoutableOverride, sanitizeOverrides } from "./overrides.js";

export class Router {
  constructor(config, modelSource, taskClassifier) {
    this.config = config || {};
    this.modelSource = modelSource;
    this.taskClassifier = taskClassifier || ((_) => ({ required: [], optional: [] }));

    this.tierOrder = resolveTierOrder(config.modelTiers || []);
    // "Cheap band": free + free_quota are ranked against each other rather than
    // price-first, because both are effectively covered by the subscription.
    // Set `cheapBand: []` to get strict tier-walking back.
    this.cheapBand = Array.isArray(config.cheapBand)
      ? [...config.cheapBand]
      : [...DEFAULT_CHEAP_BAND];
    this.tierBands = resolveTierBands(this.tierOrder, this.cheapBand);
    this.blacklist = Array.isArray(config.blacklist) ? [...config.blacklist] : [];
    this.defaultModel = String(config.defaultModel || "").trim();
    this.routingTable = Array.isArray(config.routingTable) ? config.routingTable : [];
    // Eligibility gate: only account-backed providers get to spend a
    // subagent — either one whose balance we can read, or one the user signed
    // into (trae/deepseek-account publish no balance route but are still real
    // accounts). Models from rotating free firehoses stay visible but out.
    // `requireQuotaAware: false` is the documented escape hatch.
    this.quotaAwareProviders = resolveQuotaAwareProviders(config.quotaAwareProviders);
    this.accountBackedProviders = resolveAccountBackedProviders(config.accountBackedProviders);
    this.routableOverrides = Array.isArray(config.routableOverrides) ? [...config.routableOverrides] : [];
    this.requireQuotaAware = config.requireQuotaAware !== false;
    // Panel-managed overrides (manual priority + per-model routable). They live
    // in their own file, not the profile config, so one `unlink` restores the
    // whole automatic behaviour. Loading them here means the router is already
    // correct on the first select() after a restart, without waiting for the
    // panel to be opened.
    this.overridesPath = config.overridesPath || undefined;
    this.overrides = readOverrides(this.overridesPath);
    // Escalation (option "B"): when the cheap band has no model that actually
    // claims the task domain, look further up the price ladder for one that
    // does, instead of spending the subagent on a 0-score tie-break.
    // `escalateOnMiss: false` restores strict band-first behavior.
    this.escalateOnMiss = config.escalateOnMiss !== false;
    // Only escalate to a model that is a REAL match (score > 0). Without this
    // the router would pay 4.5x for another guess, which is strictly worse than
    // keeping the cheap one.
    this.escalateMinScore = Number.isFinite(config.escalateMinScore)
      ? config.escalateMinScore
      : 1;
    // Latest per-provider balances, refreshed by `refreshQuotas()`.
    this.quotaByProvider = new Map();
    this.log = config.log || (() => {});
  }

  /**
   * Read every quota-aware provider's balance through the host web server and
   * cache it on the models. Called on refresh and by the quota monitor.
   *
   * Never throws — a provider we cannot read simply has no balance attached,
   * which the router treats as "unobservable", not "empty".
   *
   * @param {string} origin web server origin, e.g. `http://127.0.0.1:64754`
   * @param {object} [options] forwarded to readProviderQuotas (fetchImpl, timeoutMs)
   * @returns {Promise<{ ok: boolean, providers: string[], failures: string[] }>}
   */
  async refreshQuotas(origin, options = {}) {
    const providers = this.quotaAwareProviders.slice();
    const result = await readProviderQuotas(origin, providers, options);
    if (result.quotas && result.quotas.size) {
      this.quotaByProvider = result.quotas;
    }
    for (const m of this.models || []) {
      const id = String(m.provider || "").trim().toLowerCase();
      const quota = this.quotaByProvider.get(id);
      if (quota && Number.isFinite(quota.remaining)) {
        m.remainingCredit = quota.remaining;
        m.quotaLabel = quota.label;
        m.quotaTotal = quota.total;
      }
    }
    const failures = result.failures || [];
    if (failures.length) this.log(`quota read failed: ${failures.join("; ")}`);
    return { ok: failures.length === 0, providers, failures };
  }

  /**
   * Should this model be allowed into the routing pool at all?
   *
   * @param {object} model
   * @returns {boolean}
   */
  isRoutable(model) {
    if (!this.requireQuotaAware) return true;
    // A panel-managed "放行" beats the provider gate: the user looked at this
    // exact model and said yes, which is strictly more information than the
    // provider having no balance route.
    if (isRoutableOverride(this.overrides, model?.id)) return true;
    return routeGate(model, {
      quotaAwareProviders: this.quotaAwareProviders,
      accountBackedProviders: this.accountBackedProviders,
      routableOverrides: this.routableOverrides
    }).routable;
  }

  /**
   * The gate verdict plus its reason. Split out so `_indexByTier()` can annotate
   * the panel while `isRoutable()` stays a plain boolean.
   *
   * @param {object} model
   * @returns {{ routable: boolean, reason: string }}
   */
  gateFor(model) {
    if (!this.requireQuotaAware) return { routable: true, reason: "gate-disabled" };
    if (isRoutableOverride(this.overrides, model?.id)) {
      return { routable: true, reason: "override" };
    }
    return routeGate(model, {
      quotaAwareProviders: this.quotaAwareProviders,
      accountBackedProviders: this.accountBackedProviders,
      routableOverrides: this.routableOverrides
    });
  }

  /**
   * Manual priority for one model (0 = no opinion). Larger wins.
   *
   * @param {object} model
   * @returns {number}
   */
  priorityFor(model) {
    return priorityOf(this.overrides, model?.id);
  }

  /**
   * Replace the whole override store (the panel writes through this) and
   * re-index so gate changes take effect immediately.
   *
   * @param {object} next
   */
  setOverrides(next) {
    this.overrides = sanitizeOverrides(next);
    this._indexByTier();
    return this.overrides;
  }

  /**
   * Re-read the model list from the source. The UI uses this for refresh.
   */
  async refreshModels() {
    const rawList = await this.modelSource.getModelList();
    const tierMap = this.config.tierMap || {};
    const pricing = this.config.pricing || {};
    const tags = this.config.tags || {};
    // Defensive second pass. The catalog reader already skips excluded
    // providers before spending adapter calls, but a custom model source can
    // hand us anything, and the router must never route to an excluded one.
    const excludedProviders = resolveExcludedProviders(this.config.excludedProviders);
    const normalized = rawList
      .filter((r) => !isExcludedProvider(r?.provider, excludedProviders))
      .map((r) => {
        // Directory-sourced models carry no explicit plan tier; infer one so
        // they don't all collapse into "paid" (which would break free-first
        // routing). Order of authority inside inferTier:
        //   config.tierMap > price suffix in the name > keyword heuristics.
        // NOTE: pass the DISPLAY name (`Hy3 · x0.00`), not the model id — the
        // price suffix lives only on the display name, and inferTier parses it.
        if (!r.tier && !r.type) {
          r = { ...r, tier: inferTier(r.id, r.provider, r.name || r.model, r.description, tierMap, pricing) };
        }
        return normalizeModel(r);
      })
      // Capability tags. The catalog usually carries none, so every model would
      // score 0 and the per-tier ranking would collapse to directory order.
      // Presets fill the gap; hand-written `tags` in config still win because
      // applyPreset() only fills a side that the record left empty.
      // `tagSource` records where the tags came from so the panel can show
      // "猜测（preset）" vs "手写（config）" — the two carry different trust.
      .map((m) => {
        const tagged = applyPresets([m])[0];
        const hasTags = tagged.goodAt.length > 0 || tagged.badAt.length > 0;
        return { ...tagged, tagSource: hasTags ? "preset" : "" };
      })
      .map((m) => {
        // mergeTags() works on bare tag lists and returns {goodAt,badAt}, so
        // re-attach the result to the record instead of replacing it.
        // `id` is checked as well as `model`/`name`: the canonical key is what
        // the blacklist uses and what the panel shows, so users WILL write it
        // here. Silently ignoring it would look like the tag had no effect.
        const own = tags[m.id] || tags[m.model] || tags[m.name];
        if (!own || typeof own !== "object") return m;
        const merged = mergeTags(m.goodAt, m.badAt, own);
        return { ...m, goodAt: merged.goodAt, badAt: merged.badAt, tagSource: "config" };
      })
      .map((m) => applyPlanFilters(m, this.blacklist, true));

    // Attach quota info if the source provides remainingCredit.
    const withQuota = normalized.map((m) => {
      const remaining =
        m.remainingCredit !== undefined ? m.remainingCredit : pollQuota(m);
      return enrichModelWithQuota(m, remaining);
    });

    this.models = withQuota;
    this._indexByTier();
    return this.models;
  }

  /**
   * Internal: re-apply the blacklist and rebuild the per-tier index.
   *
   * Status must be recomputed here, not just at refresh time: `enable()` /
   * `disable()` change `this.blacklist` and then call this, so without
   * reapplying the filters a model would stay EXCLUDED (or stay available
   * after being blacklisted).
   */
  _indexByTier() {
    // Recompute EXCLUDED/AVAILABLE from the current blacklist. UNAVAILABLE is
    // left alone: it means the directory no longer carries the model.
    this.models = (this.models || []).map((m) => {
      if (m.status === "unavailable") return m;
      const filtered = applyPlanFilters({ ...m, status: "available" }, this.blacklist, true);
      // Annotate the routing gate here (not in refreshModels) so toggling
      // `requireQuotaAware` or editing `routableOverrides` takes effect without
      // a full catalog re-read.
      const gate = this.gateFor(filtered);
      return {
        ...filtered,
        routable: gate.routable,
        gateReason: gate.reason,
        priority: this.priorityFor(filtered)
      };
    });

    this.byTier = {};
    for (const tier of this.tierOrder) {
      this.byTier[tier] = [];
    }

    for (const m of this.models || []) {
      if (m.status !== "available") continue;
      // Drop quota-zero models from the available pool (hard zero = exhausted,
      // not "unknown credit").
      if (typeof m.remainingCredit === "number" && m.remainingCredit === 0) continue;
      // Models from providers whose balance we cannot read never enter the
      // pool: they stay visible in the panel, but cannot spend a subagent.
      if (m.routable === false) continue;
      const tier = m.rawTier || "paid";
      if (!this.tierOrder.includes(tier)) this.tierOrder.push(tier);
      this.byTier[tier] = this.byTier[tier] || [];
      this.byTier[tier].push(m);
    }

    // `tierOrder` can grow above (an unknown tier gets appended), and the band
    // grouping is derived from it, so it has to be rebuilt here rather than
    // only in the constructor.
    this.tierBands = resolveTierBands(this.tierOrder, this.cheapBand);
  }

  /**
   * Rank one band's models for a task.
   *
   * Order is **manual priority first, capability score second** (both descending).
   * That is deliberate: a priority the user set by hand is a decision, while a
   * score is an inference from tags that are often only a family-level guess.
   * If score won, raising the priority of an untagged model would do nothing and
   * the control would be a lie.
   *
   * Ties keep directory order (Array.prototype.sort is stable), which is what
   * the 0-score fallback case relies on.
   *
   * @param {object[]} pool
   * @param {object} task
   * @returns {{ model: object, score: number, matched: boolean, priority: number }[]}
   */
  _rank(pool, task) {
    return rankWithinTier(pool, task)
      .map((e) => ({ ...e, priority: this.priorityFor(e.model) }))
      .sort((a, b) => b.priority - a.priority || b.score - a.score);
  }

  /**
   * Select the model for a subagent task.
   *
   * @param {object} subtask
   * @param {string} subtask.category
   * @param {string} [subtask.description]
   * @param {object} [selectOpts]
   * @param {string[]} [selectOpts.allowedProviders] optional provider allowlist
   *   (a session-policy safety valve: when non-empty, only models whose
   *   `provider` is listed may be chosen).
   * @returns {{ model: object|null, reason: string, tier?: string, choseDefault?: boolean }}
   */
  select(subtask = {}, selectOpts = {}) {
    const category = String(subtask.category || "").toLowerCase() || "general";
    const task = this.taskClassifier(category, subtask);

    const allow = Array.isArray(selectOpts.allowedProviders) && selectOpts.allowedProviders.length
      ? new Set(selectOpts.allowedProviders.map(String))
      : null;
    const withinAllow = (m) => (!allow || allow.has(m.provider)) && this.isRoutable(m);

    // Category routing table: optional per-category default model.
    const tableMatch = this.routingTable.find(
      (r) => String(r.category || "").toLowerCase() === category
    );
    if (tableMatch && tableMatch.defaultModel) {
      // Match by id / bare model id / full name — display names collide once
      // the price suffix is stripped (Hy3 · x0.00 vs Hy3 · x0.05).
      const picked = findModel(this.models, tableMatch.defaultModel);
      if (picked && picked.status === "available" && withinAllow(picked)) {
        return {
          model: picked,
          reason: "route-table",
          score: null,
          matched: null,
          priority: this.priorityFor(picked),
          pinned: true
        };
      }
    }

    // Manual priority (the panel's ↑/↓ control).
    //
    // A pinned model competes GLOBALLY, ahead of band walking: it is ranked by
    // (priority desc, score desc) against every other pinned model, regardless
    // of price tier. Band order is a default about money; a hand-set priority is
    // an explicit decision by the person paying, and if band order still won
    // then pinning a paid model would silently do nothing (the cheap band is
    // practically never empty). This is also why pinning suppresses escalation
    // below — the user already chose the model.
    const pinned = (this.models || [])
      .filter((m) => m.status === "available" && withinAllow(m))
      .map((m) => ({ model: m, priority: this.priorityFor(m) }))
      .filter((e) => e.priority > 0);
    if (pinned.length) {
      const rankedPinned = pinned
        .map((e) => ({ ...e, score: matchScore(e.model, task), matched: hasPositiveMatch(e.model, task) }))
        .sort((a, b) => b.priority - a.priority || b.score - a.score);
      const top = rankedPinned[0];
      return {
        model: top.model,
        reason: `priority=${top.priority} score=${top.score} (pinned, band order bypassed)`,
        tier: top.model.rawTier || "paid",
        band: [top.model.rawTier || "paid"],
        score: top.score,
        matched: top.matched,
        priority: top.priority,
        pinned: true,
        candidates: rankedPinned.length
      };
    }

    // Band walking. A band is one or more tiers ranked together:
    // `[["free","free_quota"], ["paid"]]` by default, so a 0-cost model that is
    // bad at the task no longer beats a 0.08-cost model that is good at it —
    // both come out of the same subscription, and the price difference rounds
    // to nothing while the quality difference does not.
    // Config `cheapBand: []` restores strict one-tier-at-a-time walking.
    for (const band of this.tierBands) {
      const pool = [];
      for (const tier of band) pool.push(...(this.byTier[tier] || []));
      const ranked = this._rank(pool, task).filter((e) => withinAllow(e.model));
      if (ranked.length && Number.isFinite(ranked[0].score)) {
        const chosen = ranked[0].model;
        const score = ranked[0].score;
        const label = band.length > 1 ? band.join("+") : band[0];
        const madeMatch = ranked[0].matched === true;
        const pinned = ranked[0].priority !== 0;
        const higherBands = this.tierBands.slice(this.tierBands.indexOf(band) + 1);
        // A pinned model suppresses escalation. The user put their hand on this
        // one; silently trading it for a pricier model would undo the whole
        // point of the priority control.
        if (madeMatch || pinned || !this.escalateOnMiss || !higherBands.length) {
          return {
            model: chosen,
            reason: pinned
              ? `band-match ${label} priority=${ranked[0].priority} score=${score} (pinned)`
              : `band-match ${label} score=${score}`,
            tier: chosen.rawTier || band[0],
            band,
            // `matched === false` means the winner won on a 0 score, i.e. nobody
            // in this band claimed the task domain. That is a tie-break by
            // directory order, NOT a capability match — the panel says so.
            score,
            matched: madeMatch,
            // Manual priority that actually decided the pick. 0 = automatic.
            priority: ranked[0].priority,
            pinned,
            // How many candidates were in this band before ranking, so the panel
            // can show "15 个候选里没一个擅长 research".
            candidates: ranked.length
          };
        }
        // Nobody in this band claims the domain. Before settling for a guess,
        // check whether a more expensive band has a real match — paying more
        // for an actual capability match beats paying nothing for a coin flip.
        const upgrade = this._escalate(task, higherBands, withinAllow, band, chosen, score, ranked.length);
        if (upgrade) return upgrade;
        // No band above has a real match either: stay cheap. A pricier guess is
        // not better than a cheap guess.
        return {
          model: chosen,
          reason: `band-match ${label} score=${score}`,
          tier: chosen.rawTier || band[0],
          band,
          score,
          matched: false,
          priority: 0,
          pinned: false,
          candidates: ranked.length
        };
      }
    }

    // No match at all. Fall back to the global default, if set.
    if (this.defaultModel) {
      const picked = findModel(this.models, this.defaultModel);
      if (picked && picked.status === "available" && withinAllow(picked)) {
        return { model: picked, reason: "default-model", choseDefault: true, score: 0, matched: false, priority: this.priorityFor(picked), pinned: false };
      }
    }

    // Ultimate fallback: any available model, even a weak one. Still honours
    // manual priority — a model the user pinned should be the last one standing
    // before we give up entirely.
    for (const band of this.tierBands) {
      const candidates = [];
      for (const tier of band) candidates.push(...(this.byTier[tier] || []));
      const usable = candidates
        .filter(withinAllow)
        .map((m) => ({ model: m, priority: this.priorityFor(m) }))
        .sort((a, b) => b.priority - a.priority);
      if (usable.length) {
        const any = usable[0].model;
        return {
          model: any,
          reason: "any-available",
          tier: any.rawTier || band[0],
          band,
          score: 0,
          matched: false,
          priority: usable[0].priority,
          pinned: false
        };
      }
    }

    // Distinguish "nothing usable" from "the eligibility gate blocked
    // everything": the second one is fixed by config, not by adding models,
    // and the panel must be able to say which it is.
    const gatedOut = (this.models || []).filter(
      (m) => m.status === "available" && m.routable === false
    );
    if (gatedOut.length) {
      const providers = [...new Set(gatedOut.map((m) => m.provider).filter(Boolean))];
      return {
        model: null,
        reason: `no-quota-aware-candidates (${gatedOut.length} model(s) from unreadable-balance provider(s): ${providers.join(", ") || "unknown"})`,
        gatedProviders: providers
      };
    }

    return { model: null, reason: "no-models-available" };
  }

  /**
   * Look for a real capability match in the bands above `fromBand`.
   *
   * Only a model that actually claims the task domain (score >= escalateMinScore)
   * qualifies — escalating to another 0-score tie would mean paying several
   * times more for the same coin flip. Returns null when nothing above matches,
   * so the caller keeps the cheap pick.
   *
   * @param {object} task classified task ({required, optional})
   * @param {string[][]} bands candidate bands, cheapest first
   * @param {Function} withinAllow filter predicate (allowlist + route gate)
   * @param {string[]} fromBand the band we are escalating away from
   * @param {object} cheapPick the model that would otherwise be used
   * @param {number} cheapScore its score (0 or negative)
   * @param {number} cheapCandidates how many models tied in the cheap band
   * @returns {object|null} selection result, or null when staying cheap is right
   */
  _escalate(task, bands, withinAllow, fromBand, cheapPick, cheapScore, cheapCandidates) {
    for (const band of bands) {
      const pool = [];
      for (const tier of band) pool.push(...(this.byTier[tier] || []));
      const ranked = this._rank(pool, task)
        .filter((e) => withinAllow(e.model))
        .filter((e) => e.matched === true && e.score >= this.escalateMinScore);
      if (!ranked.length) continue;
      const chosen = ranked[0].model;
      const label = band.length > 1 ? band.join("+") : band[0];
      return {
        model: chosen,
        reason: `escalated ${fromBand.join("+")}→${label} score=${ranked[0].score} (cheap band had no match)`,
        tier: chosen.rawTier || band[0],
        band,
        score: ranked[0].score,
        matched: true,
        candidates: ranked.length,
        // Record what was traded away, so the panel and the log can say
        // "cheap band had 15 candidates, none matched" rather than silently
        // spending more money.
        escalated: true,
        skipped: {
          band: fromBand,
          modelId: cheapPick?.id || "",
          modelName: cheapPick?.name || "",
          score: cheapScore,
          candidates: cheapCandidates
        }
      };
    }
    return null;
  }

  /**
   * Pre-flight credit check on the chosen result before we commit it to a
   * subagent launch. Returns the same result shape, but may add a
   * `fallback` when the chosen model is credit-insufficient.
   */
  async shadow(selectResult, subtask = {}) {
    if (!selectResult || !selectResult.model) return selectResult;

    const chosen = selectResult.model;
    const est = estimateCost(subtask);
    const safe = isCreditSafe(chosen, est);

    if (safe.ok === false && safe.reason === "quota-too-low") {
      // Cheap, deterministic swap: pick the next best available model in the
      // same tier, then next tier, then default. We do not mutate the caller's
      // object; we return a new one.
      const task = this.taskClassifier(subtask.category || "", subtask);
      const fallback = this._pickFallback(chosen, task);
      if (fallback) {
        return { ...selectResult, model: fallback, reason: `quota-shrink → ${fallback.name}` };
      }
    }

    return selectResult;
  }

  _pickFallback(chosen, task) {
    // Compare by identity (id / bare model id), not display name: two catalog
    // entries can share the plain name once the price suffix is stripped.
    const skipKeys = new Set(blacklistKeys(chosen));
    for (const band of this.tierBands) {
      const pool = [];
      for (const tier of band) pool.push(...(this.byTier[tier] || []));
      const ranked = rankWithinTier(pool, task);
      for (const entry of ranked) {
        if (blacklistKeys(entry.model).some((k) => skipKeys.has(k))) continue;
        return entry.model;
      }
    }
    return null;
  }

  /**
   * Determine a task's required/optional domain tags for matching.
   * The classifier is injected by the plugin; default behavior:
   * anything the task's category maps to, plus freeform from description.
   */
  classify(category, subtask) {
    return this.taskClassifier(category, subtask);
  }

  /**
   * Canonicalize one blacklist entry.
   *
   * Blacklist matching accepts an id (`workbuddy/hy3`), a bare model id
   * (`hy3`) or a full display name (`Hy3 · x0.00`). Whenever the entry
   * resolves to a model in the current catalog we store its **id**, so the
   * list stays stable even if the provider later changes the display name or
   * the price suffix. Unresolvable entries are kept verbatim.
   *
   * @param {string} key
   * @returns {string}
   */
  _canonicalKey(key) {
    const raw = String(key ?? "").trim();
    if (!raw) return "";
    const hit = findModel(this.models, raw);
    return hit && hit.id ? String(hit.id) : raw;
  }

  setBlacklist(names) {
    const out = [];
    for (const n of Array.isArray(names) ? names : []) {
      const k = this._canonicalKey(n);
      if (k && !out.includes(k)) out.push(k);
    }
    this.blacklist = out;
    this._indexByTier();
  }

  /** Re-enable previously excluded models. */
  enable(names) {
    const set = new Set(this.blacklist);
    for (const n of Array.isArray(names) ? names : []) {
      const k = this._canonicalKey(n);
      if (k) set.delete(k);
      // Also drop the raw form, so an entry stored before canonicalization
      // (or an unresolvable one) can still be removed by hand.
      const raw = String(n ?? "").trim();
      if (raw) set.delete(raw);
    }
    this.blacklist = [...set];
    this._indexByTier();
  }

  /** Disable (exclude) more models. */
  disable(names) {
    const set = new Set(this.blacklist);
    for (const n of Array.isArray(names) ? names : []) {
      const k = this._canonicalKey(n);
      if (k) set.add(k);
    }
    this.blacklist = [...set];
    this._indexByTier();
  }
}
