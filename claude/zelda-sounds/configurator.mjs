#!/usr/bin/env node

// src/server.ts
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
var __dirname = dirname(fileURLToPath(import.meta.url));
var PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__dirname, "..");
var SOUNDS_DIR = join(PLUGIN_ROOT, "sounds");
var HOOKS_JSON = join(PLUGIN_ROOT, "hooks", "hooks.json");
var MOMENTS = [
  { id: "attention-needed", label: "Attention Needed", description: "Claude is about to ask you something", event: "PreToolUse", matcher: "AskUserQuestion" },
  { id: "plan-ready", label: "Plan Ready", description: "Plan is done, awaiting your review", event: "PreToolUse", matcher: "ExitPlanMode" },
  { id: "plan-approved", label: "Plan Approved", description: "You approved the plan, execution begins", event: "PostToolUse", matcher: "ExitPlanMode" },
  { id: "task-complete", label: "Task Complete", description: "Agent finished all work", event: "Stop", matcher: null },
  { id: "error", label: "Error", description: "A tool call failed", event: "PostToolUseFailure", matcher: ".*" },
  { id: "notification", label: "Notification", description: "Claude sent a notification", event: "Notification", matcher: ".*" },
  { id: "subagent-done", label: "Subagent Done", description: "A subagent completed its work", event: "SubagentStop", matcher: ".*" },
  { id: "session-started", label: "Session Started", description: "New or resumed session", event: "SessionStart", matcher: "startup|resume" },
  { id: "plan-mode-entered", label: "Plan Mode Entered", description: "Entered planning mode", event: "PostToolUse", matcher: "EnterPlanMode" }
];
function getSounds() {
  if (!existsSync(SOUNDS_DIR)) return [];
  return readdirSync(SOUNDS_DIR).filter((f) => f.endsWith(".mp3")).sort().map((f) => ({
    name: f.replace(/\.mp3$/, "").replace(/^Zelda-(BotW|TotK)-/, "").replace(/-/g, " "),
    file: f,
    size: statSync(join(SOUNDS_DIR, f)).size,
    source: f.startsWith("Zelda-BotW") ? "BotW" : f.startsWith("Zelda-TotK") ? "TotK" : ""
  }));
}
function readHooksJson() {
  if (!existsSync(HOOKS_JSON)) return { description: "Zelda sound effects for Claude Code events", hooks: {} };
  return JSON.parse(readFileSync(HOOKS_JSON, "utf-8"));
}
function parseConfig() {
  const hooksData = readHooksJson();
  const hooks = hooksData.hooks || {};
  const config = {};
  for (const moment of MOMENTS) {
    config[moment.id] = null;
    const eventHooks = hooks[moment.event];
    if (!Array.isArray(eventHooks)) continue;
    for (const entry of eventHooks) {
      const entryMatcher = entry.matcher || null;
      if (entryMatcher === moment.matcher || moment.matcher === null && !entryMatcher) {
        const cmds = entry.hooks || [];
        for (const cmd of cmds) {
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
function buildHooksJson(config) {
  const hooks = {};
  for (const moment of MOMENTS) {
    const soundFile = config[moment.id];
    if (!soundFile) continue;
    if (!hooks[moment.event]) hooks[moment.event] = [];
    const command = `\${CLAUDE_PLUGIN_ROOT}/hooks/play-sound.sh \${CLAUDE_PLUGIN_ROOT}/sounds/${soundFile}`;
    const entry = { hooks: [{ type: "command", command }] };
    if (moment.matcher !== null) entry.matcher = moment.matcher;
    hooks[moment.event].push(entry);
  }
  return { description: "Zelda sound effects for Claude Code events", hooks };
}
function openBrowser(url) {
  const os = platform();
  const cmd = os === "darwin" ? `open "${url}"` : os === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
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
    --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px; --radius-full: 9999px;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.06); --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
  }
  body { font-family: 'Source Sans 3', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  h1, h2, h3 { font-family: 'Playfair Display', serif; }
  .app { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  .header { text-align: center; margin-bottom: 40px; }
  .header h1 { font-size: 2.5rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; }
  .header p { color: var(--text-muted); font-size: 1.1rem; }
  .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 24px; }
  .panel h2 { font-size: 1.3rem; font-weight: 600; margin-bottom: 4px; }
  .panel-subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 16px; }
  .search { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-md);
    font-family: inherit; font-size: 0.9rem; background: var(--earth-100); margin-bottom: 16px; outline: none; }
  .search:focus { border-color: var(--accent); }
  .sound-list { max-height: 600px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .sound-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid var(--border-subtle); border-radius: var(--radius-md); transition: all 0.15s; }
  .sound-item:hover { border-color: var(--accent); background: var(--accent-soft); }
  .sound-item.playing { border-color: var(--accent); background: var(--accent-soft); }
  .play-btn { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--accent);
    background: var(--surface); color: var(--accent); cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; }
  .play-btn:hover, .play-btn.playing { background: var(--accent); color: white; }
  .play-btn svg { width: 14px; height: 14px; }
  .sound-name { font-size: 0.88rem; font-weight: 500; flex: 1; }
  .sound-source { font-size: 0.7rem; color: var(--text-muted); background: var(--earth-100);
    padding: 2px 8px; border-radius: var(--radius-full); }
  .moment-list { display: flex; flex-direction: column; gap: 12px; }
  .moment-item { border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px 16px;
    transition: border-color 0.15s; }
  .moment-item:hover { border-color: var(--earth-300); }
  .moment-label { font-weight: 600; font-size: 0.95rem; margin-bottom: 2px; }
  .moment-desc { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 10px; }
  .moment-select { width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-md);
    font-family: inherit; font-size: 0.85rem; background: var(--earth-100); cursor: pointer; outline: none;
    appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237A6F60' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; }
  .moment-select:focus { border-color: var(--accent); }
  .moment-preview { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; }
  .preview-btn { width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid var(--secondary);
    background: var(--surface); color: var(--secondary); cursor: pointer; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; }
  .preview-btn:hover, .preview-btn.playing { background: var(--secondary); color: white; }
  .preview-btn svg { width: 10px; height: 10px; }
  .preview-name { font-size: 0.75rem; color: var(--secondary); font-weight: 500; }
  .footer { display: flex; justify-content: center; gap: 12px; margin-top: 32px; }
  .save-btn { padding: 12px 32px; background: var(--accent); color: white; border: none; border-radius: var(--radius-full);
    font-family: inherit; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.15s;
    box-shadow: var(--shadow-sm); }
  .save-btn:hover { background: var(--accent-hover); }
  .save-btn:disabled { opacity: 0.5; cursor: default; }
  .status { text-align: center; margin-top: 12px; font-size: 0.85rem; min-height: 20px; }
  .status.success { color: var(--secondary); }
  .status.error { color: #c0392b; }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1>Zelda Sounds</h1>
    <p>Configure sound effects for Claude Code events</p>
  </div>
  <div class="layout">
    <div class="panel">
      <h2>Sound Library</h2>
      <p class="panel-subtitle"><span id="sound-count">0</span> sounds available</p>
      <input type="text" class="search" id="search" placeholder="Filter sounds...">
      <div class="sound-list" id="sound-list"></div>
    </div>
    <div class="panel">
      <h2>Moments</h2>
      <p class="panel-subtitle">Assign sounds to semantic events</p>
      <div class="moment-list" id="moment-list"></div>
    </div>
  </div>
  <div class="footer">
    <button class="save-btn" id="save">Save Configuration</button>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
let sounds = [], moments = [], currentAudio = null, currentBtn = null;

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (currentBtn) { currentBtn.classList.remove('playing'); currentBtn.closest('.sound-item')?.classList.remove('playing'); currentBtn = null; }
  document.querySelectorAll('.preview-btn.playing').forEach(b => b.classList.remove('playing'));
}

function playSound(file, btn) {
  if (currentAudio && currentBtn === btn) { stopAudio(); return; }
  stopAudio();
  currentAudio = new Audio('/sounds/' + file);
  currentBtn = btn;
  btn.classList.add('playing');
  btn.closest('.sound-item')?.classList.add('playing');
  currentAudio.addEventListener('ended', stopAudio);
  currentAudio.play();
}

async function init() {
  const [soundsRes, configRes] = await Promise.all([
    fetch('/api/sounds').then(r => r.json()),
    fetch('/api/config').then(r => r.json())
  ]);
  sounds = soundsRes.sounds;
  moments = configRes.moments;
  document.getElementById('sound-count').textContent = sounds.length;
  renderSounds();
  renderMoments();
}

function renderSounds(filter = '') {
  const list = document.getElementById('sound-list');
  const filtered = sounds.filter(s =>
    s.name.toLowerCase().includes(filter.toLowerCase()) || s.file.toLowerCase().includes(filter.toLowerCase())
  );
  list.innerHTML = filtered.map(s => '<div class="sound-item" data-file="' + s.file + '">' +
    '<button class="play-btn" data-file="' + s.file + '" title="Play">' +
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
    '<span class="sound-name">' + s.name + '</span>' +
    (s.source ? '<span class="sound-source">' + s.source + '</span>' : '') +
    '</div>').join('');
  list.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); playSound(btn.dataset.file, btn); });
  });
}

