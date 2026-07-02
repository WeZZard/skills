#!/usr/bin/env node

/**
 * CLI wrapper: generate skill website JSON via OpenCode.
 *
 * Usage:
 *   node scripts/opencode-generate-skill.mjs --skill my-skill --skill-md-file path/to/SKILL.md
 */

import { readFileSync } from "fs";
import { parseArgs } from "util";
import { generateSkillContentWithLlm } from "./lib/website-llm.mjs";

const { values: args } = parseArgs({
  options: {
    skill: { type: "string" },
    "skill-md-file": { type: "string" },
  },
});

async function main() {
  const skill = args.skill;
  const skillMdFile = args["skill-md-file"];
  if (!skill || !skillMdFile) {
    throw new Error("Usage: --skill NAME --skill-md-file PATH");
  }
  const skillMd = readFileSync(skillMdFile, "utf8");
  const result = await generateSkillContentWithLlm(skill, skillMd);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
