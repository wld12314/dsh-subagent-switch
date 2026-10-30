// presets.js — built-in capability tags ("goodAt" / "badAt") per model family
//
// WHY THIS FILE EXISTS
//
// `ctx.llm.listModels()` only returns { provider, id, name, description?,
// inputModalities? }. On a WorkBuddy-backed setup `description` is not even
// forwarded, so every model arrives with no capability signal at all. Without
// tags, every model scores 0 and the "capability match" stage degenerates into
// "take whatever came first in the directory", i.e. all five task categories
// pick the same model.
//
// This table gives the model families that actually exist in a local catalog a
// starting set of tags, matched by model id / name. Everything here is a
// heuristic written from each vendor's published positioning — it is NOT a
// benchmark. Config-level tags always win over these (see router.js), so a
// wrong guess is one line in config away from being corrected.
//
// Tag vocabulary is intentionally the same set the task classifier emits, so
// `matchScore()` can compare them directly:
//   coding, research, writing, summarize, analysis, background, general,
//   long-context, vision, office, agentic

/**
 * Ordered rules. FIRST MATCH WINS, so keep the more specific patterns above
 * the broader ones (`deepseek-v4.1-flash` before `deepseek-v4`,
 * `glm-5.3-flash` before `glm-5.3`, ...).
 *
 * Each rule:
 *   { match: RegExp, goodAt: string[], badAt: string[] }
 *
 * `match` is tested against `<model id> <plain display name>` with the price
 * suffix (`· x0.29`) already stripped.
 */
export const PRESET_RULES = Object.freeze([
  // ---- WorkBuddy first-party -------------------------------------------------
  {
    // Hy4 preview — WorkBuddy's own preview flagship, priced mid-tier.
    match: /^hy4(?:[-\/.]?preview)?\s*$/i,
    goodAt: ["coding", "analysis", "agentic"],
    badAt: ["vision"]
  },
  {
    // Hy3 / Hy3-x — the genuinely free tier; small model. Fine for grunt work,
    // not for anything that has to be right the first time.
    match: /^hy3(?:[-\/.]?x)?\s*$/i,
    goodAt: ["summarize", "background", "general"],
    badAt: ["coding", "research", "analysis"]
  },

  // ---- StepFun ---------------------------------------------------------------
  {
    match: /^step[-\/.]?5(?:[-\/.]?preview)?\s*$/i,
    goodAt: ["coding", "analysis", "agentic"],
    badAt: ["vision"]
  },

  // ---- DeepSeek --------------------------------------------------------------
  {
    // v4.1 Flash — cheap, 1M context; the "read a lot, reason a bit" workhorse.
    match: /^deepseek[-\/]?v4[.\-]1[-\/]?flash\s*$/i,
    goodAt: ["coding", "summarize", "long-context", "general"],
    badAt: ["vision"]
  },
  {
    // v4 Flash without the minor version (`trae/DeepSeek-V4-Flash`) — same role
    // as v4.1 Flash. Kept as its own rule because the minor-version rule above
    // requires the `.1` and would not match.
    match: /^deepseek[-\/]?v4[-\/.]?flash\s*$/i,
    goodAt: ["coding", "summarize", "long-context", "general"],
    badAt: ["vision"]
  },
  {
    // Bare `DeepSeek-Flash` (qoder aliases the flash line without a version).
    match: /^deepseek[-\/]?flash\s*$/i,
    goodAt: ["coding", "summarize", "general"],
    badAt: ["vision"]
  },
  {
    // v4 Pro — general reasoning + long text.
    match: /^deepseek[-\/]?v4[-\/.]?pro\s*$/i,
    goodAt: ["coding", "analysis", "research", "long-context"],
    badAt: ["vision"]
  },
  {
    // v3 / v3.1-Terminus — previous generation. Still a competent general
    // workhorse, but it is not what you reach for when a task needs research.
    match: /^deepseek[-\/]?v3(?:[.\-]1(?:[-\/]?terminus)?)?\s*$/i,
    goodAt: ["coding", "general", "summarize"],
    badAt: ["vision"]
  },

  // ---- Zhipu GLM -------------------------------------------------------------
  {
    match: /^glm[-\/]?5v[-\/]?turbo\s*$/i,
    goodAt: ["vision", "writing"],
    badAt: ["coding", "research"]
  },
  {
    match: /^glm[-\/]?5[.\-]3[-\/]?flash\s*$/i,
    goodAt: ["coding", "summarize", "general"],
    badAt: ["research", "vision"]
  },
  {
    // GLM-5.3 — complex software engineering / long-horizon agent work.
    match: /^glm[-\/]?5[.\-]3\s*$/i,
    goodAt: ["coding", "analysis", "agentic"],
    badAt: ["vision"]
  },
  {
    match: /^glm[-\/]?5[.\-]2\s*$/i,
    goodAt: ["coding", "analysis"],
    badAt: ["vision"]
  },
  {
    match: /^glm[-\/]?5[.\-]1\s*$/i,
    goodAt: ["coding", "general"],
    badAt: ["research", "vision"]
  },

  // ---- Moonshot Kimi ---------------------------------------------------------
  {
    match: /^kimi[-\/]?k3[.\-]1[-\/]?pro\s*$/i,
    goodAt: ["coding", "research", "agentic", "long-context"],
    badAt: ["vision"]
  },
  {
    // Kimi-K3 (id `kimi-k3-1`) — long-horizon autonomy, frontend, sci reasoning.
    match: /^kimi[-\/]?k3(?:[-\/]1)?\s*$/i,
    goodAt: ["coding", "research", "analysis", "agentic"],
    badAt: ["vision"]
  },
  {
    match: /^kimi[-\/]?k2[.\-]8[-\/]?preview\s*$/i,
    goodAt: ["coding", "research"],
    badAt: ["vision"]
  },
  {
    // Kimi-K2.7-Code — code-specialised, weaker at prose.
    match: /^kimi[-\/]?k2[.\-]7(?:[-\/]?code)?\s*$/i,
    goodAt: ["coding"],
    badAt: ["writing", "vision"]
  },
  {
    match: /^kimi[-\/]?k2[.\-]6\s*$/i,
    goodAt: ["coding", "research"],
    badAt: ["vision"]
  },

  // ---- MiniMax ---------------------------------------------------------------
  {
    match: /^minimax[-\/]?m3[.\-]1[-\/]?flash\s*$/i,
    goodAt: ["summarize", "office", "general"],
    badAt: ["research"]
  },
  {
    // MiniMax-M3 — office / agentic.
    match: /^minimax[-\/]?m3\s*$/i,
    goodAt: ["writing", "office", "agentic", "analysis"],
    badAt: ["vision"]
  },

  // ---- Xiaomi MiMo -----------------------------------------------------------
  {
    // Flash line — small and cheap. Good enough for routine code and summaries;
    // deliberately NOT tagged `research`: it is the tier you reach for when the
    // task is already scoped, not when you need breadth.
    // Separators allow a space too: `our-free-model` ships this as `MiMo V2.6
    // Flash` with no hyphens, and an optional `-free` tail.
    match: /^mimo[\s\-]?v2[.\-]6[\s\-]?flash(?:[\s\-]?free)?\s*$/i,
    goodAt: ["coding", "summarize", "general"],
    badAt: ["research", "vision"]
  },
  {
    match: /^mimo[-\/]?v2[.\-]6[-\/]?pro\s*$/i,
    goodAt: ["coding", "agentic", "analysis"],
    badAt: ["vision"]
  },

  // ---- Alibaba Qwen ----------------------------------------------------------
  // Order matters: flash → plus → max, most specific first. The version number
  // is optional in the pattern so both `Qwen3.8-Flash` and `Qwen3-Flash` match,
  // and `[\s\-]` lets `Qwen 3.8 Flash` (space-separated display names) match too.
  {
    match: /^qwen[\s\-]?3(?:[.\-]?\d)?[\s\-]?flash\s*$/i,
    goodAt: ["coding", "summarize", "general"],
    badAt: ["research", "vision"]
  },
  {
    match: /^qwen[\s\-]?3(?:[.\-]?\d)?[\s\-]?plus\s*$/i,
    goodAt: ["coding", "general", "analysis", "long-context"],
    badAt: ["vision"]
  },
  {
    // Max is the only Qwen tier with the breadth for research-grade work.
    match: /^qwen[\s\-]?3(?:[.\-]?\d)?[\s\-]?(?:max|turbo)\s*$/i,
    goodAt: ["coding", "analysis", "research", "long-context"],
    badAt: ["vision"]
  },

  // ---- Space-Bunny -----------------------------------------------------------
  {
    match: /^space[-\/]?bunny\s*$/i,
    goodAt: ["coding", "summarize"],
    badAt: ["research", "vision"]
  }
]);

