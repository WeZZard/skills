// Canonical forms and provenance fingerprints for website content.
//
// Every machine-generated TOML entry carries two hashes:
//   source_hash  — fingerprint of the source it was derived from (a skill's
//                  SKILL.md; the marketplace identity for the plugin level).
//                  Drift here means the plugin visibly changed.
//   content_hash — fingerprint of the entry's own generated content. Drift
//                  here means a human edited the entry: it is preserved
//                  forever and never regenerated (implicit edit detection).
// Entries without hashes (hand-authored) count as hand-edited. Deleting an
// entry — or stamping it with scripts/adopt-plugin-content.mjs — opts it
// into machine ownership.

import { computeHash } from "./catalog.mjs";

// Coerce to string and strip \r: the TOML emitter drops \r and a round
// trip through the parser must reproduce the exact strings the fingerprint
// was computed over, or entries get misclassified as hand-edited forever.
export const clean = (value) => String(value ?? "").replace(/\r/g, "");

export function canonicalSkillContent(entry) {
  return {
    display_name: clean(entry.display_name),
    tagline: clean(entry.tagline),
    short_summary: clean(entry.short_summary),
    full_summary: clean(entry.full_summary),
    highlights: (entry.highlights ?? []).map((h) => ({
      title: clean(h.title),
      description: clean(h.description),
    })),
    workflow: (entry.workflow ?? []).map((w) => ({
      name: clean(w.name),
      description: clean(w.description),
      details: clean(w.details),
    })),
  };
}

export const fingerprintSkillEntry = (entry) =>
  computeHash(JSON.stringify(canonicalSkillContent(entry)));

export function canonicalPluginContent(pluginToml) {
  return {
    display_name: clean(pluginToml.display_name),
    tagline: clean(pluginToml.tagline),
    repo: clean(pluginToml.repo),
  };
}

export const fingerprintPluginToml = (pluginToml) =>
  computeHash(JSON.stringify(canonicalPluginContent(pluginToml)));
