import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  GitHubIssuesClient,
  SITE_BUILDING_LABELS,
  createWebsiteTask,
  encodeSiteBuildingTask,
  enqueueWebsiteTask,
  groupSiteBuildingIssues,
  parseSiteBuildingTask,
  resetSiteBuildingTask,
} from "./site-building-queue.mjs";
import { runSiteBuildingWorker } from "./site-building-worker.mjs";
import { SiteBuildingWindowError } from "./site-building-window.mjs";

class MemoryIssuesClient {
  constructor() {
    this.issues = [];
    this.comments = [];
    this.labelsEnsured = 0;
  }

  async ensureLabels() {
    this.labelsEnsured += 1;
  }

  async listOpenIssues() {
    return this.issues
      .filter((issue) => issue.state === "open")
      .map((issue) => structuredClone(issue));
  }

  async getIssue(number) {
    return structuredClone(this.issues.find((issue) => issue.number === number));
  }

  async createIssue(input) {
    const issue = {
      number: this.issues.length + 1,
      state: "open",
      created_at: `2026-07-22T00:00:0${this.issues.length}Z`,
      ...structuredClone(input),
    };
    this.issues.push(issue);
    return structuredClone(issue);
  }

  async updateIssue(number, input) {
    const issue = this.issues.find((entry) => entry.number === number);
    Object.assign(issue, structuredClone(input));
    return structuredClone(issue);
  }

  async addComment(number, body) {
    this.comments.push({ number, body });
    return { id: this.comments.length, body };
  }
}

const allowedNow = () => new Date("2026-07-22T12:30:00+08:00");

function apiResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

describe("site-building issue format", () => {
  it("uses the approved status label names", () => {
    assert.deepEqual(Object.values(SITE_BUILDING_LABELS), [
      "site-building:queued",
      "site-building:running",
      "site-building:failed",
      "site-building:blocked",
    ]);
  });

  it("round-trips validated hidden JSON", () => {
    const task = createWebsiteTask("amplify", {
      requestedAt: "2026-07-22T00:00:00.000Z",
    });
    const body = encodeSiteBuildingTask(task);
    assert.match(body, /^<!-- site-building-task/);
    assert.deepEqual(parseSiteBuildingTask(body), task);
  });

  it("rejects a key that does not match the plugin", () => {
    const body = encodeSiteBuildingTask(createWebsiteTask("amplify"))
      .replace("website:amplify", "website:other");
    assert.throws(() => parseSiteBuildingTask(body), /key must match/);
  });
});

describe("site-building enqueue and deduplication", () => {
  let client;

  beforeEach(() => {
    client = new MemoryIssuesClient();
  });

  it("creates an immutable queued issue for every request", async () => {
    const first = await enqueueWebsiteTask(client, "amplify", {
      requestedAt: "2026-07-22T00:00:00.000Z",
    });
    const second = await enqueueWebsiteTask(client, "amplify", {
      requestedAt: "2026-07-22T01:00:00.000Z",
    });
    assert.notEqual(first.issue.number, second.issue.number);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(client.issues.length, 2);
    assert.deepEqual(
      client.issues.map((issue) => issue.labels),
      [[SITE_BUILDING_LABELS.queued], [SITE_BUILDING_LABELS.queued]],
    );
    assert.equal(client.comments.length, 0);
  });

  it("accepts labels created concurrently by another enqueue", async () => {
    const getCounts = new Map();
    const apiClient = new GitHubIssuesClient({
      token: "test-token",
      repository: "WeZZard/skills",
      fetchImpl: async (url, options) => {
        const path = new URL(url).pathname;
        if (options.method === "GET") {
          const count = (getCounts.get(path) ?? 0) + 1;
          getCounts.set(path, count);
          return apiResponse(count === 1 ? 404 : 200);
        }
        if (options.method === "POST") return apiResponse(422);
        return apiResponse(500);
      },
    });

    await apiClient.ensureLabels();
    assert.deepEqual([...getCounts.values()], [2, 2, 2, 2]);
  });

  it("groups duplicate issues by immutable issue creation order", async () => {
    for (const generation of [1, 3, 2]) {
      await client.createIssue({
        title: "duplicate",
        body: encodeSiteBuildingTask(createWebsiteTask("amplify", {
          generation,
          requestedAt: `2026-07-22T0${generation}:00:00.000Z`,
        })),
        labels: [SITE_BUILDING_LABELS.queued],
      });
    }
    const group = groupSiteBuildingIssues(await client.listOpenIssues()).get("website:amplify");
    assert.deepEqual(group.map(({ issue }) => issue.number), [3, 2, 1]);
    assert.deepEqual(group.map(({ task }) => task.generation), [2, 3, 1]);
  });

  it("ignores a public issue marker without a site-building status label", async () => {
    const legitimate = await enqueueWebsiteTask(client, "amplify");
    await client.createIssue({
      title: "untrusted marker",
      body: encodeSiteBuildingTask(createWebsiteTask("amplify", {
        generation: 999,
      })),
      labels: ["bug"],
    });

    const group = groupSiteBuildingIssues(await client.listOpenIssues()).get("website:amplify");
    assert.equal(group.length, 1);
    assert.equal(group[0].issue.number, legitimate.issue.number);
  });

  it("resets attempts and restores the queued label", async () => {
    const created = await enqueueWebsiteTask(client, "amplify");
    const issue = client.issues[0];
    issue.body = encodeSiteBuildingTask({ ...created.task, attempts: 3 });
    issue.labels = [SITE_BUILDING_LABELS.blocked];
    await resetSiteBuildingTask(client, issue.number);
    assert.equal(parseSiteBuildingTask(issue.body).attempts, 0);
    assert.deepEqual(issue.labels, [SITE_BUILDING_LABELS.queued]);
  });

  it("refuses to reset a task that is not blocked", async () => {
    const created = await enqueueWebsiteTask(client, "amplify");
    await assert.rejects(
      resetSiteBuildingTask(client, created.issue.number),
      /is not open and blocked/,
    );
    assert.deepEqual(client.issues[0].labels, [SITE_BUILDING_LABELS.queued]);
  });
});