/**
 * Normalize a tag list: strings only, trimmed, deduped, order preserved.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = String(v ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Look up the preset tags for one model record.
 *
 * `id` and display name are tested SEPARATELY against each rule — concatenating
 * them would break every anchored `^...$` pattern.
 *
 * @param {{ id?:string, model?:string, name?:string }} record
 * @returns {{ goodAt:string[], badAt:string[] }|null} null when no rule matches
 */
export function matchPreset(record) {
  if (!record || typeof record !== "object") return null;
  const modelId = String(record.model ?? "").trim();
  const fullId = String(record.id ?? "").trim();
  const name = String(record.name ?? "").trim();
  // The caller may or may not have stripped the price suffix already; be
  // tolerant of both by also testing the name with `· xN.NN` removed.
  const plainName = name.split(/[·•|]/)[0].trim();

  const candidates = [modelId, plainName, fullId, name].filter(Boolean);
  if (!candidates.length) return null;

  for (const rule of PRESET_RULES) {
    if (candidates.some((c) => rule.match.test(c))) {
      return { goodAt: cleanTags(rule.goodAt), badAt: cleanTags(rule.badAt) };
    }
  }
  return null;
}

/**
 * Merge preset tags into a model record.
 *
 * Precedence, per domain:
 *  - tags the caller already supplied are kept as-is (config/user wins)
 *  - preset tags fill only the empty side
 *  - a domain present in the record's own goodAt is never added to badAt
 *
 * @param {object} record normalized model record (may already carry tags)
 * @returns {object} a new record (does not mutate the input)
 */
export function applyPreset(record) {
  if (!record || typeof record !== "object") return record;
  const preset = matchPreset(record);
  if (!preset) return record;

  const ownGood = cleanTags(record.goodAt);
  const ownBad = cleanTags(record.badAt);

  // Config wins: only fill the side that is empty. A record that declares its
  // own ability gets no preset help at all — that keeps a hand-written tag
  // entry from being silently widened by a family-wide guess.
  const goodAt = ownGood.length ? ownGood : preset.goodAt;
  const badAt = ownBad.length ? ownBad : preset.badAt;

  // Never claim both.
  const goodSet = new Set(goodAt);
  const finalBad = badAt.filter((t) => !goodSet.has(t));

  return { ...record, goodAt, badAt: finalBad };
}

/**
 * Apply presets across a whole catalog.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function applyPresets(records) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => applyPreset(r));
}
