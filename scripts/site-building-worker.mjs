#!/usr/bin/env node

import { GitHubIssuesClient } from "./lib/site-building-queue.mjs";
import { runSiteBuildingWorker } from "./lib/site-building-worker.mjs";

const client = new GitHubIssuesClient({
  token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  repository: process.env.GITHUB_REPOSITORY,
});

runSiteBuildingWorker({ client }).catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
