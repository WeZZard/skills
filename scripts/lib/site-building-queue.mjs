export const SITE_BUILDING_LABELS = Object.freeze({
  queued: "site-building:queued",
  running: "site-building:running",
  failed: "site-building:failed",
  blocked: "site-building:blocked",
});

export const SITE_BUILDING_LABEL_DEFINITIONS = Object.freeze({
  [SITE_BUILDING_LABELS.queued]: {
    color: "1d76db",
    description: "Website content is waiting for the site-building worker",
  },
  [SITE_BUILDING_LABELS.running]: {
    color: "fbca04",
    description: "The site-building worker is processing this task",
  },
  [SITE_BUILDING_LABELS.failed]: {
    color: "d93f0b",
    description: "The site-building task failed and will retry",
  },
  [SITE_BUILDING_LABELS.blocked]: {
    color: "b60205",
    description: "The site-building task failed three times and needs recovery",
  },
});

const MARKER_START = "<!-- site-building-task";
const MARKER_END = "-->";
const STATUS_LABELS = new Set(Object.values(SITE_BUILDING_LABELS));

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Site-building task ${field} must be a non-empty string`);
  }
  return value;
}

export function validateSiteBuildingTask(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Site-building task must be a JSON object");
  }
  if (value.schema !== 1) throw new Error("Site-building task schema must be 1");
  if (value.kind !== "website-content") {
    throw new Error("Site-building task kind must be website-content");
  }
  const key = nonEmptyString(value.key, "key");
  if (!Number.isInteger(value.generation) || value.generation < 1) {
    throw new Error("Site-building task generation must be a positive integer");
  }
  const requestedAt = nonEmptyString(value.requestedAt, "requestedAt");
  if (Number.isNaN(Date.parse(requestedAt))) {
    throw new Error("Site-building task requestedAt must be an ISO date");
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 0) {
    throw new Error("Site-building task attempts must be a non-negative integer");
  }
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    throw new Error("Site-building task payload must be an object");
  }
  const plugin = nonEmptyString(value.payload.plugin, "payload.plugin");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(plugin)) {
    throw new Error("Site-building task payload.plugin contains unsafe characters");
  }
  if (key !== `website:${plugin}`) {
    throw new Error("Site-building task key must match payload.plugin");
  }
  return {
    schema: 1,
    kind: "website-content",
    key,
    generation: value.generation,
    requestedAt: new Date(requestedAt).toISOString(),
    payload: {
      plugin,
      ...(value.payload.repo ? { repo: nonEmptyString(value.payload.repo, "payload.repo") } : {}),
    },
    attempts: value.attempts,
  };
}

export function encodeSiteBuildingTask(task) {
  const validated = validateSiteBuildingTask(task);
  return `${MARKER_START}\n${JSON.stringify(validated, null, 2)}\n${MARKER_END}`;
}

export function parseSiteBuildingTask(body) {
  const match = String(body ?? "").match(
    /<!-- site-building-task\s*\n([\s\S]*?)\n-->/,
  );
  if (!match) throw new Error("Issue does not contain a site-building task marker");
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Site-building task contains invalid JSON: ${error.message}`);
  }
  return validateSiteBuildingTask(parsed);
}

export function createWebsiteTask(plugin, {
  generation = 1,
  requestedAt = new Date().toISOString(),
  attempts = 0,
  repo,
} = {}) {
  return validateSiteBuildingTask({
    schema: 1,
    kind: "website-content",
    key: `website:${plugin}`,
    generation,
    requestedAt,
    payload: { plugin, ...(repo ? { repo } : {}) },
    attempts,
  });
}

function labelNames(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

export function labelsWithoutSiteBuildingStatus(issue) {
  return labelNames(issue).filter((label) => label && !STATUS_LABELS.has(label));
}

export function labelsForStatus(issue, status) {
  return [
    ...labelsWithoutSiteBuildingStatus(issue),
    SITE_BUILDING_LABELS[status],
  ];
}

function compareIssueTasks(left, right) {
  if (left.issue.number !== right.issue.number) {
    return right.issue.number - left.issue.number;
  }
  if (left.task.generation !== right.task.generation) {
    return right.task.generation - left.task.generation;
  }
  return Date.parse(right.task.requestedAt) - Date.parse(left.task.requestedAt);
}

export function groupSiteBuildingIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    if (!labelNames(issue).some((label) => STATUS_LABELS.has(label))) continue;
    let task;
    try {
      task = parseSiteBuildingTask(issue.body);
    } catch {
      continue;
    }
    const group = groups.get(task.key) ?? [];
    group.push({ issue, task });
    groups.set(task.key, group);
  }
  for (const group of groups.values()) group.sort(compareIssueTasks);
  return groups;
}

export class GitHubIssuesClient {
  constructor({ token, repository, fetchImpl = globalThis.fetch }) {
    if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
    const [owner, repo] = String(repository ?? "").split("/");
    if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo");
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`GitHub API ${method} ${path} failed (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async listOpenIssues() {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${this.owner}/${this.repo}/issues?state=open&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) return issues;
    }
  }

  getIssue(number) {
    return this.request("GET", `/repos/${this.owner}/${this.repo}/issues/${number}`);
  }

  createIssue(body) {
    return this.request("POST", `/repos/${this.owner}/${this.repo}/issues`, body);
  }

  updateIssue(number, body) {
    return this.request("PATCH", `/repos/${this.owner}/${this.repo}/issues/${number}`, body);
  }

  addComment(number, body) {
    return this.request(
      "POST",
      `/repos/${this.owner}/${this.repo}/issues/${number}/comments`,
      { body },
    );
  }

  async ensureLabels() {
    for (const [name, definition] of Object.entries(SITE_BUILDING_LABEL_DEFINITIONS)) {
      try {
        await this.request(
          "GET",
          `/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(name)}`,
        );
      } catch (error) {
        if (error.status !== 404) throw error;
        try {
          await this.request("POST", `/repos/${this.owner}/${this.repo}/labels`, {
            name,
            ...definition,
          });
        } catch (createError) {
          if (createError.status !== 422) throw createError;
          await this.request(
            "GET",
            `/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(name)}`,
          );
        }
      }
    }
  }
}

export async function enqueueWebsiteTask(client, plugin, options = {}) {
  await client.ensureLabels();
  // Create-only enqueue avoids a read/patch race with the worker. A later
  // worker run deduplicates immutable issues for the same task key.
  const task = createWebsiteTask(plugin, {
    requestedAt: options.requestedAt,
    repo: options.repo,
  });
  const issue = await client.createIssue({
    title: `[site-building] ${plugin}`,
    body: encodeSiteBuildingTask(task),
    labels: [SITE_BUILDING_LABELS.queued],
  });
  return { issue, task, created: true };
}

export async function resetSiteBuildingTask(client, issueNumber) {
  await client.ensureLabels();
  const issue = await client.getIssue(issueNumber);
  if (
    issue.state !== "open" ||
    !labelNames(issue).includes(SITE_BUILDING_LABELS.blocked)
  ) {
    throw new Error(`Site-building issue #${issueNumber} is not open and blocked`);
  }
  const task = parseSiteBuildingTask(issue.body);
  const reset = { ...task, attempts: 0 };
  return client.updateIssue(issue.number, {
    body: encodeSiteBuildingTask(reset),
    labels: labelsForStatus(issue, "queued"),
  });
}
