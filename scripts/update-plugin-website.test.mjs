import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import TOML from "toml";

import { generatePluginJson } from "./update-plugin-website.mjs";

const PLUGIN_NAME = "fixture-plugin";
const MARKETPLACE = {
  name: "fixture-marketplace",
  owner: { name: "Fixture" },
  plugins: [
    {
      name: PLUGIN_NAME,
      description: "Fixture plugin",
      source: "./fixture-plugin",
    },
  ],
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "website-publication-test-"));
  const pluginPath = join(root, "plugin");
  const catalogWebsiteDir = join(root, "catalog/website");
  const pluginsOutputDir = join(root, "generated/plugins");
  const skillsOutputDir = join(root, "generated/skills");
  for (const path of [
    pluginPath,
    catalogWebsiteDir,
    pluginsOutputDir,
    skillsOutputDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    root,
    pluginPath,
    catalogWebsiteDir,
    pluginsOutputDir,
    skillsOutputDir,
  };
}

function writeSkill(pluginPath, baseDir, name) {
  const dir = join(pluginPath, baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}\n`);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function options(fixture, onPiCall) {
  return {
    catalogWebsiteDir: fixture.catalogWebsiteDir,
    pluginsOutputDir: fixture.pluginsOutputDir,
    skillsOutputDir: fixture.skillsOutputDir,
    isLlmAvailable: () => {
      onPiCall();
      return true;
    },
    generateSkillContent: async () => {
      onPiCall();
      throw new Error("Pi must not run in this fixture");
    },
  };
}

describe("published plugin skill reconciliation", () => {
  it("removes departed skills while ignoring repository-only skills without Pi", async () => {
    const fixture = makeFixture();
    let piCalls = 0;
    try {
      writeSkill(fixture.pluginPath, "skills", "published-skill");
      writeSkill(fixture.pluginPath, ".agents/skills", "project-only-skill");
      writeFileSync(
        join(fixture.catalogWebsiteDir, `${PLUGIN_NAME}.skills.toml`),
        [
          "[skills.published-skill]",
          'display_name = "Published Skill"',
          "",
          "[skills.removed-skill]",
          'display_name = "Removed Skill"',
          "",
          "[skills.project-only-skill]",
          'display_name = "Project Only Skill"',
          "",
        ].join("\n"),
      );
      writeJson(join(fixture.skillsOutputDir, "removed-skill.json"), {
        skill: { name: "removed-skill", pluginName: PLUGIN_NAME },
      });
      writeJson(join(fixture.skillsOutputDir, "project-only-skill.json"), {
        skill: { name: "project-only-skill", pluginName: PLUGIN_NAME },
      });

      const result = await generatePluginJson(
        PLUGIN_NAME,
        fixture.pluginPath,
        MARKETPLACE,
        options(fixture, () => {
          piCalls += 1;
        }),
      );

      assert.equal(piCalls, 0);
      assert.equal(result.skillCount, 1);
      assert.deepEqual(result.removedTomlSkills, [
        "project-only-skill",
        "removed-skill",
      ]);
      assert.deepEqual(result.removedSkillJson, [
        "project-only-skill",
        "removed-skill",
      ]);
      assert.equal(
        existsSync(join(fixture.skillsOutputDir, "removed-skill.json")),
        false,
      );
      assert.equal(
        existsSync(join(fixture.skillsOutputDir, "project-only-skill.json")),
        false,
      );

      const skillsToml = TOML.parse(
        readFileSync(
          join(fixture.catalogWebsiteDir, `${PLUGIN_NAME}.skills.toml`),
          "utf8",
        ),
      );
      assert.deepEqual(Object.keys(skillsToml.skills), ["published-skill"]);

      const pluginJson = JSON.parse(
        readFileSync(
          join(fixture.pluginsOutputDir, `${PLUGIN_NAME}.json`),
          "utf8",
        ),
      );
      assert.equal(pluginJson.plugin.skillCount, 1);
      assert.deepEqual(pluginJson.plugin.skills, ["published-skill"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves a same-named generated skill owned by another plugin", async () => {
    const fixture = makeFixture();
    let piCalls = 0;
    const sharedOutput = join(fixture.skillsOutputDir, "shared-skill.json");
    try {
      writeSkill(fixture.pluginPath, ".agents/skills", "shared-skill");
      writeFileSync(
        join(fixture.catalogWebsiteDir, `${PLUGIN_NAME}.skills.toml`),
        '[skills.shared-skill]\ndisplay_name = "Shared Skill"\n',
      );
      const otherPluginJson = {
        sourceHash: "other-plugin-content",
        skill: { name: "shared-skill", pluginName: "other-plugin" },
      };
      writeJson(sharedOutput, otherPluginJson);

      const result = await generatePluginJson(
        PLUGIN_NAME,
        fixture.pluginPath,
        MARKETPLACE,
        options(fixture, () => {
          piCalls += 1;
        }),
      );

      assert.equal(piCalls, 0);
      assert.equal(result.skillCount, 0);
      assert.deepEqual(result.removedTomlSkills, ["shared-skill"]);
      assert.deepEqual(result.removedSkillJson, []);
      assert.deepEqual(
        JSON.parse(readFileSync(sharedOutput, "utf8")),
        otherPluginJson,
      );

      const skillsToml = TOML.parse(
        readFileSync(
          join(fixture.catalogWebsiteDir, `${PLUGIN_NAME}.skills.toml`),
          "utf8",
        ),
      );
      assert.deepEqual(skillsToml.skills ?? {}, {});

      const pluginJson = JSON.parse(
        readFileSync(
          join(fixture.pluginsOutputDir, `${PLUGIN_NAME}.json`),
          "utf8",
        ),
      );
      assert.equal(pluginJson.plugin.skillCount, 0);
      assert.deepEqual(pluginJson.plugin.skills, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
