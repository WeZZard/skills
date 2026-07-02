import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "../..");
export const MARKETPLACE_PATH = join(REPO_ROOT, ".claude-plugin/marketplace.json");
export const LOCK_PATH = join(REPO_ROOT, "catalog/lock.json");
export const WEBSITE_REGISTRY_PATH = join(REPO_ROOT, "catalog/website-registry.json");
export const PLUGINS_OUTPUT_DIR = join(REPO_ROOT, "website/src/content/generated/plugins");
export const SKILLS_OUTPUT_DIR = join(REPO_ROOT, "website/src/content/generated/skills");
export const WORKFLOW_OUTPUT_DIR = join(REPO_ROOT, "website/src/content/generated/workflow");

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadMarketplace() {
  return readJson(MARKETPLACE_PATH);
}

export function saveMarketplace(marketplace) {
  writeJson(MARKETPLACE_PATH, marketplace);
}

export function loadWebsiteRegistry() {
  return readJson(WEBSITE_REGISTRY_PATH);
}

export function saveWebsiteRegistry(registry) {
  writeJson(WEBSITE_REGISTRY_PATH, registry);
}

export function loadLock() {
  if (!existsSync(LOCK_PATH)) {
    return { generatedAt: null, plugins: {} };
  }
  return readJson(LOCK_PATH);
}

export function saveLock(lock) {
  writeJson(LOCK_PATH, lock);
}

export function computeHash(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function parseArgs(argv) {
  const args = { dryRun: false, _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

export function isGitSubdirSource(source) {
  return typeof source === "object" && source !== null && source.source === "git-subdir";
}

export function isGithubSource(source) {
  return typeof source === "object" && source !== null && source.source === "github";
}

export function isRemoteGitSource(source) {
  return isGithubSource(source) || isGitSubdirSource(source);
}

export function getRemotePluginRepo(source) {
  if (isGithubSource(source)) {
    return source.repo;
  }
  if (isGitSubdirSource(source)) {
    return source.url;
  }
  return null;
}

export function getRemotePluginRef(source) {
  return source.ref ?? null;
}

export function normalizeLocalSource(source) {
  if (typeof source === "string") {
    return join(REPO_ROOT, source.replace(/^\.\//, ""));
  }
  if (isRemoteGitSource(source)) {
    return null;
  }
  throw new Error(`Unsupported plugin source: ${JSON.stringify(source)}`);
}

export function getRemoteSha(repo, tag) {
  const out = execSync(
    `git ls-remote https://github.com/${repo}.git "refs/tags/${tag}^{}" "refs/tags/${tag}"`,
    { encoding: "utf8" },
  ).trim();
  if (!out) {
    throw new Error(`Tag not found on ${repo}: ${tag}`);
  }
  const line = out.split("\n")[0];
  return line.split("\t")[0];
}

export function shallowClone(repo, tag) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-pin-"));
  try {
    execSync(`git clone --depth 1 --branch "${tag}" "https://github.com/${repo}.git" "${dir}"`, {
      stdio: "pipe",
    });
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupDir(dir) {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function discoverPluginSkills(pluginPath) {
  const skillsDir = join(pluginPath, "skills");
  if (!existsSync(skillsDir)) {
    return [];
  }
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .sort();
}

export function bumpPatch(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  parts[2] += 1;
  return parts.join(".");
}

export function findMarketplacePlugin(marketplace, name) {
  const plugin = marketplace.plugins.find((entry) => entry.name === name);
  if (!plugin) {
    throw new Error(`Plugin not found in marketplace: ${name}`);
  }
  return plugin;
}
