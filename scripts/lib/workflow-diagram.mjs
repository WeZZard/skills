import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import TOML from "toml";
import { computeHash } from "./catalog.mjs";

function toId(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadWebsiteConfig(pluginDir) {
  const content = readFileSync(join(pluginDir, "website.philosophy.toml"), "utf8");
  return TOML.parse(content);
}

function discoverSkills(pluginDir) {
  const skillsDir = join(pluginDir, "skills");
  if (!existsSync(skillsDir)) {
    return [];
  }

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      content: readFileSync(join(skillsDir, entry.name, "SKILL.md"), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function computeCombinedHash(hooksContent, websiteContent, skillContents) {
  const combined = [hooksContent, websiteContent, ...skillContents].join("\n---BOUNDARY---\n");
  return computeHash(combined);
}

function buildHighlight(section) {
  const highlight = {
    type: section.comparison_before ? "insight" : "feature",
    title: section.highlight_title || section.title,
    content: section.highlight_content || "",
  };

  if (section.highlight_image) {
    highlight.image = section.highlight_image;
  }
  if (section.highlight_sound) {
    highlight.sound = section.highlight_sound;
  }

  if (
    section.comparison_before_label &&
    section.comparison_before &&
    section.comparison_after_label &&
    section.comparison_after
  ) {
    highlight.comparison = {
      before_label: section.comparison_before_label,
      before: section.comparison_before,
      ...(section.comparison_before_image
        ? { before_image: section.comparison_before_image }
        : {}),
      after_label: section.comparison_after_label,
      after: section.comparison_after,
      ...(section.comparison_after_image
        ? { after_image: section.comparison_after_image }
        : {}),
    };
  }

  return highlight;
}

export function generateWorkflowDiagram(pluginName, pluginDir) {
  const hooksJsonPath = join(pluginDir, "hooks/hooks.json");
  const websiteTomlPath = join(pluginDir, "website.philosophy.toml");

  if (!existsSync(websiteTomlPath)) {
    return { skip: true, reason: "no website.philosophy.toml" };
  }

  const hooksRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, "utf8") : "{}";
  const websiteRaw = readFileSync(websiteTomlPath, "utf8");
  const websiteConfig = loadWebsiteConfig(pluginDir);
  const skills = discoverSkills(pluginDir);

  const tomlEvents = websiteConfig.philosophy?.events || [];
  if (tomlEvents.length === 0) {
    throw new Error(
      `No events defined in website.philosophy.toml for ${pluginName}`,
    );
  }

  const skillContents = skills.map((s) => s.content);
  const sourceHash = computeCombinedHash(hooksRaw, websiteRaw, skillContents);

  const diagramEvents = tomlEvents.map((event) => ({
    id: event.id,
    edge: event.edge,
    position: event.position,
    label: event.label,
  }));

  const philosophies = (websiteConfig.philosophy?.sections || []).map((section) => ({
    id: toId(section.title),
    title: section.title,
    additions: section.additions || [],
    highlight: buildHighlight(section),
    relatedSkills: section.related_skills || [],
  }));

  const skillOrder = websiteConfig.skills?.order;

  return {
    skip: false,
    output: {
      sourceHash,
      generatedAt: new Date().toISOString(),
      ...(skillOrder?.length ? { skillOrder } : {}),
      diagram: {
        events: diagramEvents,
        rect: { width: 600, height: 400, rx: 24 },
      },
      philosophies,
    },
  };
}
