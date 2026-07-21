#!/usr/bin/env node

/** Generate one skill's website JSON through the repository's bounded Pi runner. */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

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
  const result = await generateSkillContentWithLlm(
    skill,
    readFileSync(skillMdFile, "utf8"),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
