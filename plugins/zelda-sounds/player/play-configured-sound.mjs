#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__dirname, "..");
const CONFIG_DIR = join(PLUGIN_ROOT, "config");
const DEFAULTS_JSON = join(CONFIG_DIR, "defaults.json");
const FIXED_USER_CONFIG_PATH = "~/.config/zelda-sounds.json";
const PLAY_SOUND_SH = join(PLUGIN_ROOT, "hooks", "play-sound.sh");

function readJsonFile(filepath, fallback) {
  if (!existsSync(filepath)) return fallback;

  try {
    return JSON.parse(readFileSync(filepath, "utf-8"));
  } catch {
    return fallback;
  }
}

function expandHome(pathname) {
  if (pathname === "~") return homedir();
  if (pathname.startsWith("~/")) return join(homedir(), pathname.slice(2));
  return pathname;
}

function resolveConfigPath(configPath) {
  const expanded = expandHome((configPath || FIXED_USER_CONFIG_PATH).trim() || FIXED_USER_CONFIG_PATH);
  return isAbsolute(expanded) ? expanded : resolve(PLUGIN_ROOT, expanded);
}

function readMomentMap(filepath) {
  const data = readJsonFile(filepath, {});
  return data.moments || {};
}

const momentId = process.argv[2];
if (!momentId) process.exit(1);

const configPath = FIXED_USER_CONFIG_PATH;
const defaults = readMomentMap(DEFAULTS_JSON);
const userConfig = readMomentMap(resolveConfigPath(configPath));

const hasOverride = Object.prototype.hasOwnProperty.call(userConfig, momentId);
const soundFile = hasOverride ? userConfig[momentId] : defaults[momentId];

if (!soundFile) process.exit(0);

const soundPath = join(PLUGIN_ROOT, "sounds", soundFile);
if (!existsSync(soundPath) || !existsSync(PLAY_SOUND_SH)) process.exit(0);

const child = spawn(PLAY_SOUND_SH, [soundPath], {
  stdio: "ignore",
  detached: true,
});

child.unref();
