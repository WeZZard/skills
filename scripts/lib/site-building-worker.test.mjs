import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWebsiteTask } from "./site-building-queue.mjs";
import { processWebsiteContentTask } from "./site-building-worker.mjs";

const roots = [];

function command(program, args, cwd) {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

function createFixture({
  existingContent = false,
  openBranch = false,
  orphanBranch = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "site-building-use-path-"));
  roots.push(root);
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const runner = join(root, "runner");
  const bin = join(root, "bin");
  mkdirSync(seed);
  mkdirSync(bin);
  command("git", ["init", "--bare", "--initial-branch=main", remote], root);
  command("git", ["init", "--initial-branch=main"], seed);
  command("git", ["config", "user.name", "Fixture"], seed);
  command("git", ["config", "user.email", "fixture@example.com"], seed);
  mkdirSync(join(seed, "scripts"), { recursive: true });
  mkdirSync(join(seed, "website/src/content/generated/plugins"), { recursive: true });
  mkdirSync(join(seed, "website/src/content/generated/skills"), { recursive: true });
  writeFileSync(join(seed, "website/src/content/generated/plugins/.gitkeep"), "");
  writeFileSync(join(seed, "website/src/content/generated/skills/.gitkeep"), "");
  writeFileSync(
    join(seed, "scripts/update-plugin-website.mjs"),
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'const pluginIndex = process.argv.indexOf("--plugin");',
      'const plugin = process.argv[pluginIndex + 1];',
      'mkdirSync("catalog/website", { recursive: true });',
      'writeFileSync(`catalog/website/${plugin}.skills.toml`, "generated\\n");',
      'if (process.env.SITE_TEST_DEFER_PLUGIN === plugin) process.exit(75);',
      'if (process.env.SITE_TEST_FAIL_PLUGIN === plugin) process.exit(1);',
    ].join("\n"),
  );
  if (existingContent) {
    mkdirSync(join(seed, "catalog/website"), { recursive: true });
    writeFileSync(join(seed, "catalog/website/amplify.skills.toml"), "generated\n");
  }
  command("git", ["add", "."], seed);
  command("git", ["commit", "-m", "fixture"], seed);
  command("git", ["remote", "add", "origin", remote], seed);
  command("git", ["push", "-u", "origin", "main"], seed);
  if (orphanBranch) {
    command(
      "git",
      ["push", "origin", "main:refs/heads/agent/website-content/amplify"],
      seed,
    );
  }
  if (openBranch) {
    command("git", ["checkout", "-b", "agent/website-content/amplify"], seed);
    mkdirSync(join(seed, "catalog/website"), { recursive: true });
    writeFileSync(join(seed, "catalog/website/amplify.skills.toml"), "generated\n");
    command("git", ["add", "catalog/website/amplify.skills.toml"], seed);
    command("git", ["commit", "-m", "website branch"], seed);
    command("git", ["push", "origin", "agent/website-content/amplify"], seed);
    command("git", ["checkout", "main"], seed);
  }
  command("git", ["clone", remote, runner], root);

  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
      '  if [ -n "${SITE_TEST_ADVANCE_BRANCH:-}" ]; then',
      '    git -C "$SITE_TEST_SEED" commit --allow-empty -m "concurrent branch update" >/dev/null 2>&1',
      '    git -C "$SITE_TEST_SEED" push origin HEAD:refs/heads/agent/website-content/amplify >/dev/null 2>&1',
      "  fi",
      '  printf "%s" "${SITE_TEST_EXISTING_PR:-}"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.test/WeZZard/skills/pull/99"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return { remote, seed, runner, bin };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("site-building Git and pull-request use path", () => {
  it("writes content, pushes the deterministic branch, and opens a pull request", async () => {
    const { remote, runner, bin } = createFixture();
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const result = await processWebsiteContentTask({
        issue: { number: 7 },
        task: createWebsiteTask("amplify"),
      }, {
        cwd: runner,
        now: () => new Date("2026-07-22T12:30:00+08:00"),
      });
      assert.deepEqual(result, {
        outcome: "pull-request",
        pullRequestUrl: "https://github.test/WeZZard/skills/pull/99",
      });
      const content = command(
        "git",
        ["--git-dir", remote, "show", "agent/website-content/amplify:catalog/website/amplify.skills.toml"],
        runner,
      );
      assert.equal(content, "generated");
      const subject = command(
        "git",
        ["--git-dir", remote, "log", "-1", "--format=%s", "agent/website-content/amplify"],
        runner,
      );
      assert.equal(subject, "chore(website): update amplify content");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns no-change without creating a branch when main is current", async () => {
    const { remote, runner, bin } = createFixture({ existingContent: true });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const result = await processWebsiteContentTask({
        issue: { number: 8 },
        task: createWebsiteTask("amplify"),
      }, {
        cwd: runner,
        now: () => new Date("2026-07-22T12:30:00+08:00"),
      });
      assert.deepEqual(result, { outcome: "no-change", pullRequestUrl: null });
      const branch = command(
        "git",
        ["--git-dir", remote, "branch", "--list", "agent/website-content/amplify"],
        runner,
      );
      assert.equal(branch, "");
      assert.equal(
        readFileSync(join(runner, "catalog/website/amplify.skills.toml"), "utf8"),
        "generated\n",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("deletes an obsolete remote branch even when it has no open pull request", async () => {
    const { remote, runner, bin } = createFixture({
      existingContent: true,
      orphanBranch: true,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const result = await processWebsiteContentTask({
        issue: { number: 14 },
        task: createWebsiteTask("amplify"),
      }, {
        cwd: runner,
        now: () => new Date("2026-07-22T12:30:00+08:00"),
      });
      assert.deepEqual(result, { outcome: "no-change", pullRequestUrl: null });
      const branch = command(
        "git",
        ["--git-dir", remote, "branch", "--list", "agent/website-content/amplify"],
        runner,
      );
      assert.equal(branch, "");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("preserves an obsolete branch when it changes before deletion", async () => {
    const { remote, seed, runner, bin } = createFixture({
      existingContent: true,
      orphanBranch: true,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.SITE_TEST_ADVANCE_BRANCH = "1";
    process.env.SITE_TEST_SEED = seed;
    try {
      await assert.rejects(
        processWebsiteContentTask({
          issue: { number: 15 },
          task: createWebsiteTask("amplify"),
        }, {
          cwd: runner,
          now: () => new Date("2026-07-22T12:30:00+08:00"),
        }),
        /Failed to delete obsolete remote branch/,
      );
      const subject = command(
        "git",
        ["--git-dir", remote, "log", "-1", "--format=%s", "agent/website-content/amplify"],
        runner,
      );
      assert.equal(subject, "concurrent branch update");
    } finally {
      delete process.env.SITE_TEST_ADVANCE_BRANCH;
      delete process.env.SITE_TEST_SEED;
      process.env.PATH = originalPath;
    }
  });

  it("cleans an unchanged pull-request result before processing the next plugin", async () => {
    const { remote, runner, bin } = createFixture({ openBranch: true });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.SITE_TEST_EXISTING_PR = "https://github.test/WeZZard/skills/pull/98";
    try {
      const first = await processWebsiteContentTask({
        issue: { number: 9 },
        task: createWebsiteTask("amplify"),
      }, { cwd: runner, now: () => new Date("2026-07-22T12:30:00+08:00") });
      assert.equal(first.outcome, "unchanged-pull-request");
      assert.equal(command("git", ["status", "--porcelain"], runner), "");

      delete process.env.SITE_TEST_EXISTING_PR;
      const second = await processWebsiteContentTask({
        issue: { number: 10 },
        task: createWebsiteTask("skill-kit"),
      }, { cwd: runner, now: () => new Date("2026-07-22T12:30:00+08:00") });
      assert.equal(second.outcome, "pull-request");
      assert.equal(
        command(
          "git",
          ["--git-dir", remote, "show", "agent/website-content/skill-kit:catalog/website/skill-kit.skills.toml"],
          runner,
        ),
        "generated",
      );
      assert.equal(command("git", ["status", "--porcelain"], runner), "");
    } finally {
      delete process.env.SITE_TEST_EXISTING_PR;
      process.env.PATH = originalPath;
    }
  });

  it("cleans a failed generation before processing the next plugin", async () => {
    const { remote, runner, bin } = createFixture();
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.SITE_TEST_FAIL_PLUGIN = "amplify";
    try {
      await assert.rejects(
        processWebsiteContentTask({
          issue: { number: 11 },
          task: createWebsiteTask("amplify"),
        }, { cwd: runner, now: () => new Date("2026-07-22T12:30:00+08:00") }),
        /update-plugin-website/,
      );
      assert.equal(command("git", ["status", "--porcelain"], runner), "");

      delete process.env.SITE_TEST_FAIL_PLUGIN;
      const second = await processWebsiteContentTask({
        issue: { number: 12 },
        task: createWebsiteTask("skill-kit"),
      }, { cwd: runner, now: () => new Date("2026-07-22T12:30:00+08:00") });
      assert.equal(second.outcome, "pull-request");
      assert.equal(
        command(
          "git",
          ["--git-dir", remote, "show", "agent/website-content/skill-kit:catalog/website/skill-kit.skills.toml"],
          runner,
        ),
        "generated",
      );
    } finally {
      delete process.env.SITE_TEST_FAIL_PLUGIN;
      process.env.PATH = originalPath;
    }
  });

  it("propagates a pricing deferral from the child generator and cleans its files", async () => {
    const { runner, bin } = createFixture();
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.SITE_TEST_DEFER_PLUGIN = "amplify";
    try {
      await assert.rejects(
        processWebsiteContentTask({
          issue: { number: 13 },
          task: createWebsiteTask("amplify"),
        }, { cwd: runner, now: () => new Date("2026-07-22T12:30:00+08:00") }),
        { name: "SiteBuildingWindowError" },
      );
      assert.equal(command("git", ["status", "--porcelain"], runner), "");
    } finally {
      delete process.env.SITE_TEST_DEFER_PLUGIN;
      process.env.PATH = originalPath;
    }
  });
});
