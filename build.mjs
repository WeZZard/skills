#!/usr/bin/env node
// Generator for the zelda-sounds multi-agent distributions.
//
// Single canonical source:  plugins/zelda-sounds/
// Generated distributions:   claude/zelda-sounds/   (this task)
//                            opencode/zelda-sounds/ (a later task)
//
// Determinism contract: no timestamps, stable key order, stable formatting.
// Running this script twice MUST yield byte-identical output trees.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "plugins", "zelda-sounds");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Pretty-print JSON the way the committed Claude tree does: 2-space indent and a
// trailing newline.
function jsonFile(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function writeText(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

// Copy a file or directory tree byte-for-byte, preserving mode bits (so the
// executable bit on play-sound.sh survives).
function copyInto(srcPath, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(srcPath, destPath, { recursive: true, preserveTimestamps: true });
}

// ---------------------------------------------------------------------------
// Claude emitter
// ---------------------------------------------------------------------------

// The committed config/defaults.json preserves the historical key order of the
// old configurator's DEFAULT_MOMENT_SOUNDS object (non-null moments first, in
// their hand-authored order, then the null moments). moments.json owns the
// VALUES; this constant owns the ORDER, so the regenerated file stays
// byte-identical to today's committed tree.
const DEFAULTS_KEY_ORDER = [
  "attention-needed",
  "plan-ready",
  "plan-approved",
  "task-complete",
  "error",
  "notification",
  "subagent-done",
  "session-started",
  "plan-mode-entered",
];

const DEFAULTS_DESCRIPTION = "Packaged default sound mapping for Zelda Sounds";

// Build .claude-plugin/plugin.json from manifest.json. The committed file orders
// keys name, description, version.
function buildPluginJson(manifest) {
  return jsonFile({
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
  });
}

// Build config/defaults.json from moments.json. Description is fixed; the
// moment map is keyed in DEFAULTS_KEY_ORDER with values drawn from moments.json.
function buildDefaultsJson(moments) {
  const byId = new Map(moments.map((m) => [m.id, m]));
  const map = {};
  for (const id of DEFAULTS_KEY_ORDER) {
    const moment = byId.get(id);
    map[id] = moment ? (moment.default ?? null) : null;
  }
  return jsonFile({ description: DEFAULTS_DESCRIPTION, moments: map });
}

// Compile hooks/hooks.json from bindings/claude.json + moments.json.
//
// Moments are grouped by Claude event; within an event they keep moments.json
// array order. Each moment becomes one hook-group running the player with the
// moment id. A non-null matcher is emitted as a "matcher" key; a null matcher
// omits the key entirely (matching today's Stop entry).
function buildHooksJson(moments, binding) {
  const hooks = {};
  for (const moment of moments) {
    const bind = binding.moments[moment.id];
    if (!bind) continue;
    const group = {
      hooks: [
        {
          type: "command",
          command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/play-configured-sound.mjs" "${moment.id}"`,
        },
      ],
    };
    if (bind.matcher !== null && bind.matcher !== undefined) {
      group.matcher = bind.matcher;
    }
    (hooks[bind.event] ??= []).push(group);
  }
  return jsonFile({ description: binding.description, hooks });
}

// Bundle the refactored configurator/src/server.ts into configurator.mjs using
// the exact esbuild flags recorded in the configurator's package.json build
// script. esbuild output is deterministic (no timestamps), so a second build
// yields identical bytes.
//
// `tool` ("claude" or "opencode") is baked in at bundle time via esbuild
// `define` so the bundle contains no runtime `process.env.ZELDA_TOOL` lookup.
async function bundleConfigurator(outFile, tool) {
  await esbuild({
    entryPoints: [join(SRC, "configurator", "src", "server.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    outfile: outFile,
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "warning",
    define: { "process.env.ZELDA_TOOL": JSON.stringify(tool) },
  });
}

async function buildClaude(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const manifest = readJson(join(SRC, "manifest.json"));
  const moments = readJson(join(SRC, "moments.json")).moments;
  const claudeBinding = readJson(join(SRC, "bindings", "claude.json"));

  // Derived JSON artifacts.
  writeText(join(outDir, ".claude-plugin", "plugin.json"), buildPluginJson(manifest));
  writeText(join(outDir, "hooks", "hooks.json"), buildHooksJson(moments, claudeBinding));
  writeText(join(outDir, "config", "defaults.json"), buildDefaultsJson(moments));

  // Player → hooks/ (byte-identical copies; preserves play-sound.sh exec bit).
  copyInto(join(SRC, "player", "play-configured-sound.mjs"), join(outDir, "hooks", "play-configured-sound.mjs"));
  copyInto(join(SRC, "player", "play-sound.sh"), join(outDir, "hooks", "play-sound.sh"));

  // Config (copied as-is).
  copyInto(join(SRC, "config", "settings.json"), join(outDir, "config", "settings.json"));
  copyInto(join(SRC, "config", "user-config.json"), join(outDir, "config", "user-config.json"));

  // Static payload copied verbatim.
  copyInto(join(SRC, "sounds"), join(outDir, "sounds"));
  copyInto(join(SRC, "assets"), join(outDir, "assets"));
  copyInto(join(SRC, "skills"), join(outDir, "skills"));
  copyInto(join(SRC, ".gitignore"), join(outDir, ".gitignore"));

  // Website descriptors, re-dotted so the website build can scan claude/*/website.*.toml.
  for (const name of ["plugin", "philosophy", "skills"]) {
    copyInto(join(SRC, "website", `${name}.toml`), join(outDir, `website.${name}.toml`));
  }

  // Authoring assets land at the top level as tools/ and manifests/ to match today.
  copyInto(join(SRC, "authoring", "tools"), join(outDir, "tools"));
  copyInto(join(SRC, "authoring", "manifests"), join(outDir, "manifests"));

  // Configurator: copy sources, then emit the deterministic esbuild bundle.
  copyInto(join(SRC, "configurator", "package.json"), join(outDir, "configurator", "package.json"));
  copyInto(join(SRC, "configurator", "package-lock.json"), join(outDir, "configurator", "package-lock.json"));
  copyInto(join(SRC, "configurator", "src", "server.ts"), join(outDir, "configurator", "src", "server.ts"));
  await bundleConfigurator(join(outDir, "configurator.mjs"), "claude");
}

// ---------------------------------------------------------------------------
// OpenCode emitter
// ---------------------------------------------------------------------------

// Generate plugin/zelda-sounds.ts from bindings/opencode.json.
//
// The OpenCode loader scans {plugin,plugins}/*.{ts,js} and calls the default
// export with a PluginInput, expecting a Hooks object back. We return one
// `event` hook that dispatches on `event.type` and spawns the bundled player
// (../hooks/play-configured-sound.mjs, byte-identical to the Claude player) with
// the moment id, detached so the event loop never blocks.
//
// The generator is fully data-driven from the binding:
//   - each kind:"event" moment with a unique event.type becomes a plain branch;
//   - an event.type bound by >1 moment (only session.idle today) becomes a
//     disambiguating branch: a child session (parentID set, via client.session.get)
//     -> subagent-done; a root session whose just-finished turn ran in the `plan`
//     agent (read from the last assistant message via client.session.messages)
//     -> plan-ready; any other root session -> task-complete;
//   - kind:"dropped" moments emit no branch, so they invoke nothing, and any
//     unmapped event.type falls through silently.
function buildOpenCodePlugin(binding) {
  // Preserve binding declaration order for deterministic output.
  const eventMoments = Object.entries(binding.moments)
    .filter(([, b]) => b.kind === "event")
    .map(([id, b]) => ({
      id,
      type: b.type,
      scope: b.scope ?? null,
      agent: b.agent ?? null,
    }));

  // Group moments by event.type, preserving first-seen order.
  const byType = new Map();
  for (const m of eventMoments) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type).push(m);
  }

  // We emit an if/else chain rather than a `switch (event.type)` for two reasons:
  //   1. Some bound event.type values (e.g. "question.asked") are not declared in
  //      this @opencode-ai/sdk version's Event union; a `case` on such a literal
  //      fails `tsc` (TS2678). Comparing the widened `eventType: string` against
  //      a string literal always type-checks, so the binding stays faithful even
  //      when the SDK lags the design's event vocabulary.
  //   2. For event.type values that ARE in the union (e.g. "session.idle"), a
  //      `event.type === "session.idle"` guard narrows `event` to the matching
  //      member, so reading `event.properties.sessionID` type-checks.
  let needChild = false;
  let needAgent = false;
  let needRejectGuard = false;
  const hasQuestionAsked = eventMoments.some((m) => m.type === "question.asked");
  const branches = [];
  for (const [type, moments] of byType) {
    const typeLit = JSON.stringify(type);
    if (moments.length === 1 && !moments[0].scope && !moments[0].agent) {
      // Unique, unqualified mapping: event.type → moment id. No payload access
      // needed, so we compare the widened string.
      branches.push(
        `      if (eventType === ${typeLit}) {\n` +
          `        play(${JSON.stringify(moments[0].id)});\n` +
          `        return;\n` +
          `      }`,
      );
      continue;
    }

    // Scoped / agent-qualified event.type (only session.idle today). Disambiguate
    // by session scope (parentID) and by the agent that ran the just-finished turn:
    //   child session          → subagent-done
    //   root + agent "plan"     → plan-ready (the plan agent stopped → plan ready)
    //   root (no agent)         → task-complete
    // The `event.type === ...` guard narrows `event` so `event.properties.sessionID`
    // type-checks.
    const child = moments.find((m) => m.scope === "child");
    const rootAgentMoments = moments.filter((m) => m.scope === "root" && m.agent);
    const rootDefault = moments.find((m) => m.scope === "root" && !m.agent);
    if (!rootDefault) {
      throw new Error(
        `opencode binding: event.type "${type}" is bound by multiple moments ` +
          `but has no default (unqualified) root-scoped moment; cannot disambiguate`,
      );
    }
    const lines = [
      `      if (event.type === ${typeLit}) {`,
      `        const sessionID = event.properties.sessionID;`,
    ];
    if (hasQuestionAsked && type === "session.idle") {
      // A dismissed question fires question.rejected then session.idle; that idle
      // is not a completion, so suppress it.
      needRejectGuard = true;
      lines.push(
        `        if (rejectedSessions.has(sessionID)) {`,
        `          rejectedSessions.delete(sessionID);`,
        `          return;`,
        `        }`,
      );
    }
    if (child) {
      needChild = true;
      lines.push(
        `        if (await isChildSession(sessionID)) {`,
        `          play(${JSON.stringify(child.id)});`,
        `          return;`,
        `        }`,
      );
    }
    if (rootAgentMoments.length) {
      needAgent = true;
      lines.push(`        const lastAgent = await lastTurnAgent(sessionID);`);
      for (const m of rootAgentMoments) {
        lines.push(
          `        if (lastAgent === ${JSON.stringify(m.agent)}) {`,
          `          play(${JSON.stringify(m.id)});`,
          `          return;`,
          `        }`,
        );
      }
    }
    lines.push(
      `        play(${JSON.stringify(rootDefault.id)});`,
      `        return;`,
      `      }`,
    );
    branches.push(lines.join("\n"));
  }

  let dispatchBody = branches.join("\n");
  if (needRejectGuard) {
    // Record a rejected (dismissed) question so the following session.idle is
    // suppressed instead of mistaken for task completion / plan-ready.
    dispatchBody =
      `      if (eventType === "question.rejected") {\n` +
      `        const sid = (event as any).properties?.sessionID;\n` +
      `        if (sid) rejectedSessions.add(sid);\n` +
      `        return;\n` +
      `      }\n` +
      dispatchBody;
  }

  // Emit only the helper functions the dispatch actually references.
  const helpers = [];
  if (needChild) {
    helpers.push(
      "  // A child (subagent) session has `parentID` set; the root session does\n" +
        "  // not. session.idle carries only sessionID, so we fetch the Session.\n" +
        "  async function isChildSession(sessionID: string): Promise<boolean> {\n" +
        "    try {\n" +
        "      const res = await client.session.get({ path: { id: sessionID } });\n" +
        "      return Boolean(res.data?.parentID);\n" +
        "    } catch {\n" +
        "      // If the session can't be resolved, treat it as a root session so\n" +
        "      // the task-complete cue still fires rather than being dropped.\n" +
        "      return false;\n" +
        "    }\n" +
        "  }",
    );
  }
  if (needAgent) {
    helpers.push(
      "  // OpenCode plan mode == the read-only `plan` agent. At idle (the agent\n" +
        "  // stopped) read which agent ran the just-finished turn from its last\n" +
        "  // assistant message (`agent`/`mode`), so plan-ready fires only when the\n" +
        "  // plan agent stops. Never console.log/error here — it corrupts the TUI.\n" +
        "  async function lastTurnAgent(\n" +
        "    sessionID: string,\n" +
        "  ): Promise<string | undefined> {\n" +
        "    try {\n" +
        "      const res = await client.session.messages({ path: { id: sessionID } });\n" +
        "      const items: any[] = (res as any).data ?? [];\n" +
        "      for (let i = items.length - 1; i >= 0; i--) {\n" +
        "        const info = items[i]?.info;\n" +
        '        if (info?.role === "assistant") return info.agent ?? info.mode;\n' +
        "      }\n" +
        "    } catch {\n" +
        "      // If messages can't be read, fall through to the default cue.\n" +
        "    }\n" +
        "    return undefined;\n" +
        "  }",
    );
  }
  const helpersBlock = helpers.length ? helpers.join("\n\n") + "\n\n" : "";
  const rejectStateBlock = needRejectGuard
    ? "  // Track sessions whose most recent question was rejected (dismissed), so\n" +
      "  // the session.idle that immediately follows is suppressed rather than\n" +
      "  // mistaken for completion.\n" +
      "  const rejectedSessions = new Set<string>();\n\n"
    : "";

  // The handler is hand-written boilerplate around the generated dispatch. The
  // player is spawned via `node` (always present in a Node/Bun OpenCode host),
  // detached and unref'd so playback never blocks the bus.
  return `// GENERATED by build.mjs from plugins/zelda-sounds/bindings/opencode.json — DO NOT EDIT.
// Edit the canonical source under plugins/zelda-sounds/ and re-run \`node build.mjs\`.
//
// OpenCode plugin: plays Zelda sound cues on lifecycle events. Each bound event
// resolves the user's configured sound (from ~/.config/zelda-sounds.json or the
// packaged default) and spawns hooks/play-sound.sh directly — no Node/Bun
// runtime dependency required.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Plugin } from "@opencode-ai/plugin";

// Resolve assets relative to this plugin file (<dist>/plugin/zelda-sounds.ts), so
// the distribution root is its parent's parent. We must NOT shell out to a JS
// runtime to run the .mjs player: OpenCode runs on a compiled Bun binary, so
// process.execPath is the opencode executable (not node) and would fail. Instead
// the plugin resolves the moment's sound itself and spawns the OS-native shell
// player (hooks/play-sound.sh) directly -- no node/bun dependency.
const DIST = dirname(dirname(fileURLToPath(import.meta.url)));
const SOUNDS_DIR = join(DIST, "sounds");
const DEFAULTS_JSON = join(DIST, "config", "defaults.json");
const PLAY_SOUND_SH = join(DIST, "hooks", "play-sound.sh");
const USER_CONFIG = join(homedir(), ".config", "zelda-sounds.json");

function readMoments(file: string): Record<string, string | null> {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return (data.moments ?? {}) as Record<string, string | null>;
  } catch {
    return {};
  }
}

// Resolve the moment's sound (user override, else packaged default) and play it
// via the cross-platform shell player, detached so playback never blocks the bus.
// User config is read from the opencode section first (data.opencode.moments),
// with a legacy flat fallback (data.moments); defaults are always flat.
function play(moment: string): void {
  const defaults = readMoments(DEFAULTS_JSON);
  let userSound: string | null | undefined;
  try {
    const data = JSON.parse(readFileSync(USER_CONFIG, "utf8")) as any;
    userSound = data?.opencode?.moments?.[moment] ?? data?.moments?.[moment];
  } catch {
    // no user config — fall through to defaults
  }
  const sound = userSound !== undefined ? userSound : defaults[moment];
  if (!sound) return;
  const soundPath = join(SOUNDS_DIR, sound);
  if (!existsSync(soundPath) || !existsSync(PLAY_SOUND_SH)) return;
  const child = spawn(PLAY_SOUND_SH, [soundPath], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export const ZeldaSounds: Plugin = async ({ client }) => {
${helpersBlock}${rejectStateBlock}  return {
    event: async ({ event }) => {
      const eventType: string = event.type;
${dispatchBody}
      // Unmapped, dropped, and prompt-delivered moments invoke nothing.
    },
  };
};

export default ZeldaSounds;
`;
}

// Derive the loose OpenCode skill from the canonical SKILL.md, swapping the
// Claude-specific launch instructions (CLAUDE_PLUGIN_ROOT, marketplace layout)
// for the OpenCode distribution layout while preserving valid frontmatter.
function buildOpenCodeSkill() {
  return `---
name: configure-zelda-sounds
description: Launch the Zelda Sounds configurator GUI to assign sound effects to OpenCode lifecycle events
---

# Configure Zelda Sounds

Launch the Zelda Sounds configurator — a GUI that opens in your browser to let
you assign sound effects to OpenCode lifecycle events. Choices are saved to the
shared cross-tool config at \`~/.config/zelda-sounds.json\`.

## What to do

This skill lives at \`<dist>/skill/configure-zelda-sounds/SKILL.md\`, where \`<dist>\` is
the \`opencode/zelda-sounds/\` distribution directory you installed. Run the
bundled configurator from that distribution root with \`PORT=0\` so it picks a
free port automatically:

\`\`\`bash
PORT=0 node "<dist>/configurator.mjs"
\`\`\`

Replace \`<dist>\` with the absolute path to your \`opencode/zelda-sounds/\`
directory (the same directory referenced by your \`opencode.json\` \`"plugin"\`
entry, minus the \`plugin/zelda-sounds.ts\` suffix).

The server prints \`http://localhost:<port>\` to stdout. Tell the user the URL so
they can open it.

The configurator will:
1. Start a local web server on an available port
2. Open the default browser to the configurator UI
3. Let the user preview sounds, choose a configuration file path, and assign
   sounds to 9 semantic moments
4. Save user overrides to \`~/.config/zelda-sounds.json\` — changes take effect
   immediately, no reload needed
`;
}

// Stable, path-independent placeholder for the plugin entry in example files.
// Users must replace this with the real absolute path to their local distribution.
// Using a constant ensures byte-identical output regardless of checkout directory.
const OPENCODE_PLUGIN_ENTRY_PLACEHOLDER =
  "file:///ABSOLUTE/PATH/TO/opencode/zelda-sounds/plugin/zelda-sounds.ts";

// opencode.json.example — minimal sample showing the "plugin" entry a user adds.
// Uses a placeholder path that the user must replace with their real absolute path.
function buildOpenCodeJsonExample() {
  return jsonFile({
    $schema: "https://opencode.ai/config.json",
    plugin: [OPENCODE_PLUGIN_ENTRY_PLACEHOLDER],
  });
}

// README.md — concise install instructions for the self-contained distribution.
function buildOpenCodeReadme() {
  const pluginEntry = OPENCODE_PLUGIN_ENTRY_PLACEHOLDER;
  return `# Zelda Sounds for OpenCode

> GENERATED — edit the canonical source under \`plugins/zelda-sounds/\` and re-run
> \`node build.mjs\`. Do not hand-edit files in this directory.

Play Zelda BotW & TotK sound cues on OpenCode lifecycle events, with the same GUI
configurator the Claude Code plugin ships. This distribution is self-contained:
it bundles the sounds, the player, the configurator, and its assets.

## Install

### 1. Register the plugin

Add this distribution's plugin entry to your \`opencode.json\` (project or global,
e.g. \`~/.config/opencode/opencode.json\`). Replace the placeholder path below with
the absolute path to your local \`opencode/zelda-sounds/\` distribution directory
(also shown in \`opencode.json.example\` in this directory):

\`\`\`json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["${pluginEntry}"]
}
\`\`\`

Replace \`/ABSOLUTE/PATH/TO\` with the real absolute path where you placed this
distribution (e.g. \`/Users/yourname/path/to/opencode/zelda-sounds/plugin/zelda-sounds.ts\`).

The plugin plays a cue on these events:

| OpenCode event   | Moment            |
|------------------|-------------------|
| \`session.created\` | \`session-started\` |
| \`session.idle\` (root session)  | \`task-complete\`   |
| \`session.idle\` (child/subagent) | \`subagent-done\`   |
| \`session.idle\` (root, \`plan\` agent) | \`plan-ready\`   |
| \`question.asked\` | \`attention-needed\` |
| \`session.error\`  | \`error\`           |
| \`tui.toast.show\` | \`notification\`    |

Root vs. child \`session.idle\` is disambiguated by the session's \`parentID\`
(resolved via the OpenCode client): a child/subagent session has a parent, the
root session does not. A root \`session.idle\` plays \`plan-ready\` instead of
\`task-complete\` when the just-finished turn ran in OpenCode's read-only \`plan\`
agent (read from the last assistant message) — i.e. the plan agent stopped with a
plan ready for your review.

### 2. Install the configurator skill

Copy the loose skill folder so OpenCode can discover it (OpenCode discovers
skills as \`skill/<name>/SKILL.md\`, so copy the whole \`configure-zelda-sounds\`
folder):

\`\`\`bash
mkdir -p ~/.config/opencode/skill
cp -R skill/configure-zelda-sounds ~/.config/opencode/skill/
\`\`\`

(You can also place it under a project's \`.opencode/skill/\` directory.) Then run
the \`configure-zelda-sounds\` skill to launch the GUI and assign sounds.

## Configuration

Sound choices are shared across Claude Code and OpenCode via
\`~/.config/zelda-sounds.json\`. Assign sounds with the configurator (step 2);
unset moments fall back to the packaged defaults in \`config/defaults.json\`.
`;
}

async function buildOpenCode(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const moments = readJson(join(SRC, "moments.json")).moments;
  const opencodeBinding = readJson(join(SRC, "bindings", "opencode.json"));

  // Generated plugin entry (the OpenCode loader scans {plugin,plugins}/*.{ts,js}).
  writeText(
    join(outDir, "plugin", "zelda-sounds.ts"),
    buildOpenCodePlugin(opencodeBinding),
  );

  // Shell player → hooks/ (byte-identical copy; preserves exec bit).
  // The generated OpenCode plugin resolves the sound and spawns play-sound.sh
  // directly — no .mjs player needed in the OpenCode distribution.
  copyInto(join(SRC, "player", "play-sound.sh"), join(outDir, "hooks", "play-sound.sh"));

  // Bundled sounds + generated defaults (reuse the Claude defaults builder so the
  // format matches; the player reads PLUGIN_ROOT/config/defaults.json).
  copyInto(join(SRC, "sounds"), join(outDir, "sounds"));
  writeText(join(outDir, "config", "defaults.json"), buildDefaultsJson(moments));

  // Configurator: deterministic esbuild bundle + its assets.
  await bundleConfigurator(join(outDir, "configurator.mjs"), "opencode");
  copyInto(join(SRC, "assets"), join(outDir, "assets"));

  // Loose skill, sample config, and install docs. plan-ready is now an event
  // (root session.idle while the `plan` agent ran), so there is no AGENTS.md hack.
  // OpenCode discovers skills as <dir>/<name>/SKILL.md (a folder named after the
  // skill containing SKILL.md), NOT a flat <name>.md file — mirror the Claude side.
  writeText(
    join(outDir, "skill", "configure-zelda-sounds", "SKILL.md"),
    buildOpenCodeSkill(),
  );
  writeText(join(outDir, "opencode.json.example"), buildOpenCodeJsonExample());
  writeText(join(outDir, "README.md"), buildOpenCodeReadme());
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const EMITTERS = {
  claude: () => buildClaude(join(ROOT, "claude", "zelda-sounds")),
  opencode: () => buildOpenCode(join(ROOT, "opencode", "zelda-sounds")),
};

async function main() {
  // Default to all currently-implemented emitters; allow selecting one by name.
  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : Object.keys(EMITTERS);
  for (const target of targets) {
    const emit = EMITTERS[target];
    if (!emit) {
      throw new Error(`Unknown build target: ${target}`);
    }
    await emit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
