import { spawnSync } from "node:child_process";

import {
  SITE_BUILDING_LABELS,
  encodeSiteBuildingTask,
  groupSiteBuildingIssues,
  labelsForStatus,
  labelsWithoutSiteBuildingStatus,
  parseSiteBuildingTask,
} from "./site-building-queue.mjs";
import {
  SiteBuildingWindowError,
  assertSiteBuildingWindow,
  getSiteBuildingWindow,
} from "./site-building-window.mjs";

function issueHasLabel(issue, label) {
  return (issue.labels ?? []).some((entry) =>
    (typeof entry === "string" ? entry : entry.name) === label,
  );
}

function run(command, args, { cwd = process.cwd(), allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    const error = new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
    error.exitCode = result.status;
    throw error;
  }
  return result;
}

function currentPullRequest(branch, cwd) {
  const result = run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""],
    { cwd },
  );
  return result.stdout.trim();
}

function remoteBranchSha(branch, cwd) {
  const result = run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd },
  );
  return result.stdout.trim().split(/\s+/)[0] || null;
}

export async function processWebsiteContentTask({ issue, task }, {
  cwd = process.cwd(),
  now = () => new Date(),
} = {}) {
  assertSiteBuildingWindow(now());
  const plugin = task.payload.plugin;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(plugin)) {
    throw new Error(`Unsafe plugin name in site-building task: ${plugin}`);
  }
  const branch = `agent/website-content/${plugin}`;
  const paths = [
    "catalog/website",
    "website/src/content/generated/plugins",
    "website/src/content/generated/skills",
  ];

  try {
    run("git", ["fetch", "origin", "main"], { cwd });
    const remoteSha = remoteBranchSha(branch, cwd);
    if (remoteSha) {
      run(
        "git",
        ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { cwd },
      );
    }
    run("git", ["checkout", "-B", branch, "origin/main"], { cwd });
    run("node", ["scripts/update-plugin-website.mjs", "--plugin", plugin], { cwd });

    const status = run("git", ["status", "--porcelain", "--", ...paths], { cwd });
    if (!status.stdout.trim()) {
      const existingPr = currentPullRequest(branch, cwd);
      if (existingPr) {
        run(
          "gh",
          ["pr", "close", existingPr, "--comment", "Current catalog content produces no website changes."],
          { cwd },
        );
      }
      if (remoteSha) {
        const deletion = run(
          "git",
          [
            "push",
            `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
            "origin",
            `:refs/heads/${branch}`,
          ],
          { cwd, allowFailure: true },
        );
        if (deletion.status !== 0 && remoteBranchSha(branch, cwd)) {
          throw new Error(
            `Failed to delete obsolete remote branch ${branch}: ${deletion.stderr || deletion.stdout}`,
          );
        }
      }
      return { outcome: "no-change", pullRequestUrl: null };
    }

    run("git", ["add", "--all", "--", ...paths], { cwd });

    if (remoteSha) {
      const sameAsOpenBranch = run(
        "git",
        ["diff", "--cached", "--quiet", `refs/remotes/origin/${branch}`, "--", ...paths],
        { cwd, allowFailure: true },
      );
      const existingPr = currentPullRequest(branch, cwd);
      if (sameAsOpenBranch.status === 0 && existingPr) {
        return {
          outcome: "unchanged-pull-request",
          pullRequestUrl: existingPr,
        };
      }
    }

    run("git", ["config", "user.name", "github-actions[bot]"], { cwd });
    run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd });
    run("git", ["commit", "-m", `chore(website): update ${plugin} content`], { cwd });
    const lease = remoteSha
      ? `--force-with-lease=refs/heads/${branch}:${remoteSha}`
      : "--force-with-lease";
    run("git", ["push", lease, "origin", `HEAD:refs/heads/${branch}`], { cwd });

    let pullRequestUrl = currentPullRequest(branch, cwd);
    if (!pullRequestUrl) {
      const created = run(
        "gh",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          branch,
          "--title",
          `chore(website): update ${plugin} content`,
          "--body",
          [
            `Updates generated website content for \`${plugin}\`.`,
            "",
            `Requested by site-building issue #${issue.number}.`,
            "",
            "The plugin release and catalog pin are already complete. This pull request only updates website content.",
          ].join("\n"),
        ],
        { cwd },
      );
      pullRequestUrl = created.stdout.trim();
    }
    return { outcome: "pull-request", pullRequestUrl };
  } catch (error) {
    if (error?.exitCode === 75) {
      throw new SiteBuildingWindowError(
        "DeepSeek peak pricing started before the next Pi invocation",
      );
    }
    throw error;
  } finally {
    // Each task shares one ephemeral runner checkout. Restore only the paths
    // this worker owns so a failure or unchanged PR cannot contaminate the
    // next queued plugin.
    run(
      "git",
      ["restore", "--source=origin/main", "--staged", "--worktree", "--", ...paths],
      { cwd, allowFailure: true },
    );
    run("git", ["clean", "-fd", "--", ...paths], { cwd, allowFailure: true });
    run("git", ["checkout", "--detach", "--force", "origin/main"], {
      cwd,
      allowFailure: true,
    });
  }
}

async function closeDuplicateIssues(client, groups) {
  for (const group of groups.values()) {
    const [{ issue: primary }, ...duplicates] = group;
    for (const { issue } of duplicates) {
      await client.addComment(
        issue.number,
        `Superseded by #${primary.number} for the same site-building key.`,
      );
      await client.updateIssue(issue.number, {
        labels: labelsWithoutSiteBuildingStatus(issue),
        state: "closed",
      });
    }
  }
}

