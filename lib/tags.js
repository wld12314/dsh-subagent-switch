// tags.js — capability tag parsing and optional web-sync hook
//
// Each model carries:
//   goodAt  — domains it is good at
//   badAt   — domains it is bad at
//
// The plugin ships preset models with baseline tags. When the user picks
// "sync/update info" for an existing model, we fetch public info and merge
// the new tags in. The actual HTTP call is left as an explicit hook so we
// don't accidentally call a network API in a path that doesn't allow it.

const DOMAIN_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/;

// Chinese aliases → canonical English domain id.
//
// The canonical ids MUST stay English: matchScore() compares raw strings, the
// preset regexes and the task classifier all emit English ids, and config.tags
// is merged into the same lists. If we stored "编码" as-is it would never equal
// "coding", the tag would be silently ignored, and the user would conclude the
// feature is broken. So translation happens HERE, at the boundary, once —
// writing either form in config.tags works, and everything downstream keeps
// seeing one spelling.
//
// Display translation (id → Chinese) lives in the panel, not here.
export const DOMAIN_ALIASES = Object.freeze({
  "编码": "coding",
  "写代码": "coding",
  "编程": "coding",
  "代码": "coding",
  "调研": "research",
  "研究": "research",
  "检索": "research",
  "资料": "research",
  "写作": "writing",
  "文案": "writing",
  "创作": "writing",
  "摘要": "summarize",
  "总结": "summarize",
  "概括": "summarize",
  "分析": "analysis",
  "推理": "analysis",
  "视觉": "vision",
  "图像": "vision",
  "识图": "vision",
  "长文本": "long-context",
  "长上下文": "long-context",
  "长文": "long-context",
  "自主任务": "agentic",
  "工具调用": "agentic",
  "智能体": "agentic",
  "办公文档": "office",
  "办公": "office",
  "文档": "office",
  "后台任务": "background",
  "后台": "background",
  "通用": "general",
  "日常": "general"
});

/** Translate a (possibly Chinese) domain to its canonical English id. */
export function canonicalDomain(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  // Case-insensitive on the English side so "Coding" and "coding" are one tag.
  const direct = s.toLowerCase();
  if (DOMAIN_ALIASES[s]) return DOMAIN_ALIASES[s];
  if (DOMAIN_ALIASES[direct]) return DOMAIN_ALIASES[direct];
  return direct;
}

/** Validate and normalize one tag/domain string. */
export function normalizeTag(raw, { allowEmpty = false } = {}) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "" && allowEmpty) return "";
  if (s === "" || !DOMAIN_PATTERN.test(s)) return null;
  const canonical = canonicalDomain(s);
  return canonical || null;
}

/**
 * Split a comma/semicolon/newline separated tag string into a normalized list.
 * Invalid tokens are dropped (never crash).
 */
export function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => normalizeTag(v)).filter(Boolean);
  return String(raw)
    .split(/[,;;\n|]+/)
    .map((v) => normalizeTag(v))
    .filter(Boolean);
}

/**
 * Merge new tags into a model's tag lists.
 *
 * Rules:
 *  - goodAt and badAt never overlap; a domain that appears in both is
 *    removed from badAt (the good signal wins).
 *  - existing tags are preserved; new domains are appended.
 *  - only normalized domains are kept.
 *
 * @param {string[]} currentGood
 * @param {string[]} currentBad
 * @param {object} fresh  { goodAt?, badAt? }
 * @returns {{ goodAt: string[], badAt: string[] }}
 */
export function mergeTags(currentGood, currentBad, fresh) {
  const good = new Set(currentGood || []);
  const bad = new Set(currentBad || []);

  for (const g of parseTags(fresh?.goodAt)) {
    if (g) good.add(g);
  }
  for (const b of parseTags(fresh?.badAt)) {
    if (b) bad.add(b);
  }

  // resolve contradictions: good > bad
  const resultBad = [...bad].filter((b) => !good.has(b));
  return { goodAt: [...good], badAt: resultBad };
}

/**
 * Web search sync hook signature.
 *
 * This plugin itself NEVER fetches from the network. The host/integrator
 * injects a real implementation for this symbol. The default value is a
 * stub that throws a clear error when engaged, so we never silently fall
 * back to a no-op in production.
 *
 * @type {function({ model: object, query: string }): Promise<{ summary: string }>}
 */
export const fetchWebSummary = async ({ model, query }) => {
  throw new Error(
    `[subagent-switch] fetchWebSummary is not mounted. ` +
    `Implement it in the host so the tag-sync path for "${model.name}" can proceed.`
  );
};

/**
 * Build a search query from a model record so we can fetch public info.
 * Kept intentionally conservative: we only ask for the model's name, not
 * user prompts or session content.
 */
export function buildSyncQuery(model) {
  const q = [];
  if (model.name) q.push(model.name);
  if (model.provider) q.push(model.provider);
  return q.filter(Boolean).join(" ");
}
