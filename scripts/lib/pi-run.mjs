#!/usr/bin/env node

/** Run one bounded website-content prompt through Pi and parse its JSON result. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSiteBuildingWindow } from "./site-building-window.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PI_COMMAND = process.env.PI_COMMAND ?? "pi";
export const DEFAULT_PI_PROVIDER = "deepseek";
export const DEFAULT_PI_MODEL = "deepseek-v4-pro";
export const DEFAULT_PI_THINKING = "high";
export const DEFAULT_PI_PROBE_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SITE_BUILDING_SKILL = join(
  __dirname,
  "../../.pi/skills/site-building/SKILL.md",
);

export function parsePiJson(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) throw new Error("Pi produced no output");
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the JSON value is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Pi must return exactly one JSON object: ${error.message}`);
  }
}

function buildPromptText({ prompt, promptFile, files, cwd }) {
  const sections = [];
  if (promptFile) sections.push(readFileSync(promptFile, "utf8"));
  sections.push(
    prompt ?? "Generate the requested website content. Return only valid JSON.",
  );
  for (const file of files) {
    sections.push(`## ${basename(file)}\n\n${readFileSync(join(cwd, file), "utf8")}`);
  }
  return sections.join("\n\n");
}

export function buildPiEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const name of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "CATALOG_SYNC_TOKEN",
    "PLUGIN_CALLBACK_TOKEN",
  ]) {
    delete sanitized[name];
  }
  return sanitized;
}

export function buildPiArgs({
  prompt,
  skillPath = DEFAULT_SITE_BUILDING_SKILL,
  provider = DEFAULT_PI_PROVIDER,
  model = DEFAULT_PI_MODEL,
  thinking = DEFAULT_PI_THINKING,
}) {
  return [
    "--print",
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking,
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--approve",
    "--skill",
    skillPath,
    `/skill:site-building ${prompt}`,
  ];
}

export function isPiAvailable({
  command = DEFAULT_PI_COMMAND,
  spawn = spawnSync,
  timeoutMs = DEFAULT_PI_PROBE_TIMEOUT_MS,
} = {}) {
  const result = spawn(command, ["--version"], {
    encoding: "utf8",
    env: buildPiEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return !result.error && result.status === 0;
}

export function runPiPrompt({
  prompt,
  promptFile,
  cwd = process.cwd(),
  files = [],
  skillPath = DEFAULT_SITE_BUILDING_SKILL,
  provider = DEFAULT_PI_PROVIDER,
  model = DEFAULT_PI_MODEL,
  thinking = DEFAULT_PI_THINKING,
  command = DEFAULT_PI_COMMAND,
  spawn = spawnSync,
  now = new Date(),
  timeoutMs = DEFAULT_PI_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Pi timeout must be a positive integer in milliseconds");
  }
  assertSiteBuildingWindow(now);
  const fullPrompt = buildPromptText({ prompt, promptFile, files, cwd });
  const args = buildPiArgs({
    prompt: fullPrompt,
    skillPath,
    provider,
    model,
    thinking,
  });
  const result = spawn(command, args, {
    cwd,
    encoding: "utf8",
    env: buildPiEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`Pi timed out after ${timeoutMs / 1000} seconds`);
  }
  if (result.error) {
    throw new Error(`Pi could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Pi failed (${result.status ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
  }
  return parsePiJson(result.stdout);
}