async function recoverInterruptedTasks(client, issues, log) {
  const recoveredIssues = [];
  for (const issue of issues) {
    if (
      issue.pull_request ||
      !issueHasLabel(issue, SITE_BUILDING_LABELS.running)
    ) {
      recoveredIssues.push(issue);
      continue;
    }
    try {
      parseSiteBuildingTask(issue.body);
    } catch {
      recoveredIssues.push(issue);
      continue;
    }
    const recovered = await client.updateIssue(issue.number, {
      labels: labelsForStatus(issue, "queued"),
    });
    await client.addComment(
      issue.number,
      "Recovered after an interrupted site-building worker run. Returning the task to the queue without increasing its attempt count.",
    );
    log.log(`Recovered interrupted site-building task #${issue.number}`);
    recoveredIssues.push(recovered);
  }
  return recoveredIssues;
}

async function claimTask(client, issue) {
  const current = await client.getIssue(issue.number);
  if (current.state !== "open" || issueHasLabel(current, SITE_BUILDING_LABELS.blocked)) {
    return null;
  }
  if (
    !issueHasLabel(current, SITE_BUILDING_LABELS.queued) &&
    !issueHasLabel(current, SITE_BUILDING_LABELS.failed)
  ) {
    return null;
  }
  const task = parseSiteBuildingTask(current.body);
  const claimed = await client.updateIssue(current.number, {
    labels: labelsForStatus(current, "running"),
  });
  return { issue: claimed, task };
}

async function completeTask(client, claimed, result) {
  const current = await client.getIssue(claimed.issue.number);
  const currentTask = parseSiteBuildingTask(current.body);
  if (currentTask.generation !== claimed.task.generation) {
    await client.addComment(
      current.number,
      `Generation ${claimed.task.generation} finished, but generation ${currentTask.generation} is now requested. Returning the task to the queue.`,
    );
    await client.updateIssue(current.number, {
      labels: labelsForStatus(current, "queued"),
    });
    return "superseded";
  }
  const detail = result.pullRequestUrl
    ? `Website content is ready for review: ${result.pullRequestUrl}`
    : "The current catalog state produces no website changes.";
  await client.addComment(current.number, detail);
  await client.updateIssue(current.number, {
    labels: labelsWithoutSiteBuildingStatus(current),
    state: "closed",
  });
  return result.outcome;
}

async function deferTask(client, claimed, message) {
  const current = await client.getIssue(claimed.issue.number);
  await client.addComment(current.number, message);
  await client.updateIssue(current.number, {
    labels: labelsForStatus(current, "queued"),
  });
}

async function failTask(client, claimed, error, runUrl) {
  const current = await client.getIssue(claimed.issue.number);
  const currentTask = parseSiteBuildingTask(current.body);
  if (currentTask.generation !== claimed.task.generation) {
    await client.updateIssue(current.number, {
      labels: labelsForStatus(current, "queued"),
    });
    return "superseded";
  }
  const attempts = currentTask.attempts + 1;
  const blocked = attempts >= 3;
  const updatedTask = { ...currentTask, attempts };
  let errorMessage = String(error?.message ?? error);
  for (const secret of [
    process.env.DEEPSEEK_API_KEY,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
  ].filter(Boolean)) {
    errorMessage = errorMessage.split(secret).join("[redacted]");
  }
  errorMessage = errorMessage.slice(0, 4000);
  await client.addComment(
    current.number,
    [
      `Site-building attempt ${attempts} failed: ${errorMessage}`,
      runUrl ? `Workflow run: ${runUrl}` : null,
      blocked ? "Automatic retries are blocked after three failures." : "The next allowed worker run will retry this task.",
    ].filter(Boolean).join("\n\n"),
  );
  await client.updateIssue(current.number, {
    body: encodeSiteBuildingTask(updatedTask),
    labels: labelsForStatus(current, blocked ? "blocked" : "failed"),
  });
  return blocked ? "blocked" : "failed";
}

export async function runSiteBuildingWorker({
  client,
  processor = processWebsiteContentTask,
  now = () => new Date(),
  runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  log = console,
} = {}) {
  await client.ensureLabels();
  const issues = await recoverInterruptedTasks(
    client,
    await client.listOpenIssues(),
    log,
  );

  const initialWindow = getSiteBuildingWindow(now());
  if (!initialWindow.allowed) {
    log.log(`Site-building worker did not claim work: ${initialWindow.reason}`);
    return { processed: 0, deferred: true };
  }

  const groups = groupSiteBuildingIssues(issues);
  await closeDuplicateIssues(client, groups);
  const candidates = [...groups.values()]
    .map(([primary]) => primary.issue)
    .filter((issue) =>
      issueHasLabel(issue, SITE_BUILDING_LABELS.queued) ||
      issueHasLabel(issue, SITE_BUILDING_LABELS.failed),
    )
    .sort((left, right) =>
      Date.parse(left.created_at ?? 0) - Date.parse(right.created_at ?? 0) ||
      left.number - right.number,
    );

  let processed = 0;
  for (const issue of candidates) {
    const window = getSiteBuildingWindow(now());
    if (!window.allowed) {
      log.log(`Stopped before claiming #${issue.number}: ${window.reason}`);
      return { processed, deferred: true };
    }
    const claimed = await claimTask(client, issue);
    if (!claimed) continue;
    try {
      const result = await processor(claimed, { now });
      await completeTask(client, claimed, result);
    } catch (error) {
      if (error instanceof SiteBuildingWindowError || error?.name === "SiteBuildingWindowError") {
        await deferTask(client, claimed, error.message);
        return { processed, deferred: true };
      }
      await failTask(client, claimed, error, runUrl);
    }
    processed += 1;
  }
  return { processed, deferred: false };
}
