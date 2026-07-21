#!/usr/bin/env node

import {
  GitHubIssuesClient,
  enqueueWebsiteTask,
  resetSiteBuildingTask,
} from "./lib/site-building-queue.mjs";

const USAGE = "Usage: site-building-queue.mjs enqueue --plugin NAME [--repo OWNER/REPO] | reset --issue NUMBER";

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--") || index + 1 >= rest.length) {
      throw new Error(`Invalid argument: ${name}`);
    }
    options[name.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command !== "enqueue" && command !== "reset") {
    throw new Error(USAGE);
  }
  if (command === "enqueue" && !options.plugin) {
    throw new Error("enqueue requires --plugin NAME");
  }
  const resetIssue = Number(options.issue);
  if (
    command === "reset" &&
    (!Number.isInteger(resetIssue) || resetIssue < 1)
  ) {
    throw new Error("reset requires --issue NUMBER");
  }

  const client = new GitHubIssuesClient({
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  });

  if (command === "enqueue") {
    const result = await enqueueWebsiteTask(client, options.plugin, {
      repo: options.repo,
    });
    console.log(`Created site-building issue #${result.issue.number}`);
    return;
  }
  if (command === "reset") {
    await resetSiteBuildingTask(client, resetIssue);
    console.log(`Reset site-building issue #${resetIssue}`);
    return;
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
