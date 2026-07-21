import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildPiEnvironment,
  buildPiArgs,
  isPiAvailable,
  parsePiJson,
  runPiPrompt,
} from "./pi-run.mjs";
import {
  generateSkillContentWithLlm,
  validateGeneratedSkillContent,
} from "./website-llm.mjs";

const validContent = {
  display_name: "Test Skill",
  tagline: "Do one useful thing",
  short_summary: "A precise short summary.",
  full_summary: "A precise full summary that describes the supplied skill.",
  highlights: [
    { title: "One", description: "First supported capability." },
    { title: "Two", description: "Second supported capability." },
    { title: "Three", description: "Third supported capability." },
  ],
  workflow: [
    { name: "Read", description: "Read the input", details: "Inspect the supplied source." },
    { name: "Write", description: "Write the copy", details: "Describe supported behavior." },
    { name: "Return", description: "Return JSON", details: "Return the validated fields." },
  ],
};

describe("Pi website runner", () => {
  it("does not expose GitHub credentials to the Pi subprocess", () => {
    assert.deepEqual(buildPiEnvironment({
      DEEPSEEK_API_KEY: "deepseek",
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
      CATALOG_SYNC_TOKEN: "catalog",
      PLUGIN_CALLBACK_TOKEN: "callback",
    }), {
      DEEPSEEK_API_KEY: "deepseek",
    });
  });

  it("parses exactly one final JSON value without joining event deltas", () => {
    assert.deepEqual(parsePiJson('{"ok":true}'), { ok: true });
    assert.deepEqual(parsePiJson('  \n{"ok":true}\n'), { ok: true });
    assert.throws(() => parsePiJson('```json\n{"ok":true}\n```'), /exactly one JSON/);
    assert.throws(() => parsePiJson('Result:\n{"ok":true}'), /exactly one JSON/);
    assert.throws(() => parsePiJson('[]'), /not an object/);
    assert.throws(() => parsePiJson('{"a":1}{"b":2}'), /exactly one JSON/);
  });

  it("builds a bounded headless invocation", () => {
    const args = buildPiArgs({ prompt: "generate", skillPath: "/tmp/SKILL.md" });
    for (const flag of [
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
    ]) {
      assert.ok(args.includes(flag), `${flag} is present`);
    }
    assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2), ["--provider", "deepseek"]);
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "deepseek-v4-pro"]);
    assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);
    assert.equal(args.includes("--append-system-prompt"), false);
    assert.deepEqual(args.slice(args.indexOf("--skill"), args.indexOf("--skill") + 2), ["--skill", "/tmp/SKILL.md"]);
    assert.deepEqual(args, [
      "--print",
      "--provider", "deepseek",
      "--model", "deepseek-v4-pro",
      "--thinking", "high",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      "--skill", "/tmp/SKILL.md",
      "/skill:site-building generate",
    ]);
  });

  it("checks the pricing window before spawning Pi", () => {
    let spawned = false;
    assert.throws(
      () => runPiPrompt({
        prompt: "generate",
        now: new Date("2026-07-22T08:00:00+08:00"),
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: "{}", stderr: "" };
        },
      }),
      { name: "SiteBuildingWindowError" },
    );
    assert.equal(spawned, false);
  });

  it("bounds the Pi availability probe", () => {
    let receivedOptions;
    assert.equal(isPiAvailable({
      spawn: (_command, _args, options) => {
        receivedOptions = options;
        return { status: 0 };
      },
    }), true);
    assert.equal(receivedOptions.timeout, 10_000);
    assert.equal("GITHUB_TOKEN" in receivedOptions.env, false);
    assert.equal("GH_TOKEN" in receivedOptions.env, false);
  });

  it("parses the final Pi text through the command interface", () => {
    let receivedArgs;
    const result = runPiPrompt({
      prompt: "generate",
      now: new Date("2026-07-22T12:30:00+08:00"),
      spawn: (_command, args) => {
        receivedArgs = args;
        return { status: 0, stdout: JSON.stringify(validContent), stderr: "" };
      },
    });
    assert.equal(result.display_name, "Test Skill");
    assert.equal(receivedArgs.at(-1).includes("generate"), true);
  });

  it("terminates a Pi invocation after the configured timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "hanging-pi-"));
    const command = join(root, "pi");
    writeFileSync(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    chmodSync(command, 0o755);
    try {
      assert.throws(
        () => runPiPrompt({
          command,
          prompt: "generate",
          now: new Date("2026-07-22T12:30:00+08:00"),
          timeoutMs: 100,
        }),
        /Pi timed out after 0.1 seconds/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("website content validation", () => {
  it("accepts the complete website schema", () => {
    assert.deepEqual(validateGeneratedSkillContent(validContent), validContent);
  });

  it("retries one invalid response and returns the valid second response", async () => {
    let attempts = 0;
    const prompts = [];
    const result = await generateSkillContentWithLlm("test", "# Test", {
      now: new Date("2026-07-22T12:30:00+08:00"),
      runPrompt: async ({ prompt }) => {
        attempts += 1;
        prompts.push(prompt);
        return attempts === 1 ? { display_name: "Incomplete" } : validContent;
      },
    });
    assert.equal(attempts, 2);
    assert.equal(result.display_name, "Test Skill");
    assert.doesNotMatch(prompts[0], /Correction required/);
    assert.match(prompts[1], /## Correction required/);
    assert.match(prompts[1], /Pi response must contain 3-4 highlights/);
    assert.match(prompts[1], /Recheck every required field, array size, and character limit/);
  });

  it("fails after two invalid responses", async () => {
    let attempts = 0;
    await assert.rejects(
      generateSkillContentWithLlm("test", "# Test", {
        now: new Date("2026-07-22T12:30:00+08:00"),
        runPrompt: async () => {
          attempts += 1;
          return { display_name: "Incomplete" };
        },
      }),
      /invalid website content twice/,
    );
    assert.equal(attempts, 2);
  });
});
