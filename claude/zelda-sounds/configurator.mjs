#!/usr/bin/env node

// src/server.ts
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { exec } from "node:child_process";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
var __dirname = dirname(fileURLToPath(import.meta.url));
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  const candidates = [
    resolve(__dirname, ".."),
    resolve(__dirname, "../.."),
    __dirname
  ];
  return candidates.find(
    (candidate) => existsSync(join(candidate, "sounds")) && existsSync(join(candidate, "hooks"))
  ) || resolve(__dirname, "..");
}
var PLUGIN_ROOT = resolvePluginRoot();
var SOUNDS_DIR = join(PLUGIN_ROOT, "sounds");
var ASSETS_DIR = join(PLUGIN_ROOT, "assets");
var CONFIG_DIR = join(PLUGIN_ROOT, "config");
var DEFAULT_CONFIG_JSON = join(CONFIG_DIR, "defaults.json");
var SETTINGS_JSON = join(CONFIG_DIR, "settings.json");
var FIXED_USER_CONFIG_PATH = "~/.config/zelda-sounds.json";
var HOOKS_JSON = join(PLUGIN_ROOT, "hooks", "hooks.json");
var PORT = Number.parseInt(process.env.PORT || "4321", 10);
var SHOULD_OPEN_BROWSER = !["1", "true", "yes"].includes(
  (process.env.NO_OPEN || "").toLowerCase()
);
var MOMENTS = [
  { id: "session-started", label: "Session Started", description: "New or resumed session", event: "SessionStart", matcher: "startup|resume" },
  { id: "task-complete", label: "Task Complete", description: "Agent finished all work", event: "Stop", matcher: null },
  { id: "attention-needed", label: "Ask User Question", description: "Claude is about to ask you something", event: "PreToolUse", matcher: "AskUserQuestion" },
  { id: "plan-mode-entered", label: "Plan Mode Entered", description: "Entered planning mode", event: "PostToolUse", matcher: "EnterPlanMode" },
  { id: "plan-ready", label: "Plan Ready", description: "Plan is ready, awaiting your review", event: "PreToolUse", matcher: "ExitPlanMode" },
  { id: "plan-approved", label: "Plan Approved", description: "You approved the plan, execution begins", event: "PostToolUse", matcher: "ExitPlanMode" },
  { id: "subagent-done", label: "Subagents Done", description: "A subagent completed its work", event: "SubagentStop", matcher: ".*" },
  { id: "notification", label: "Notification", description: "Claude sent a notification", event: "Notification", matcher: ".*" },
  { id: "error", label: "Error", description: "A tool call failed", event: "PostToolUseFailure", matcher: ".*" }
];
var DEFAULT_MOMENT_SOUNDS = {
  "attention-needed": "Zelda-TotK-Puzzle-Solved.mp3",
  "plan-ready": "Zelda-TotK-Puzzle-Solved.mp3",
  "plan-approved": "Zelda-TotK-New-Location-Discovered.mp3",
  "task-complete": "Zelda-TotK-Historic-Item-Collected.mp3",
  "error": null,
  "notification": null,
  "subagent-done": null,
  "session-started": null,
  "plan-mode-entered": null
};
var MOMENT_FIGURES = {
  "session-started": "/assets/moment-scenes/session-started.jpg",
  "task-complete": "/assets/moments/link.png",
  "attention-needed": "/assets/moments/purah.png",
  "plan-mode-entered": "/assets/moment-scenes/plan-mode-entered.jpg",
  "plan-ready": "/assets/moments/josha.png",
  "plan-approved": "/assets/moments/zelda.png",
  "subagent-done": "/assets/moments/tulin.png",
  "notification": "/assets/moment-scenes/notification.jpg",
  "error": "/assets/moment-scenes/error.jpg"
};
function getSounds() {
  if (!existsSync(SOUNDS_DIR)) return [];
  return readdirSync(SOUNDS_DIR).filter((f) => f.endsWith(".mp3")).sort().map((f) => ({
    name: f.replace(/\.mp3$/, "").replace(/^Zelda-(BotW|TotK)-/, "").replace(/-/g, " "),
    file: f,
    size: statSync(join(SOUNDS_DIR, f)).size,
    source: f.startsWith("Zelda-BotW") ? "BotW" : f.startsWith("Zelda-TotK") ? "TotK" : ""
  }));
}
function readJsonFile(filepath, fallback) {
  if (!existsSync(filepath)) return fallback;
  try {
    return JSON.parse(readFileSync(filepath, "utf-8"));
  } catch {
    return fallback;
  }
}
function readHooksJson() {
  return readJsonFile(HOOKS_JSON, { description: "Zelda sound effects for Claude Code events", hooks: {} });
}
function expandHome(pathname) {
  if (pathname === "~") return homedir();
  if (pathname.startsWith("~/")) return join(homedir(), pathname.slice(2));
  return pathname;
}
function resolveConfigPath(configPath) {
  const expanded = expandHome(configPath.trim() || FIXED_USER_CONFIG_PATH);
  return isAbsolute(expanded) ? expanded : resolve(PLUGIN_ROOT, expanded);
}
function ensureRuntimeFiles() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(DEFAULT_CONFIG_JSON)) {
    writeFileSync(
      DEFAULT_CONFIG_JSON,
      JSON.stringify(
        {
          description: "Packaged default sound mapping for Zelda Sounds",
          moments: DEFAULT_MOMENT_SOUNDS
        },
        null,
        2
      ) + "\n"
    );
  }
  if (!existsSync(SETTINGS_JSON)) {
    writeFileSync(
      SETTINGS_JSON,
      JSON.stringify(
        {
          description: "Runtime settings for Zelda Sounds"
        },
        null,
        2
      ) + "\n"
    );
  }
}
function readMomentMap(filepath) {
  const data = readJsonFile(filepath, {});
  return data.moments || {};
}
function loadDefaultConfig() {
  return {
    ...DEFAULT_MOMENT_SOUNDS,
    ...readMomentMap(DEFAULT_CONFIG_JSON)
  };
}
function loadLegacyConfigFromHooks() {
  const hooksData = readHooksJson();
  const hooks = hooksData.hooks || {};
  const config = {};
  for (const moment of MOMENTS) {
    const eventHooks = hooks[moment.event];
    if (!Array.isArray(eventHooks)) continue;
    for (const entry of eventHooks) {
      const entryMatcher = entry.matcher || null;
      if (entryMatcher === moment.matcher || moment.matcher === null && !entryMatcher) {
        const cmds = entry.hooks || [];
        for (const cmd of cmds) {
          if (cmd.command?.includes("play-configured-sound.mjs")) continue;
          const match = cmd.command?.match(/sounds\/([^\s"]+\.mp3)/);
          if (match) {
            config[moment.id] = match[1];
            break;
          }
        }
        break;
      }
    }
  }
  return config;
}
function buildUserConfigDocument(storedMoments) {
  return JSON.stringify(
    {
      description: "User overrides for Zelda Sounds",
      moments: storedMoments
    },
    null,
    2
  ) + "\n";
}
function normalizeStoredMoments(rawMoments) {
  const source = rawMoments && typeof rawMoments === "object" ? rawMoments : {};
  const normalized = {};
  for (const moment of MOMENTS) {
    const value = source[moment.id];
    if (value === null) {
      normalized[moment.id] = null;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      normalized[moment.id] = value.trim();
      continue;
    }
    if (value && typeof value === "object") {
      const selection = value;
      if (selection.mode === "none") {
        normalized[moment.id] = null;
        continue;
      }
      if (typeof selection.sound === "string" && selection.sound.trim()) {
        normalized[moment.id] = selection.sound.trim();
      }
    }
  }
  return normalized;
}
function ensureUserConfigFile(configPath = FIXED_USER_CONFIG_PATH) {
  const resolvedConfigPath = resolveConfigPath(configPath);
  if (existsSync(resolvedConfigPath)) return resolvedConfigPath;
  mkdirSync(dirname(resolvedConfigPath), { recursive: true });
  const legacyMoments = loadLegacyConfigFromHooks();
  writeFileSync(resolvedConfigPath, buildUserConfigDocument(legacyMoments));
  return resolvedConfigPath;
}
function doctorUserConfigFile(configPath = FIXED_USER_CONFIG_PATH) {
  const resolvedConfigPath = ensureUserConfigFile(configPath);
  const rawText = readFileSync(resolvedConfigPath, "utf-8");
  let parsed = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = {};
  }
  const normalized = normalizeStoredMoments(parsed.moments);
  writeFileSync(resolvedConfigPath, buildUserConfigDocument(normalized));
  return resolvedConfigPath;
}
function getConfigState() {
  ensureRuntimeFiles();
  const configPath = FIXED_USER_CONFIG_PATH;
  const resolvedConfigPath = ensureUserConfigFile(configPath);
  const defaults = loadDefaultConfig();
  const userConfig = readMomentMap(resolvedConfigPath);
  const moments = MOMENTS.map((moment) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(userConfig, moment.id);
    const configuredSound = hasOverride ? userConfig[moment.id] : null;
    const defaultSound = defaults[moment.id] ?? null;
    const mode = hasOverride ? configuredSound === null ? "none" : "sound" : "default";
    return {
      id: moment.id,
      label: moment.label,
      description: moment.description,
      mode,
      sound: mode === "default" ? defaultSound : configuredSound,
      configuredSound,
      defaultSound
    };
  });
  return { configPath, resolvedConfigPath, moments, configPathEditable: false };
}
function buildHooksJson() {
  const hooks = {};
  for (const moment of MOMENTS) {
    if (!hooks[moment.event]) hooks[moment.event] = [];
    const command = `node "\${CLAUDE_PLUGIN_ROOT}/hooks/play-configured-sound.mjs" "${moment.id}"`;
    const entry = { hooks: [{ type: "command", command }] };
    if (moment.matcher !== null) entry.matcher = moment.matcher;
    hooks[moment.event].push(entry);
  }
  return { description: "Zelda sound effects for Claude Code events", hooks };
}
function normalizeConfigPayload(payload) {
  const body = payload || {};
  const selections = body.moments || {};
  const storedMoments = {};
  for (const moment of MOMENTS) {
    const selection = selections[moment.id];
    if (!selection || selection.mode === "default") continue;
    storedMoments[moment.id] = selection.mode === "none" ? null : selection.sound;
  }
  return { configPath: FIXED_USER_CONFIG_PATH, storedMoments };
}
function saveConfigState(configPath, storedMoments) {
  ensureRuntimeFiles();
  const resolvedConfigPath = resolveConfigPath(configPath);
  mkdirSync(dirname(resolvedConfigPath), { recursive: true });
  writeFileSync(resolvedConfigPath, buildUserConfigDocument(storedMoments));
  writeFileSync(SETTINGS_JSON, JSON.stringify({ description: "Runtime settings for Zelda Sounds" }, null, 2) + "\n");
  writeFileSync(HOOKS_JSON, JSON.stringify(buildHooksJson(), null, 2) + "\n");
  return resolvedConfigPath;
}
function openBrowser(url) {
  const os = platform();
  const cmd = os === "darwin" ? `open "${url}"` : os === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}
function openFile(filepath) {
  const os = platform();
  const quoted = JSON.stringify(filepath);
  const cmd = os === "darwin" ? `open ${quoted}` : os === "win32" ? `start "" ${quoted}` : `xdg-open ${quoted}`;
  exec(cmd);
}
function getMimeType(filename) {
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
function readBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve2(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
var HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zelda Sounds Configurator</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Source+Sans+3:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #FFFDF9; --surface: #FFFFFF; --accent: #C4704B; --accent-hover: #B5613C;
    --accent-soft: rgba(196,112,75,0.12); --secondary: #7D9B84; --secondary-soft: rgba(125,155,132,0.12);
    --text: #2C2416; --text-secondary: #4A4035; --text-muted: #7A6F60;
    --border: #E8E0D4; --border-subtle: #F0EBE3; --earth-100: #F5F0E8;
    --earth-200: #EBE4D8; --earth-300: #D4CCBC;
    --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px; --radius-2xl: 28px; --radius-full: 9999px;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06); --shadow-md: 0 4px 12px rgba(0,0,0,0.08); --shadow-lg: 0 16px 40px rgba(31,24,14,0.14);
    --moment-element-spacing: 16px; --moment-line-spacing: 1.35; --moment-card-spacing: 16px;
  }
  body { font-family: 'Source Sans 3', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; position: relative; }
  body::before { content: ''; position: fixed; inset: 0 0 auto 0; height: min(72vh, 760px);
    background:
      linear-gradient(180deg, rgba(12,35,54,0.14) 0%, rgba(255,253,249,0.06) 34%, rgba(255,253,249,0.76) 72%, var(--bg) 100%),
      url('/assets/zelda-totk-background.jpg') center top / cover no-repeat;
    z-index: -2; pointer-events: none; }
  body::after { content: ''; position: fixed; inset: 0;
    background:
      radial-gradient(circle at top right, rgba(196,112,75,0.12), transparent 30%),
      radial-gradient(circle at top left, rgba(125,155,132,0.10), transparent 28%);
    z-index: -3; pointer-events: none; }
  h1, h2, h3 { font-family: 'Playfair Display', serif; }
  .app { max-width: 1180px; margin: 0 auto; padding: 32px 24px calc(48px + env(safe-area-inset-bottom, 0px)); }
  .header { max-width: 760px; padding: min(18vh, 180px) 0 64px; }
  .header-kicker { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: var(--radius-full);
    background: rgba(255,255,255,0.7); border: 1px solid rgba(232,224,212,0.92); color: var(--text-secondary);
    font-size: 0.76rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 14px; backdrop-filter: blur(8px); }
  .header h1 { font-size: clamp(1.8rem, 4.8vw, 4.4rem); font-weight: 600; letter-spacing: -0.04em; margin-bottom: 0; line-height: 0.95; white-space: nowrap; }
  .header p { color: var(--text-secondary); font-size: 1.06rem; max-width: 56ch; }
  .shell { background: rgba(255,250,243,0.82); border: 1px solid rgba(232,224,212,0.9); border-radius: var(--radius-2xl);
    padding: 20px; box-shadow: var(--shadow-lg); backdrop-filter: blur(14px); }
  .shell-topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; flex-wrap: wrap; }
  .tab-bar { display: inline-flex; gap: 10px; padding: 6px; border-radius: var(--radius-full); background: rgba(255,255,255,0.76);
    border: 1px solid rgba(232,224,212,0.88); }
  .tab-btn { border: none; background: transparent; color: var(--text-muted); padding: 11px 18px; border-radius: var(--radius-full);
    font-family: inherit; font-size: 0.92rem; font-weight: 600; cursor: pointer; transition: all 0.16s ease; }
  .tab-btn:hover { color: var(--text); background: rgba(196,112,75,0.1); }
  .tab-btn.active { color: white; background: linear-gradient(135deg, var(--accent), var(--accent-hover)); box-shadow: var(--shadow-sm); }
  .top-control { display: none; align-items: center; justify-content: flex-end; gap: 12px; flex: 1; min-width: min(100%, 360px); }
  .top-control.active { display: flex; }
  .top-control-label { flex-shrink: 0; font-size: 0.76rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); }
  .top-control-input-wrap { position: relative; width: min(100%, 480px); }
  .top-control-input { width: 100%; padding: 10px 92px 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-md);
    font-family: inherit; font-size: 0.85rem; background: rgba(255,255,255,0.82); outline: none; }
  .top-control-input:focus { border-color: var(--accent); background: white; }
  .top-control-input:disabled { color: var(--text-muted); background: rgba(245,240,232,0.72); cursor: default; }
  .top-control-btn { position: absolute; top: 50%; width: 28px; height: 28px; padding: 0; transform: translateY(-50%);
    background: rgba(255,255,255,0.92); color: var(--text-secondary); border: 1px solid rgba(232,224,212,0.96);
    border-radius: 9999px; cursor: pointer; transition: all 0.15s ease; display: inline-flex; align-items: center; justify-content: center; }
  .top-control-btn svg { width: 14px; height: 14px; }
  .top-control-btn:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .top-control-btn:disabled { opacity: 0.5; cursor: default; }
  .top-control-btn.open-config-btn { right: 46px; }
  .top-control-btn.doctor-config-btn { right: 12px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; animation: fade-up 0.18s ease; }
  @keyframes fade-up { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .panel-title { font-size: 1.35rem; font-weight: 600; margin-bottom: 4px; }
  .panel-subtitle { color: var(--text-muted); font-size: 0.85rem; }
  .library-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 18px; flex-wrap: wrap; }
  .search-wrap { min-width: min(100%, 340px); }
  .search-label { display: block; font-size: 0.76rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 6px; }
  .search { width: 100%; padding: 12px 14px; border: 1px solid rgba(232,224,212,0.95); border-radius: var(--radius-md);
    font-family: inherit; font-size: 0.92rem; background: rgba(255,255,255,0.82); outline: none; }
  .search:focus { border-color: var(--accent); }
  .sound-list { display: grid; gap: 10px; }
  .sound-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid rgba(232,224,212,0.88); border-radius: var(--radius-md); transition: all 0.15s; background: rgba(255,255,255,0.76); }
  .sound-item:hover { border-color: var(--accent); background: var(--accent-soft); }
  .sound-item.playing { border-color: var(--accent); background: var(--accent-soft); }
  .play-btn { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--accent);
    background: var(--surface); color: var(--accent); cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; }
  .play-btn:hover, .play-btn.playing { background: var(--accent); color: white; }
  .play-btn svg { width: 14px; height: 14px; }
  .sound-main { flex: 1; min-width: 0; }
  .sound-name { font-size: 0.92rem; font-weight: 600; }
  .sound-file { color: var(--text-muted); font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sound-source { font-size: 0.7rem; color: var(--text-muted); background: var(--earth-100);
    padding: 2px 8px; border-radius: var(--radius-full); }
  .tuning-toggle { position: fixed; right: 24px; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); z-index: 33; }
  .tuning-panel { position: fixed; top: 24px; right: 24px; z-index: 34; width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 48px); overflow-y: auto; display: none; padding: 18px; border-radius: 22px;
    background: rgba(255,250,243,0.96); border: 1px solid rgba(232,224,212,0.9); box-shadow: var(--shadow-lg); backdrop-filter: blur(16px); }
  .tuning-panel.active { display: block; }
  .tuning-panel-header { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: calc(var(--moment-element-spacing) * 0.75); }
  .tuning-header { margin-bottom: calc(var(--moment-element-spacing) * 0.75); }
  .tuning-grid { display: grid; gap: 10px; margin-bottom: calc(var(--moment-element-spacing) * 0.75); }
  .tuning-row { display: grid; grid-template-columns: minmax(0, 180px) minmax(0, 1fr) 88px; gap: 12px; align-items: center; }
  .tuning-name { font-size: 0.86rem; color: var(--text-secondary); }
  .tuning-range { width: 100%; accent-color: var(--accent); }
  .tuning-number, .tuning-json { width: 100%; border: 1px solid rgba(232,224,212,0.95); border-radius: var(--radius-md);
    background: rgba(255,255,255,0.82); color: var(--text); font-family: inherit; outline: none; }
  .tuning-number { padding: 9px 10px; font-size: 0.84rem; }
  .tuning-number:focus, .tuning-json:focus { border-color: var(--accent); background: white; }
  .tuning-json { min-height: 112px; resize: vertical; padding: 12px 14px; font-size: 0.82rem; line-height: 1.45; margin-bottom: 12px; }
  .tuning-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .tuning-btn { border: 1px solid rgba(232,224,212,0.95); background: rgba(255,255,255,0.82); color: var(--text-secondary);
    border-radius: var(--radius-full); padding: 8px 14px; font-family: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s ease; }
  .tuning-btn:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .tuning-close { width: 34px; height: 34px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .tuning-status { min-height: 18px; color: var(--text-muted); font-size: 0.76rem; }
  .tuning-status.success { color: var(--secondary); }
  .tuning-status.error { color: #c0392b; }
  .moment-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--moment-card-spacing); align-items: start; }
  .moment-panel-actions { display: flex; justify-content: center; gap: 12px; margin-top: calc(var(--moment-card-spacing) * 0.4); padding-top: 4px; padding-bottom: 22px; }
  .moment-item { position: relative; overflow: visible; border: none; border-radius: 18px; padding: var(--moment-element-spacing); transition: none;
    background: transparent; box-shadow: none; }
  .moment-item:hover { background: transparent; }
  .moment-item.menu-open { z-index: 10; }
  .moment-top { position: relative; z-index: 1; margin-bottom: 0; padding-left: 14px; padding-right: 0; }
  .moment-title-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: calc(var(--moment-element-spacing) * 0.25); }
  .moment-label { font-weight: 600; font-size: 0.98rem; min-width: 0; line-height: var(--moment-line-spacing); }
  .moment-desc { color: var(--text-muted); font-size: 0.8rem; line-height: var(--moment-line-spacing);
    margin-top: calc(var(--moment-element-spacing) * 0.125); margin-bottom: 0; }
  .moment-badge { flex-shrink: 0; max-width: 48%; padding: 6px 10px; border-radius: var(--radius-full); background: var(--earth-100);
    color: var(--text-secondary); font-size: 0.72rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .moment-badge.invalid { background: rgba(255,242,240,0.96); color: #c0392b; }
  .moment-item.invalid { background: transparent; box-shadow: none; }
  .moment-input-wrap { position: relative; z-index: 2; margin-top: 24px; margin-right: 0; }
  .moment-input { width: 100%; padding: 12px 48px 12px 14px; border: 1px solid rgba(232,224,212,0.95); border-radius: var(--radius-md);
    font-family: inherit; font-size: 0.9rem; background: var(--earth-100); outline: none; }
  .moment-input:focus { border-color: var(--accent); background: white; }
  .moment-input.invalid { border-color: rgba(192,57,43,0.62); background: rgba(255,242,240,0.94); }
  .moment-preview-btn { position: absolute; top: 50%; right: 10px; transform: translateY(-50%); width: 30px; height: 30px; }
  .preview-btn { border-radius: 50%; border: 1.5px solid var(--secondary);
    background: var(--surface); color: var(--secondary); cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; }
  .preview-btn:hover, .preview-btn.playing { background: var(--secondary); color: white; }
  .preview-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .preview-btn svg { width: 10px; height: 10px; }
  .moment-actions { display: flex; align-items: center; justify-content: flex-start; gap: 10px; margin-top: calc(var(--moment-element-spacing) * 0.625); }
  .default-btn { border: 1px solid rgba(232,224,212,0.95); background: rgba(255,255,255,0.82); color: var(--text-secondary);
    border-radius: var(--radius-full); padding: 7px 12px; font-family: inherit; font-size: 0.76rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s ease; }
  .default-btn:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .moment-meta { position: relative; z-index: 0; margin-top: calc(var(--moment-element-spacing) * 0.5); min-height: 18px; color: var(--text-muted); font-size: 0.77rem; line-height: var(--moment-line-spacing); }
  .moment-meta.invalid { color: #c0392b; }
  .candidate-menu { position: absolute; top: calc(100% + 4px); bottom: auto; left: 0; right: 0; z-index: 12; padding: 8px;
    border-radius: 14px; border: 1px solid rgba(232,224,212,0.96); background: rgba(255,255,255,0.98);
    box-shadow: 0 8px 28px rgba(31,24,14,0.14); display: grid; gap: 4px; backdrop-filter: blur(10px);
    max-height: min(40vh, 360px); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .candidate-menu.empty { padding: 10px 12px; color: var(--text-muted); font-size: 0.8rem; }
  .candidate-item { width: 100%; border: 1px solid transparent; background: transparent; border-radius: 10px;
    transition: all 0.14s ease; display: flex; align-items: center; gap: 0; }
  .candidate-item:hover, .candidate-item.active { border-color: rgba(196,112,75,0.28); background: var(--accent-soft); }
  .candidate-select { flex: 1; min-width: 0; border: none; background: transparent; padding: 7px 10px;
    text-align: left; cursor: pointer; display: block; font-family: inherit; color: inherit; }
  .candidate-main { min-width: 0; display: grid; gap: 2px; }
  .candidate-name { font-size: 0.8rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .candidate-source { display: inline-flex; width: fit-content; font-size: 0.65rem; color: var(--text-muted); background: var(--earth-100);
    padding: 2px 6px; border-radius: var(--radius-full); }
  .candidate-preview-btn { width: 26px; height: 26px; flex-shrink: 0; align-self: center; margin-right: 8px; margin-left: 0; }
  .empty-state { padding: 18px; border-radius: 18px; border: 1px dashed var(--earth-300); color: var(--text-muted); text-align: center; background: rgba(255,255,255,0.58); }
  .save-btn { padding: 12px 32px; background: var(--accent); color: white; border: none;
    border-radius: var(--radius-full); font-family: inherit; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s ease; box-shadow: none; }
  .save-btn:hover { background: var(--accent-hover); }
  .save-btn:disabled { background: color-mix(in srgb, var(--accent) 42%, #b9b2a6 58%); color: rgba(255,255,255,0.82); cursor: default; }
  .reset-btn { padding: 12px 24px; background: rgba(255,255,255,0.82); color: var(--text-secondary); border: 1px solid var(--border);
    border-radius: var(--radius-full); font-family: inherit; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s ease; }
  .reset-btn:hover { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .reset-btn:disabled { opacity: 0.5; cursor: default; }
  .status { position: fixed; left: 50%; bottom: calc(86px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%);
    text-align: center; font-size: 0.85rem; padding: 8px 14px; border-radius: var(--radius-full); border: 1px solid var(--border);
    background: rgba(255,255,255,0.92); box-shadow: var(--shadow-sm); z-index: 31; opacity: 0; pointer-events: none;
    transition: opacity 0.18s ease; max-width: min(calc(100vw - 32px), 720px); }
  .status:not(:empty) { opacity: 1; }
  .status.success { color: var(--secondary); }
  .status.error { color: #c0392b; }
  @media (max-width: 900px) {
    .app { padding-left: 16px; padding-right: 16px; padding-bottom: calc(48px + env(safe-area-inset-bottom, 0px)); }
    .header { padding-top: 120px; }
    .shell { padding: 16px; border-radius: 22px; }
    .shell-topbar { align-items: stretch; }
    .tab-bar { width: 100%; }
    .tab-btn { flex: 1; text-align: center; }
    .top-control { width: 100%; min-width: 0; justify-content: stretch; }
    .top-control-input { width: 100%; }
    .moment-list { grid-template-columns: 1fr; }
    .moment-top { padding-right: 0; }
    .moment-input-wrap { margin-right: 0; }
    .tuning-toggle { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
    .tuning-panel { top: 16px; right: 16px; width: calc(100vw - 32px); max-height: calc(100vh - 32px); }
    .tuning-row { grid-template-columns: 1fr; gap: 8px; }
    .save-btn { width: min(100%, 420px); }
    .status { width: calc(100vw - 32px); }
  }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1>Zelda Sounds Configurator</h1>
  </div>

  <div class="shell">
    <div class="shell-topbar">
      <div class="tab-bar" role="tablist" aria-label="Configurator sections">
        <button class="tab-btn active" data-tab="moments" role="tab" aria-selected="true">Moments</button>
        <button class="tab-btn" data-tab="library" role="tab" aria-selected="false">Sound Library</button>
      </div>
      <div class="top-control active" data-top-control="moments">
        <span class="top-control-label">Configuration File</span>
        <div class="top-control-input-wrap">
          <input type="text" class="top-control-input" id="config-path" placeholder="~/.config/zelda-sounds.json" disabled aria-disabled="true">
          <button class="top-control-btn open-config-btn" id="open-config" type="button" title="Open File" aria-label="Open File">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3h7v7"></path>
              <path d="M10 14L21 3"></path>
              <path d="M21 14v6a1 1 0 0 1-1 1h-6"></path>
              <path d="M3 10V4a1 1 0 0 1 1-1h6"></path>
            </svg>
          </button>
          <button class="top-control-btn doctor-config-btn" id="doctor-config" type="button" title="Doctor" aria-label="Doctor">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 8a1 1 0 1 1 0 2a1 1 0 0 1 0-2M2 2v9c0 2.96 2.19 5.5 5.14 5.91C7.76 19.92 10.42 22 13.5 22A6.5 6.5 0 0 0 20 15.5v-3.69A3 3 0 0 0 22 9a3 3 0 0 0-6 0c0 1.29.84 2.4 2 2.81v3.6c0 2.5-2 4.5-4.5 4.5c-2 0-3.68-1.21-4.28-3.01C12 16.3 14 13.8 14 11V2h-4v3h2v6a4 4 0 0 1-4 4a4 4 0 0 1-4-4V5h2V2z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="top-control" data-top-control="library">
        <span class="top-control-label">Search Sounds</span>
        <input type="text" class="top-control-input" id="search" placeholder="Fuzzy-search by name or expansion">
      </div>
    </div>

    <section class="tab-panel active" data-tab-panel="moments" role="tabpanel">
      <div class="moment-list" id="moment-list"></div>
      <div class="moment-panel-actions">
        <button class="reset-btn" id="reset" type="button">Reset</button>
        <button class="save-btn" id="save">Save Configuration</button>
      </div>
    </section>

    <section class="tab-panel" data-tab-panel="library" role="tabpanel">
      <div class="library-toolbar">
        <div>
          <p class="panel-subtitle"><span id="sound-count">0</span> sounds available across the active library</p>
        </div>
      </div>
      <div class="sound-list" id="sound-list"></div>
    </section>
  </div>

  <button class="tuning-btn tuning-toggle" type="button" id="toggle-layout-tuning">Layout Tuning</button>
  <div class="tuning-panel" id="layout-tuning-panel" aria-hidden="true">
    <div class="tuning-panel-header">
      <div class="tuning-header">
        <h2 class="panel-title">Layout Tuning</h2>
        <p class="panel-subtitle">Adjust the spacing live, copy the JSON, and paste it back here later.</p>
      </div>
      <button class="tuning-btn tuning-close" type="button" id="close-layout-tuning" aria-label="Close layout tuning">&times;</button>
    </div>
    <div class="tuning-grid">
      <label class="tuning-row">
        <span class="tuning-name">Element spacing</span>
        <input class="tuning-range" type="range" min="8" max="40" step="1" data-tuning-range="elementSpacing">
        <input class="tuning-number" type="number" min="8" max="40" step="1" data-tuning-number="elementSpacing">
      </label>
      <label class="tuning-row">
        <span class="tuning-name">Line spacing</span>
        <input class="tuning-range" type="range" min="1" max="2.2" step="0.05" data-tuning-range="lineSpacing">
        <input class="tuning-number" type="number" min="1" max="2.2" step="0.05" data-tuning-number="lineSpacing">
      </label>
      <label class="tuning-row">
        <span class="tuning-name">Card spacing</span>
        <input class="tuning-range" type="range" min="0" max="40" step="1" data-tuning-range="cardSpacing">
        <input class="tuning-number" type="number" min="0" max="40" step="1" data-tuning-number="cardSpacing">
      </label>
    </div>
    <textarea class="tuning-json" id="layout-tuning-json" spellcheck="false"></textarea>
    <div class="tuning-actions">
      <button class="tuning-btn" type="button" id="copy-layout-tuning">Copy Data</button>
      <button class="tuning-btn" type="button" id="paste-layout-tuning">Paste Data</button>
      <button class="tuning-btn" type="button" id="apply-layout-tuning">Apply Text</button>
    </div>
    <div class="tuning-status" id="layout-tuning-status" aria-live="polite"></div>
  </div>

  <div class="status" id="status" aria-live="polite"></div>
</div>

<script>
let sounds = [];
let moments = [];
let currentAudio = null;
let currentBtn = null;
let configPath = '';
let resolvedConfigPath = '';
let activeTab = 'moments';
let libraryQuery = '';
let openMenuIndex = null;
let highlightedCandidateIndex = 0;
let soundNameCounts = {};
const MOMENT_FIGURE_ASSETS = Object.freeze(${JSON.stringify(MOMENT_FIGURES)});
let loadedMomentState = '[]';
const DEFAULT_LAYOUT_TUNING = Object.freeze({ elementSpacing: 8, lineSpacing: 2.2, cardSpacing: 25 });
let layoutTuning = { ...DEFAULT_LAYOUT_TUNING };
let layoutTuningStatusTimer = null;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function formatSoundName(file) {
  return String(file || '').replace(/.mp3$/, '').replace(/^Zelda-(BotW|TotK)-/, '').replace(/-/g, ' ');
}

function getSoundByFile(file) {
  return sounds.find(function (sound) { return sound.file === file; }) || null;
}

function clampTuningNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeLayoutTuning(raw) {
  return {
    elementSpacing: clampTuningNumber(raw && raw.elementSpacing, 8, 40, DEFAULT_LAYOUT_TUNING.elementSpacing),
    lineSpacing: clampTuningNumber(raw && raw.lineSpacing, 1, 2.2, DEFAULT_LAYOUT_TUNING.lineSpacing),
    cardSpacing: clampTuningNumber(raw && raw.cardSpacing, 0, 40, DEFAULT_LAYOUT_TUNING.cardSpacing)
  };
}

function serializeLayoutTuning() {
  return JSON.stringify(layoutTuning, null, 2);
}

function setLayoutTuningStatus(message, isError) {
  const status = document.getElementById('layout-tuning-status');
  if (!status) return;
  status.textContent = message || '';
  status.className = 'tuning-status' + (message ? (isError ? ' error' : ' success') : '');
  if (layoutTuningStatusTimer) window.clearTimeout(layoutTuningStatusTimer);
  if (message) {
    layoutTuningStatusTimer = window.setTimeout(function () {
      status.textContent = '';
      status.className = 'tuning-status';
    }, 3000);
  }
}

function syncLayoutTuningControls() {
  document.querySelectorAll('[data-tuning-range]').forEach(function (input) {
    const key = input.dataset.tuningRange;
    input.value = String(layoutTuning[key]);
  });
  document.querySelectorAll('[data-tuning-number]').forEach(function (input) {
    const key = input.dataset.tuningNumber;
    input.value = String(layoutTuning[key]);
  });
  const textarea = document.getElementById('layout-tuning-json');
  if (textarea) textarea.value = serializeLayoutTuning();
}

function applyLayoutTuning(nextTuning) {
  layoutTuning = normalizeLayoutTuning(nextTuning);
  document.documentElement.style.setProperty('--moment-element-spacing', layoutTuning.elementSpacing + 'px');
  document.documentElement.style.setProperty('--moment-line-spacing', String(layoutTuning.lineSpacing));
  document.documentElement.style.setProperty('--moment-card-spacing', layoutTuning.cardSpacing + 'px');
  syncLayoutTuningControls();
}

function applyLayoutTuningText(text) {
  const parsed = JSON.parse(text);
  applyLayoutTuning(parsed);
}

function bindLayoutTuningPanel() {
  const panel = document.getElementById('layout-tuning-panel');
  const toggle = document.getElementById('toggle-layout-tuning');
  const close = document.getElementById('close-layout-tuning');

  function setLayoutTuningPanelOpen(open) {
    panel.classList.toggle('active', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  toggle.addEventListener('click', function () {
    setLayoutTuningPanelOpen(!panel.classList.contains('active'));
  });

  close.addEventListener('click', function () {
    setLayoutTuningPanelOpen(false);
  });

  document.querySelectorAll('[data-tuning-range]').forEach(function (input) {
    input.addEventListener('input', function () {
      const key = input.dataset.tuningRange;
      applyLayoutTuning({ ...layoutTuning, [key]: input.value });
    });
  });

  document.querySelectorAll('[data-tuning-number]').forEach(function (input) {
    input.addEventListener('input', function () {
      const key = input.dataset.tuningNumber;
      applyLayoutTuning({ ...layoutTuning, [key]: input.value });
    });
  });

  document.getElementById('copy-layout-tuning').addEventListener('click', async function () {
    const textarea = document.getElementById('layout-tuning-json');
    try {
      await navigator.clipboard.writeText(textarea.value);
      setLayoutTuningStatus('Layout tuning copied.', false);
    } catch {
      textarea.focus();
      textarea.select();
      setLayoutTuningStatus('Copy failed; use manual copy from the text box.', true);
    }
  });

  document.getElementById('paste-layout-tuning').addEventListener('click', async function () {
    const textarea = document.getElementById('layout-tuning-json');
    try {
      const text = await navigator.clipboard.readText();
      textarea.value = text;
      applyLayoutTuningText(text);
      setLayoutTuningStatus('Layout tuning pasted.', false);
    } catch {
      setLayoutTuningStatus('Paste failed; paste into the text box and click Apply Text.', true);
    }
  });

  document.getElementById('apply-layout-tuning').addEventListener('click', function () {
    const textarea = document.getElementById('layout-tuning-json');
    try {
      applyLayoutTuningText(textarea.value);
      setLayoutTuningStatus('Layout tuning applied.', false);
    } catch {
      setLayoutTuningStatus('Invalid layout tuning JSON.', true);
    }
  });

  applyLayoutTuning(DEFAULT_LAYOUT_TUNING);
}

function rebuildSoundNameCounts() {
  soundNameCounts = sounds.reduce(function (counts, sound) {
    counts[sound.name] = (counts[sound.name] || 0) + 1;
    return counts;
  }, {});
}

function isAmbiguousSoundName(name) {
  return (soundNameCounts[name] || 0) > 1;
}

function getSoundInputLabel(sound) {
  if (!sound) return '';
  return isAmbiguousSoundName(sound.name) && sound.source
    ? sound.name + ' (' + sound.source + ')'
    : sound.name;
}

function findExactSound(query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;

  for (const sound of sounds) {
    const candidates = [getSoundInputLabel(sound), sound.file];
    if (!isAmbiguousSoundName(sound.name)) {
      candidates.push(sound.name, formatSoundName(sound.file));
    }
    if (candidates.some(function (candidate) { return normalizeText(candidate) === normalizedQuery; })) {
      return sound;
    }
  }

  return null;
}

function getEffectiveSound(moment) {
  if (moment.mode === 'default') return moment.defaultSound || null;
  if (moment.mode === 'sound') return moment.configuredSound || null;
  return null;
}

function serializeMomentStateFromSnapshot(snapshotMoments) {
  return JSON.stringify(snapshotMoments.map(function (moment) {
    return {
      id: moment.id,
      sound: moment.sound || null,
    };
  }));
}

function serializeCurrentMomentState() {
  return JSON.stringify(moments.map(function (moment) {
    return {
      id: moment.id,
      sound: getEffectiveSound(moment),
    };
  }));
}

function updateSaveButtonState() {
  const button = document.getElementById('save');
  if (!button) return;

  const hasErrors = moments.some(function (moment) { return Boolean(moment.error); });
  const hasChanges = serializeCurrentMomentState() !== loadedMomentState;
  const canSave = hasChanges && !hasErrors;

  button.disabled = !canSave;
  button.title = hasErrors
    ? 'Fix invalid sound selections before saving.'
    : hasChanges
      ? 'Save Configuration'
      : 'No changes to save.';
}

function hydrateMoment(moment) {
  const selectedMeta = moment.sound ? getSoundByFile(moment.sound) : null;
  return {
    id: moment.id,
    label: moment.label,
    description: moment.description,
    mode: moment.mode,
    sound: moment.sound,
    configuredSound: moment.configuredSound || null,
    defaultSound: moment.defaultSound,
    query: selectedMeta ? getSoundInputLabel(selectedMeta) : '',
    error: '',
    menuDirection: 'down'
  };
}

function updateConfigPathHelp() {
  const input = document.getElementById('config-path');
  if (!input) return;
  input.title = 'Resolved path: ' + (resolvedConfigPath || '(pending save)');
  input.disabled = true;
  input.setAttribute('aria-disabled', 'true');
}

function fuzzyScore(query, candidate) {
  const normalizedQuery = normalizeText(query);
  const normalizedCandidate = normalizeText(candidate);

  if (!normalizedQuery) return 0;
  if (!normalizedCandidate) return Number.NEGATIVE_INFINITY;

  if (normalizedCandidate.includes(normalizedQuery)) {
    return 140 - normalizedCandidate.indexOf(normalizedQuery) - (normalizedCandidate.length - normalizedQuery.length) * 0.08;
  }

  let score = 0;
  let cursor = -1;
  let streak = 0;

  for (const char of normalizedQuery) {
    if (char === ' ') continue;

    const next = normalizedCandidate.indexOf(char, cursor + 1);
    if (next === -1) return Number.NEGATIVE_INFINITY;

    if (next === cursor + 1) {
      streak += 1;
      score += 4 + streak;
    } else {
      streak = 0;
      score += 1;
    }

    if (next === 0 || normalizedCandidate[next - 1] === ' ') score += 6;
    cursor = next;
  }

  return score - normalizedCandidate.length * 0.03;
}

function rankSounds(query, limit) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return sounds.slice(0, limit || sounds.length);

  return sounds
    .map(function (sound) {
      return {
        sound: sound,
        score: fuzzyScore(trimmed, sound.name + ' ' + sound.file + ' ' + sound.source)
      };
    })
    .filter(function (entry) { return entry.score > Number.NEGATIVE_INFINITY; })
    .sort(function (left, right) {
      if (right.score !== left.score) return right.score - left.score;
      return left.sound.name.localeCompare(right.sound.name);
    })
    .slice(0, limit || sounds.length)
    .map(function (entry) { return entry.sound; });
}

function syncMomentSelection(moment) {
  const trimmed = String(moment.query || '').trim();
  if (!trimmed) {
    moment.mode = 'none';
    moment.sound = null;
    moment.configuredSound = null;
    moment.error = '';
    return;
  }

  const exact = findExactSound(trimmed);
  moment.mode = 'sound';
  moment.sound = exact ? exact.file : null;
  moment.configuredSound = exact ? exact.file : null;
  moment.error = exact ? '' : 'Cannot find the sound.';
}

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(function (button) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-top-control]').forEach(function (control) {
    control.classList.toggle('active', control.dataset.topControl === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(function (panel) {
    panel.classList.toggle('active', panel.dataset.tabPanel === tab);
  });
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentBtn) {
    currentBtn.classList.remove('playing');
    currentBtn.closest('.sound-item, .moment-item, .candidate-item')?.classList.remove('playing');
    currentBtn = null;
  }
  document.querySelectorAll('.preview-btn.playing, .play-btn.playing').forEach(function (button) {
    button.classList.remove('playing');
  });
}

function playSound(file, btn) {
  if (!file || btn.disabled) return;
  if (currentAudio && currentBtn === btn) {
    stopAudio();
    return;
  }

  stopAudio();
  currentAudio = new Audio('/sounds/' + file);
  currentBtn = btn;
  btn.classList.add('playing');
  btn.closest('.sound-item, .moment-item, .candidate-item')?.classList.add('playing');
  currentAudio.addEventListener('ended', stopAudio);
  currentAudio.play();
}

function describeMoment(moment) {
  return moment.error || '';
}

function getMomentBadgeLabel(moment) {
  if (moment.error) return 'Not found';
  const effectiveSound = getEffectiveSound(moment);
  const effectiveMeta = effectiveSound ? getSoundByFile(effectiveSound) : null;
  return effectiveMeta ? getSoundInputLabel(effectiveMeta) : 'No sound';
}

function getDefaultButtonLabel(moment) {
  if (!moment.defaultSound) return 'Default: No sound';
  const defaultMeta = getSoundByFile(moment.defaultSound);
  return 'Default: ' + (defaultMeta ? getSoundInputLabel(defaultMeta) : formatSoundName(moment.defaultSound));
}

function getMomentSuggestions(moment) {
  const defaultMeta = moment.defaultSound ? getSoundByFile(moment.defaultSound) : null;

  return [{
    kind: 'default',
    file: moment.defaultSound || '',
    name: getDefaultButtonLabel(moment),
    source: 'Default'
  }].concat(rankSounds(moment.query).map(function (sound) {
    return {
      kind: 'sound',
      file: sound.file,
      name: sound.name,
      source: sound.source || ''
    };
  }));
}

function setMenuDirection(index, element) {
  const rect = element.getBoundingClientRect();
  moments[index].menuDirection = window.innerHeight - rect.bottom < 250 && rect.top > 240 ? 'up' : 'down';
}

function setMomentQuery(index, query) {
  const moment = moments[index];
  moment.query = query;
  syncMomentSelection(moment);
}

function chooseMomentSound(index, file) {
  const moment = moments[index];
  const sound = getSoundByFile(file);
  moment.mode = 'sound';
  moment.configuredSound = file;
  moment.sound = file;
  moment.query = getSoundInputLabel(sound);
  moment.error = '';
}

function chooseMomentSuggestion(index, kind, file) {
  if (kind === 'default') {
    resetMomentToDefault(index);
    return;
  }

  chooseMomentSound(index, file);
}

function resetMomentToDefault(index) {
  const moment = moments[index];
  const defaultSound = moment.defaultSound ? getSoundByFile(moment.defaultSound) : null;
  moment.mode = 'default';
  moment.configuredSound = null;
  moment.sound = moment.defaultSound || null;
  moment.query = defaultSound ? getSoundInputLabel(defaultSound) : '';
  moment.error = '';
}

function openCandidateMenu(index, element) {
  openMenuIndex = index;
  highlightedCandidateIndex = 0;
  setMenuDirection(index, element);
}

function closeCandidateMenu() {
  openMenuIndex = null;
  highlightedCandidateIndex = 0;
}

function handleMomentKeydown(event, index, input) {
  const suggestions = getMomentSuggestions(moments[index]);

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (openMenuIndex !== index) {
      openCandidateMenu(index, input);
    } else if (suggestions.length) {
      highlightedCandidateIndex = Math.min(highlightedCandidateIndex + 1, suggestions.length - 1);
    }
    renderMoments({ index: index, cursor: input.selectionStart || input.value.length });
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (openMenuIndex !== index) {
      openCandidateMenu(index, input);
    } else if (suggestions.length) {
      highlightedCandidateIndex = Math.max(highlightedCandidateIndex - 1, 0);
    }
    renderMoments({ index: index, cursor: input.selectionStart || input.value.length });
    return;
  }

  if (event.key === 'Escape') {
    closeCandidateMenu();
    renderMoments({ index: index, cursor: input.selectionStart || input.value.length });
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const moment = moments[index];
    const exact = findExactSound(moment.query);

    if (exact) {
      chooseMomentSound(index, exact.file);
    } else if (suggestions.length) {
      const suggestion = suggestions[Math.min(highlightedCandidateIndex, suggestions.length - 1)];
      chooseMomentSuggestion(index, suggestion.kind, suggestion.file);
    } else {
      syncMomentSelection(moment);
    }

    closeCandidateMenu();
    renderMoments({ index: index, cursor: (moments[index].query || '').length });
  }
}

function renderSounds(filter) {
  const list = document.getElementById('sound-list');
  const filtered = rankSounds(filter, String(filter || '').trim() ? 60 : sounds.length);

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No sounds matched that search.</div>';
    return;
  }

  list.innerHTML = filtered.map(function (sound) {
    return '<div class="sound-item" data-file="' + escapeHtml(sound.file) + '">' +
      '<button class="play-btn" data-file="' + escapeHtml(sound.file) + '" title="Play">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
      '<div class="sound-main">' +
      '<div class="sound-name">' + escapeHtml(sound.name) + '</div>' +
      '<div class="sound-file">' + escapeHtml(sound.file) + '</div>' +
      '</div>' +
      (sound.source ? '<span class="sound-source">' + escapeHtml(sound.source) + '</span>' : '') +
      '</div>';
  }).join('');

  list.querySelectorAll('.play-btn').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      playSound(button.dataset.file, button);
    });
  });
}

function renderMoments(focusState) {
  const list = document.getElementById('moment-list');

  list.innerHTML = moments.map(function (moment, index) {
    const effectiveSound = getEffectiveSound(moment);
    const effectiveMeta = effectiveSound ? getSoundByFile(effectiveSound) : null;
    const suggestions = openMenuIndex === index ? getMomentSuggestions(moment) : [];
    const meta = describeMoment(moment);
    const metaMarkup = meta ? escapeHtml(meta) : '&nbsp;';
    const badge = getMomentBadgeLabel(moment);
    const showBadge = Boolean(moment.error || !effectiveSound);
    const menuClass = 'candidate-menu';

    return '<article class="moment-item' + (moment.error ? ' invalid' : '') + (openMenuIndex === index ? ' menu-open' : '') + '" data-id="' + escapeHtml(moment.id) + '">' +
      '<div class="moment-top">' +
      '<div class="moment-title-row">' +
      '<div class="moment-label">' + escapeHtml(moment.label) + '</div>' +
      (showBadge ? '<div class="moment-badge' + (moment.error ? ' invalid' : '') + '">' + escapeHtml(badge) + '</div>' : '') +
      '</div>' +
      '<div class="moment-desc">' + escapeHtml(moment.description) + '</div>' +
      '</div>' +
      '<div class="moment-input-wrap">' +
      '<input class="moment-input' + (moment.error ? ' invalid' : '') + '" data-index="' + index + '" type="text" value="' + escapeHtml(moment.query || '') + '" placeholder="Type a sound or music cue">' +
      '<button class="preview-btn moment-preview-btn" data-file="' + escapeHtml(effectiveSound || '') + '" title="Preview"' + (effectiveMeta ? '' : ' disabled') + '>' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
      (openMenuIndex === index
        ? (suggestions.length
            ? '<div class="' + menuClass + '">' + suggestions.map(function (suggestion, suggestionIndex) {
                return '<div class="candidate-item' + (suggestionIndex === highlightedCandidateIndex ? ' active' : '') + '">' +
                  '<button class="candidate-select" type="button" data-index="' + index + '" data-kind="' + escapeHtml(suggestion.kind) + '" data-file="' + escapeHtml(suggestion.file) + '">' +
                    '<span class="candidate-main">' +
                    '<span class="candidate-name">' + escapeHtml(suggestion.name) + '</span>' +
                    (suggestion.source ? '<span class="candidate-source">' + escapeHtml(suggestion.source) + '</span>' : '') +
                    '</span>' +
                  '</button>' +
                  '<button class="preview-btn candidate-preview-btn" type="button" data-file="' + escapeHtml(suggestion.file) + '" title="Play candidate"' + (suggestion.file ? '' : ' disabled') + '>' +
                    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
                  '</button>' +
                  '</div>';
              }).join('') + '</div>'
            : '<div class="' + menuClass + ' empty">No matching sounds.</div>')
        : '') +
      '</div>' +
      '<div class="moment-meta' + (moment.error ? ' invalid' : '') + '">' + metaMarkup + '</div>' +
      '</article>';
  }).join('');

  list.querySelectorAll('.moment-input').forEach(function (input) {
    input.addEventListener('focus', function () {
      const index = Number(input.dataset.index);
      openCandidateMenu(index, input);
      renderMoments({ index: index, cursor: input.selectionStart || input.value.length });
    });
    input.addEventListener('input', function () {
      const index = Number(input.dataset.index);
      const cursor = input.selectionStart || input.value.length;
      setMomentQuery(index, input.value);
      openCandidateMenu(index, input);
      renderMoments({ index: index, cursor: cursor });
    });
    input.addEventListener('keydown', function (event) {
      handleMomentKeydown(event, Number(input.dataset.index), input);
    });
  });

  list.querySelectorAll('.candidate-select').forEach(function (button) {
    button.addEventListener('mousedown', function (event) {
      event.preventDefault();
      chooseMomentSuggestion(Number(button.dataset.index), button.dataset.kind, button.dataset.file);
      closeCandidateMenu();
      renderMoments();
    });
  });

  list.querySelectorAll('.candidate-preview-btn').forEach(function (button) {
    button.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      playSound(button.dataset.file, button);
    });
  });

  list.querySelectorAll('.moment-preview-btn').forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.dataset.file && !button.disabled) playSound(button.dataset.file, button);
    });
  });

  if (focusState) {
    const input = list.querySelector('.moment-input[data-index="' + focusState.index + '"]');
    if (input) {
      input.focus();
      const caret = Math.min(focusState.cursor, input.value.length);
      input.setSelectionRange(caret, caret);
    }
  }

  updateSaveButtonState();
}

