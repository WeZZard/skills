#!/usr/bin/env node

import { writeFileSync } from "fs";
import { join } from "path";
import {
  REPO_ROOT,
  loadMarketplace,
  parseArgs,
} from "./lib/catalog.mjs";

const args = parseArgs(process.argv.slice(2));
const README_PATH = join(REPO_ROOT, "README.md");

const PLUGIN_SECTIONS = {
  amplify: {
    title: "Amplify",
    intro: "Development workflow skills for planning and execution.",
    tableHeader: "| Skill | Description |",
    rows: [
      ["brainstorming", "Explore ideas, approaches, and requirements before implementation"],
      ["write-plan", "Create and update plan files with structured templates"],
      ["execute-plan", "Execute a plan file step by step"],
      ["same-page", "Explain a previous message with adaptive layout, evidence, and confidence"],
      ["be-thorough", "Investigate deeply before concluding when debugging or reviewing uncertain claims"],
      ["divide-and-conquer", "Break large jobs into parallel subagent-driven DAG workflows"],
    ],
  },
  "zelda-sounds": {
    title: "Zelda-sounds",
    intro:
      "Zelda BotW and TotK sound cues for Claude Code lifecycle events, with a GUI configurator. Run `/zelda-sounds:configure-zelda-sounds` to assign sounds to hook events.",
    table: false,
  },
  "skill-kit": {
    title: "Skill-kit",
    intro:
      "Tools for auditing and improving Claude Code skill definitions. Run `/skill-kit:skill-lint --agent <agent> <path>` to lint skill files for structural and schema issues.",
    table: false,
  },
};

function installLines(marketplace) {
  return marketplace.plugins
    .map((plugin) => {
      const label = plugin.name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("-");
      return `/plugin install ${plugin.name}@${marketplace.name} # ${label}`;
    })
    .join("\n");
}

function renderPluginSection(name, config) {
  let section = `### ${config.title}\n\n${config.intro}\n`;
  if (config.tableHeader && config.rows) {
    section += `\n${config.tableHeader}\n| ----- | ----------- |\n`;
    section += config.rows.map(([skill, desc]) => `| \`${skill}\` | ${desc} |`).join("\n");
    section += "\n";
  }
  return `${section}\n`;
}

function buildReadme(marketplace) {
  const sections = marketplace.plugins
    .map((plugin) => {
      if (!PLUGIN_SECTIONS[plugin.name]) {
        return `### ${plugin.name}\n\n${plugin.description}\n`;
      }
      return renderPluginSection(plugin.name, PLUGIN_SECTIONS[plugin.name]);
    })
    .join("\n");

  return `# WeZZard Skills

## Plugins

This repository ships Claude Code marketplace plugins and an OpenCode plugin distribution. The plugins share a common focus on structured planning, reliable execution, and thoughtful polish in agent-assisted development.

## Installation

### Claude Code

Install the marketplace

\`\`\`bash
/plugin marketplace add WeZZard/skills
\`\`\`

Install the plugins

\`\`\`bash
${installLines(marketplace)}
\`\`\`

### OpenCode

See [opencode/zelda-sounds/README.md](opencode/zelda-sounds/README.md) for the \`file://\` plugin entry and skill install steps.

## Claude Code Plugins

${sections}
## OpenCode Plugins

### Zelda-sounds

Generated from \`plugins/zelda-sounds/\`. Plays Zelda BotW and TotK sound cues on OpenCode lifecycle events, with the same GUI configurator as the Claude Code plugin. See [opencode/zelda-sounds/README.md](opencode/zelda-sounds/README.md) for install and configuration.

## License

MIT — see [LICENSE](LICENSE).
`;
}

function main() {
  const marketplace = loadMarketplace();
  const readme = buildReadme(marketplace);

  if (args.dryRun) {
    console.log(readme);
    return;
  }

  writeFileSync(README_PATH, readme);
  console.log("Regenerated README.md");
}

main();
