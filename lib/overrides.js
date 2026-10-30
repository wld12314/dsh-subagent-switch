// overrides.js — the panel's write-back store.
//
// Everything the panel lets a user change lives in ONE json file, deliberately
// separate from the DSH profile config:
//
//   ~/.dsh/subagent-switch-overrides.json
//   { "priority": { "workbuddy/hy3": 5 }, "routable": { "our-free-model/x": true } }
//
// Reasons it is not the profile config:
//   · Writing DSH's own settings from a plugin is a much bigger blast radius
//     (a bad write can take the host down on next boot).
//   · Deleting this one file restores "automatic" behaviour completely, with no
//     need to remember which keys a panel click added.
//
// Every read is defensive: a missing, empty, or corrupt file yields the empty
// store. A panel that cannot read its own overrides must still render the
// catalog, so nothing here throws.
//
// Keys are canonical model ids (`provider/model`). Display names collide once
// the price suffix is stripped (Hy3 · x0.00 vs Hy3 · x0.05), so names are never
// used as keys here.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Priority is an integer ordering hint. Larger wins. 0 means "no opinion".
// The bounds exist only to keep a typo (`1e9`) from being un-undoable in a UI
// that shows one star per unit.
export const PRIORITY_MIN = -100;
export const PRIORITY_MAX = 100;

/**
 * Default location of the overrides file.
 *
 * @returns {string}
 */
export function defaultOverridesPath() {
  return join(homedir(), ".dsh", "subagent-switch-overrides.json");
}

/**
 * Resolve the overrides path, honouring an explicit config override.
 *
 * @param {string} [customPath]
 * @returns {string}
 */
export function overridesPath(customPath) {
  const custom = String(customPath || "").trim();
  return custom || defaultOverridesPath();
}

/**
 * An empty store. Always return a fresh object: callers mutate the returned
 * value, and a shared frozen literal would leak between calls.
 *
 * @returns {{ priority: Record<string, number>, routable: Record<string, boolean> }}
 */
export function emptyOverrides() {
  return { priority: {}, routable: {} };
}

/**
 * Read the overrides file.
 *
 * Never throws. A corrupt file is treated as empty rather than fatal: losing a
 * manual tweak is annoying, but a plugin that refuses to load is worse.
 *
 * @param {string} [file]
 * @returns {{ priority: Record<string, number>, routable: Record<string, boolean> }}
 */
export function readOverrides(file) {
  const target = overridesPath(file);
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    // ENOENT is the normal first-run case, not an error.
    return emptyOverrides();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOverrides();
  }
  return sanitizeOverrides(parsed);
}

/**
 * Coerce arbitrary json into the store shape: drop unknown keys, drop
 * non-numeric priorities, clamp them, and keep only `true` routable flags.
 *
 * @param {unknown} input
 * @returns {{ priority: Record<string, number>, routable: Record<string, boolean> }}
 */
export function sanitizeOverrides(input) {
  const out = emptyOverrides();
  if (!input || typeof input !== "object") return out;

  const priority = input.priority;
  if (priority && typeof priority === "object" && !Array.isArray(priority)) {
    for (const [id, value] of Object.entries(priority)) {
      const key = String(id || "").trim();
      const n = Number(value);
      if (!key || !Number.isFinite(n)) continue;
      const clamped = clampPriority(n);
      // A zero priority carries no information; storing it would make the
      // panel show an "override" the router ignores.
      if (clamped !== 0) out.priority[key] = clamped;
    }
  }

  const routable = input.routable;
  if (routable && typeof routable === "object" && !Array.isArray(routable)) {
    for (const [id, value] of Object.entries(routable)) {
      const key = String(id || "").trim();
      if (key && value === true) out.routable[key] = true;
    }
  }

  return out;
}

/**
 * @param {number} n
 * @returns {number}
 */
export function clampPriority(n) {
  const v = Math.round(Number(n) || 0);
  if (v < PRIORITY_MIN) return PRIORITY_MIN;
  if (v > PRIORITY_MAX) return PRIORITY_MAX;
  return v;
}

/**
 * Write the store atomically (tmp file + rename) so a crash mid-write cannot
 * leave a half-written file that reads as corrupt on next boot.
 *
 * @param {object} data
 * @param {string} [file]
 * @returns {{ ok: boolean, file: string, error?: string }}
 */
export function writeOverrides(data, file) {
  const target = overridesPath(file);
  const clean = sanitizeOverrides(data);
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
    return { ok: true, file: target };
  } catch (err) {
    return { ok: false, file: target, error: String(err?.message || err) };
  }
}

/**
 * Pure: return a new store with `id` set to `value`.
 *
 * @param {object} data
 * @param {string} id
 * @param {number} value
 * @returns {object}
 */
export function withPriority(data, id, value) {
  const next = sanitizeOverrides(data);
  const key = String(id || "").trim();
  if (!key) return next;
  const clamped = clampPriority(value);
  if (clamped === 0) delete next.priority[key];
  else next.priority[key] = clamped;
  return next;
}

/**
 * Pure: return a new store with `id`'s routable flag set or removed.
 *
 * `false` deletes the entry rather than storing `false`, so the file only ever
 * records positive claims. "Denied" is the default state, not an override.
 *
 * @param {object} data
 * @param {string} id
 * @param {boolean} routable
 * @returns {object}
 */
export function withRoutable(data, id, routable) {
  const next = sanitizeOverrides(data);
  const key = String(id || "").trim();
  if (!key) return next;
  if (routable === true) next.routable[key] = true;
  else delete next.routable[key];
  return next;
}

/**
 * Priority for one model id.
 *
 * @param {object} data
 * @param {string} id
 * @returns {number}
 */
export function priorityOf(data, id) {
  const key = String(id || "").trim();
  if (!key || !data || !data.priority) return 0;
  const n = Number(data.priority[key]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Is this id explicitly allowed through the eligibility gate?
 *
 * @param {object} data
 * @param {string} id
 * @returns {boolean}
 */
export function isRoutableOverride(data, id) {
  const key = String(id || "").trim();
  if (!key || !data || !data.routable) return false;
  return data.routable[key] === true;
}

/**
 * Every id carrying a non-zero priority, highest first. Used by the panel to
 * surface "these are the models you pinned" without scanning the catalog.
 *
 * @param {object} data
 * @returns {{ id: string, priority: number }[]}
 */
export function pinnedList(data) {
  const priority = (data && data.priority) || {};
  return Object.entries(priority)
    .map(([id, value]) => ({ id, priority: Number(value) || 0 }))
    .filter((e) => e.priority !== 0)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}