function refreshConfigState(configData) {
  configPath = configData.configPath;
  resolvedConfigPath = configData.resolvedConfigPath;
  loadedMomentState = serializeMomentStateFromSnapshot(configData.moments);
  moments = configData.moments.map(hydrateMoment);
  closeCandidateMenu();
  document.getElementById('config-path').value = configPath;
  updateConfigPathHelp();
  renderMoments();
}

async function init() {
  bindLayoutTuningPanel();
  const responses = await Promise.all([
    fetch('/api/sounds').then(function (response) { return response.json(); }),
    fetch('/api/config').then(function (response) { return response.json(); })
  ]);

  sounds = responses[0].sounds;
  rebuildSoundNameCounts();
  document.getElementById('sound-count').textContent = sounds.length;
  refreshConfigState(responses[1]);
  renderSounds(libraryQuery);
  setActiveTab('moments');
}

document.querySelectorAll('.tab-btn').forEach(function (button) {
  button.addEventListener('click', function () {
    setActiveTab(button.dataset.tab);
  });
});

document.getElementById('search').addEventListener('input', function (event) {
  libraryQuery = event.target.value;
  renderSounds(libraryQuery);
});

document.getElementById('open-config').addEventListener('click', async function () {
  const button = document.getElementById('open-config');
  const status = document.getElementById('status');
  button.disabled = true;

  try {
    const response = await fetch('/api/config/open', { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());

    const refreshed = await fetch('/api/config').then(function (res) { return res.json(); });
    refreshConfigState(refreshed);
    status.textContent = 'Opened the configuration file.';
    status.className = 'status success';
  } catch (error) {
    status.textContent = 'Error: ' + error.message;
    status.className = 'status error';
  }

  button.disabled = false;
  setTimeout(function () {
    status.textContent = '';
    status.className = 'status';
  }, 5000);
});

document.getElementById('doctor-config').addEventListener('click', async function () {
  const button = document.getElementById('doctor-config');
  const status = document.getElementById('status');
  button.disabled = true;

  try {
    const response = await fetch('/api/config/doctor', { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());

    const refreshed = await fetch('/api/config').then(function (res) { return res.json(); });
    refreshConfigState(refreshed);
    status.textContent = 'Repaired the configuration file schema.';
    status.className = 'status success';
  } catch (error) {
    status.textContent = 'Error: ' + error.message;
    status.className = 'status error';
  }

  button.disabled = false;
  setTimeout(function () {
    status.textContent = '';
    status.className = 'status';
  }, 5000);
});

document.getElementById('reset').addEventListener('click', async function () {
  const button = document.getElementById('reset');
  const status = document.getElementById('status');
  button.disabled = true;

  try {
    const refreshed = await fetch('/api/config').then(function (res) { return res.json(); });
    refreshConfigState(refreshed);
    status.textContent = 'Reset to the current saved configuration.';
    status.className = 'status success';
  } catch (error) {
    status.textContent = 'Error: ' + error.message;
    status.className = 'status error';
  }

  button.disabled = false;
  setTimeout(function () {
    status.textContent = '';
    status.className = 'status';
  }, 5000);
});

document.addEventListener('click', function (event) {
  const target = event.target;
  if (openMenuIndex === null) return;
  if (target.closest('.moment-input-wrap')) return;
  closeCandidateMenu();
  renderMoments();
});

document.getElementById('save').addEventListener('click', async function () {
  const button = document.getElementById('save');
  const status = document.getElementById('status');
  if (button.disabled) return;
  button.disabled = true;

  const payload = {
    configPath: (document.getElementById('config-path').value || '').trim() || '~/.config/zelda-sounds.json',
    moments: {}
  };

  try {
    moments.forEach(function (moment) {
      if (moment.mode === 'default') {
        payload.moments[moment.id] = { mode: 'default', sound: null };
        return;
      }

      const trimmed = String(moment.query || '').trim();
      if (!trimmed) {
        payload.moments[moment.id] = { mode: 'none', sound: null };
        return;
      }

      if (!moment.configuredSound) {
        throw new Error('Cannot find the sound for ' + moment.label + '.');
      }

      payload.moments[moment.id] = { mode: 'sound', sound: moment.configuredSound };
    });

    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(await response.text());

    const refreshed = await fetch('/api/config').then(function (res) { return res.json(); });
    refreshConfigState(refreshed);
    status.textContent = 'Saved. Changes take effect immediately.';
    status.className = 'status success';
  } catch (error) {
    status.textContent = 'Error: ' + error.message;
    status.className = 'status error';
  }

  button.disabled = false;
  setTimeout(function () {
    status.textContent = '';
    status.className = 'status';
  }, 5000);
});

init();
</script>
</body>
</html>`;
async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/sounds") {
    const data = JSON.stringify({ sounds: getSounds() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
    return;
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    const config = getConfigState();
    const data = JSON.stringify({
      configPath: config.configPath,
      resolvedConfigPath: config.resolvedConfigPath,
      configPathEditable: config.configPathEditable,
      moments: config.moments
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
    return;
  }
  if (url.pathname === "/api/config/open" && req.method === "POST") {
    try {
      const config = getConfigState();
      const resolvedConfigPath = ensureUserConfigFile(config.configPath);
      openFile(resolvedConfigPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resolvedConfigPath }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
    return;
  }
  if (url.pathname === "/api/config/doctor" && req.method === "POST") {
    try {
      const config = getConfigState();
      const resolvedConfigPath = doctorUserConfigFile(config.configPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resolvedConfigPath }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
    return;
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const normalized = normalizeConfigPayload(payload);
      const resolvedConfigPath = saveConfigState(normalized.configPath, normalized.storedMoments);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        configPath: normalized.configPath,
        resolvedConfigPath,
        configPathEditable: false
      }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
    return;
  }
  if (url.pathname.startsWith("/sounds/")) {
    const filename = decodeURIComponent(url.pathname.slice(8));
    const filepath = join(SOUNDS_DIR, filename);
    if (existsSync(filepath) && filename.endsWith(".mp3")) {
      const data = readFileSync(filepath);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": data.length });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const filename = decodeURIComponent(url.pathname.slice(8));
    const filepath = resolve(ASSETS_DIR, filename);
    if (!filepath.startsWith(`${ASSETS_DIR}/`) && filepath !== ASSETS_DIR) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (existsSync(filepath)) {
      const data = readFileSync(filepath);
      res.writeHead(200, { "Content-Type": getMimeType(filepath), "Content-Length": data.length });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
}
var server = createServer(handler);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && PORT !== 0) {
    console.log(`  Port ${PORT} in use, trying a random port\u2026`);
    server.listen(0, onListening);
  } else {
    throw err;
  }
});
function onListening() {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const appUrl = `http://localhost:${port}`;
  console.log(`
  Zelda Sounds Configurator`);
  console.log(`  ${appUrl}
`);
  console.log(`  Press Ctrl+C to stop
`);
  if (SHOULD_OPEN_BROWSER) openBrowser(appUrl);
}
server.listen(PORT, onListening);