function renderMoments() {
  const list = document.getElementById('moment-list');
  list.innerHTML = moments.map((m, i) => {
    const opts = sounds.map(s => '<option value="' + s.file + '"' + (s.file === m.sound ? ' selected' : '') + '>' + s.name + ' (' + s.source + ')</option>').join('');
    const snd = m.sound ? sounds.find(s => s.file === m.sound) : null;
    return '<div class="moment-item" data-id="' + m.id + '">' +
      '<div class="moment-label">' + m.label + '</div>' +
      '<div class="moment-desc">' + m.description + '</div>' +
      '<select class="moment-select" data-index="' + i + '"><option value="">None</option>' + opts + '</select>' +
      '<div class="moment-preview" data-index="' + i + '" style="display:' + (m.sound ? 'inline-flex' : 'none') + '">' +
      '<button class="preview-btn" data-file="' + (m.sound || '') + '" title="Preview">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>' +
      '<span class="preview-name">' + (snd ? snd.name : '') + '</span></div></div>';
  }).join('');

  list.querySelectorAll('.moment-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = parseInt(sel.dataset.index);
      moments[i].sound = sel.value || null;
      const preview = sel.parentElement.querySelector('.moment-preview');
      if (sel.value) {
        const s = sounds.find(s => s.file === sel.value);
        preview.style.display = 'inline-flex';
        preview.querySelector('.preview-btn').dataset.file = sel.value;
        preview.querySelector('.preview-name').textContent = s?.name || '';
      } else { preview.style.display = 'none'; }
    });
  });
  list.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.file) playSound(btn.dataset.file, btn); });
  });
}

document.getElementById('search').addEventListener('input', e => renderSounds(e.target.value));

document.getElementById('save').addEventListener('click', async () => {
  const btn = document.getElementById('save');
  const status = document.getElementById('status');
  btn.disabled = true;
  const payload = {};
  moments.forEach(m => { payload[m.id] = m.sound || null; });
  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      status.textContent = 'Saved! Run /reload-plugins in Claude Code to apply.';
      status.className = 'status success';
    } else throw new Error(await res.text());
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.className = 'status error';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 5000);
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
    const config = parseConfig();
    const data = JSON.stringify({
      moments: MOMENTS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        sound: config[m.id] || null
      }))
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
    return;
  }
  if (url.pathname === "/api/config" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const hooksJson = buildHooksJson(payload);
      writeFileSync(HOOKS_JSON, JSON.stringify(hooksJson, null, 2) + "\n");
      res.writeHead(200);
      res.end("OK");
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
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
}
var server = createServer(handler);
server.listen(0, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const appUrl = `http://localhost:${port}`;
  console.log(`
  Zelda Sounds Configurator`);
  console.log(`  ${appUrl}
`);
  console.log(`  Press Ctrl+C to stop
`);
  openBrowser(appUrl);
});