describe("site-building worker", () => {
  let client;

  beforeEach(async () => {
    client = new MemoryIssuesClient();
    await enqueueWebsiteTask(client, "amplify", {
      requestedAt: "2026-07-22T00:00:00.000Z",
    });
  });

  it("closes a no-change task without a status label", async () => {
    const result = await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async () => ({ outcome: "no-change", pullRequestUrl: null }),
      log: { log() {} },
    });
    assert.equal(result.processed, 1);
    assert.equal(client.issues[0].state, "closed");
    assert.deepEqual(client.issues[0].labels, []);
    assert.match(client.comments.at(-1).body, /no website changes/);
  });

  it("records the website pull request and closes the task", async () => {
    await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async () => ({
        outcome: "pull-request",
        pullRequestUrl: "https://github.com/WeZZard/skills/pull/10",
      }),
      log: { log() {} },
    });
    assert.equal(client.issues[0].state, "closed");
    assert.match(client.comments.at(-1).body, /pull\/10/);
  });

  it("deduplicates immutable requests and processes only the newest issue", async () => {
    await enqueueWebsiteTask(client, "amplify", {
      requestedAt: "2026-07-22T01:00:00.000Z",
    });
    const processedIssues = [];

    await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async ({ issue }) => {
        processedIssues.push(issue.number);
        return { outcome: "no-change", pullRequestUrl: null };
      },
      log: { log() {} },
    });

    assert.deepEqual(processedIssues, [2]);
    assert.deepEqual(client.issues.map((issue) => issue.state), ["closed", "closed"]);
    assert.deepEqual(client.issues.map((issue) => issue.labels), [[], []]);
    assert.match(client.comments[0].body, /Superseded by #2/);
  });

  it("leaves a request created during processing queued for the next run", async () => {
    await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async () => {
        await enqueueWebsiteTask(client, "amplify", {
          requestedAt: "2026-07-22T01:00:00.000Z",
        });
        return { outcome: "no-change", pullRequestUrl: null };
      },
      log: { log() {} },
    });

    assert.equal(client.issues[0].state, "closed");
    assert.equal(client.issues[1].state, "open");
    assert.deepEqual(client.issues[1].labels, [SITE_BUILDING_LABELS.queued]);
  });

  it("requeues a newer generation that arrives during processing", async () => {
    await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async ({ issue, task }) => {
        const newer = { ...task, generation: task.generation + 1 };
        await client.updateIssue(issue.number, { body: encodeSiteBuildingTask(newer) });
        return { outcome: "pull-request", pullRequestUrl: "https://example.test/pr/1" };
      },
      log: { log() {} },
    });
    assert.equal(client.issues[0].state, "open");
    assert.deepEqual(client.issues[0].labels, [SITE_BUILDING_LABELS.queued]);
  });

  it("marks three consecutive failures as blocked", async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runSiteBuildingWorker({
        client,
        now: allowedNow,
        processor: async () => { throw new Error("generation failed"); },
        log: { log() {} },
      });
      const task = parseSiteBuildingTask(client.issues[0].body);
      assert.equal(task.attempts, attempt);
      assert.deepEqual(client.issues[0].labels, [
        attempt === 3 ? SITE_BUILDING_LABELS.blocked : SITE_BUILDING_LABELS.failed,
      ]);
    }
  });

  it("does not claim work during the pre-peak hour", async () => {
    const result = await runSiteBuildingWorker({
      client,
      now: () => new Date("2026-07-22T08:00:00+08:00"),
      processor: async () => assert.fail("processor must not run"),
      log: { log() {} },
    });
    assert.equal(result.deferred, true);
    assert.deepEqual(client.issues[0].labels, [SITE_BUILDING_LABELS.queued]);
  });

  it("recovers an interrupted running task before applying the pricing guard", async () => {
    const interrupted = {
      ...parseSiteBuildingTask(client.issues[0].body),
      attempts: 2,
    };
    client.issues[0].body = encodeSiteBuildingTask(interrupted);
    client.issues[0].labels = [SITE_BUILDING_LABELS.running];

    const result = await runSiteBuildingWorker({
      client,
      now: () => new Date("2026-07-22T08:00:00+08:00"),
      processor: async () => assert.fail("processor must not run"),
      log: { log() {} },
    });

    assert.deepEqual(result, { processed: 0, deferred: true });
    assert.equal(parseSiteBuildingTask(client.issues[0].body).attempts, 2);
    assert.deepEqual(client.issues[0].labels, [SITE_BUILDING_LABELS.queued]);
    assert.match(client.comments.at(-1).body, /interrupted site-building worker/);
  });

  it("returns a claimed task to queued when pricing changes before Pi runs", async () => {
    await runSiteBuildingWorker({
      client,
      now: allowedNow,
      processor: async () => {
        throw new SiteBuildingWindowError("Peak pricing begins within 60 minutes");
      },
      log: { log() {} },
    });
    assert.equal(parseSiteBuildingTask(client.issues[0].body).attempts, 0);
    assert.deepEqual(client.issues[0].labels, [SITE_BUILDING_LABELS.queued]);
  });
});
