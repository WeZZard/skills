#!/usr/bin/env node

/**
 * Run a prompt through the OpenCode CLI and parse JSON from the response.
 *
 * Requires `opencode` on PATH and provider credentials (auth.json or env vars).
 */

import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? "deepseek/deepseek-chat";

export function isOpenCodeAvailable() {
  const result = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

export function ensureOpenCodeAuth() {
  const inline = process.env.OPENCODE_AUTH_JSON;
  if (!inline) {
    return;
  }
  const dir = join(homedir(), ".local/share/opencode");
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, inline, { mode: 0o600 });
}

function extractJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty OpenCode output");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("No JSON object found in OpenCode output");
    }
    return JSON.parse(match[0]);
  }
}

function parseOpenCodeOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("OpenCode produced no stdout");
  }

  try {
    const legacy = JSON.parse(trimmed);
    if (typeof legacy.response === "string") {
      return extractJson(legacy.response);
    }
  } catch {
    // fall through
  }

  const textParts = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (typeof event.text === "string") {
        textParts.push(event.text);
      }
      if (typeof event.content === "string") {
        textParts.push(event.content);
      }
      if (event.message?.content) {
        textParts.push(String(event.message.content));
      }
      if (event.part?.text) {
        textParts.push(event.part.text);
      }
    } catch {
      textParts.push(line);
    }
  }

  return extractJson(textParts.join("") || trimmed);
}

function buildPromptText({ prompt, promptFile, files, cwd }) {
  const parts = [];
  if (promptFile) {
    parts.push(readFileSync(promptFile, "utf8"));
  }
  parts.push(
    prompt ??
      "Follow the attached prompt files. Return ONLY valid JSON with no markdown fences.",
  );
  for (const file of files) {
    const path = join(cwd, file);
    parts.push(`## ${basename(file)}\n\n${readFileSync(path, "utf8")}`);
  }
  return parts.join("\n\n");
}

export function runOpenCodePrompt({
  prompt,
  promptFile,
  cwd = process.cwd(),
  model = DEFAULT_MODEL,
  files = [],
} = {}) {
  if (!isOpenCodeAvailable()) {
    throw new Error("opencode CLI is not available on PATH");
  }

  ensureOpenCodeAuth();

  // OpenCode 1.17+ treats every positional arg as a file path when -f is used.
  // Inline prompt files into the message and pass a single positional prompt.
  const fullPrompt = buildPromptText({ prompt, promptFile, files, cwd });
  const args = ["run", "--pure", "--auto", "-m", model, fullPrompt];

  const env = {
    ...process.env,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS ?? "1",
  };

  const result = spawnSync("opencode", args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      `opencode run failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }

  return parseOpenCodeOutput(result.stdout);
}
