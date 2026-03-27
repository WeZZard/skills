#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TMP_DIR = join(ROOT, "tmp");
const TOOLS_DIR = join(ROOT, "tools");
const MANIFESTS_DIR = join(ROOT, "manifests");
const SOURCE_VIDEO = join(TMP_DIR, "source-video.mp4");
const FULL_AUDIO = join(TMP_DIR, "full-audio.wav");
const SILENCE_LOG = join(TMP_DIR, "silence_log.txt");
const SEGMENTS_JSON = join(TMP_DIR, "segments.json");
const FRAMES_DIR = join(TMP_DIR, "frames");
const REPORT_JSON = join(TMP_DIR, "rebuild-report.json");
const OCR_SOURCE = join(TOOLS_DIR, "ocr-frame.swift");
const OCR_BINARY = join(TMP_DIR, "ocr-frame");
const SOUNDS_DIR = join(ROOT, "sounds");
const DEFAULT_OUTPUT_DIR = join(TMP_DIR, "rebuilt-sounds");
const DEFAULT_URL = "https://www.youtube.com/watch?v=OGX-VFEutfQ";
const SAMPLE_FRACTIONS = [0.08, 0.18, 0.32, 0.5, 0.68];
const MIN_SIGNIFICANT_SILENCE = 1.5;
const FIXED_SILENCE_THRESHOLD_DB = -35;
const DEFAULT_TAIL_PADDING_SECONDS = 0.45;
const DEFAULT_MANIFEST_START_TOLERANCE_SECONDS = 1.0;
const DEFAULT_MANIFEST_END_TOLERANCE_SECONDS = 1.0;
const DEFAULT_MIN_CLIP_DURATION_SECONDS = 0.1;
const DEFAULT_MAX_MANIFEST_CLIP_DURATION_SECONDS = 300;
const DEFAULT_MAX_SILENCE_CLIP_DURATION_SECONDS = 60;
const SILENCE_PERCENTILE_TARGET = 0.01;
const SILENCE_PERCENTILE_LADDER = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5];
const CANONICAL_TITLES = [
  "New-Item-Collected",
  "Important-Item-Collected",
  "Historic-Item-Collected",
  "Heart-And-Stamina",
  "Corrupted-Sword",
  "Puzzle-Solved",
  "Cooking",
  "Cooking-Amator",
  "Cooking-Fail",
  "Cooking-Experience",
  "Monster-Object-Cooking",
  "Monster-Objects-Became-Delicious",
  "Monster-Objects-Became-Not-Good",
  "Supreme-Cooking",
  "New-Cook",
  "New-Cook-Discovered",
  "After-Sleeping",
  "After-Sleeping-In-A-Great-Bed",
  "Wake-Up-In-The-Middle-Of-The-Night",
  "In-The-Miasma-Hole",
  "Great-Fairy",
  "Da-Da-Da",
  "Korok-Found",
  "Hestu-Jingle",
  "Floating-Castle",
  "Game-Over",
  "A-New-Power",
  "Arrival-In-The-Kingdom",
  "New-Location-Discovered",
  "Location",
  "Entry-Into-The-Depths",
  "Lightroot-Discovered",
  "Darker-Location",
  "Abandoned-Ruins",
  "Lightroot",
  "Teleportation",
  "Fi-Is-Always-Among-Us",
  "Interacting",
  "Yaaha",
  "New-Objective",
  "Shrine-In-Proximity",
  "Item-Get",
  "Sky-Diving",
  "Chasm-Diving",
];
const CURRENT_LIBRARY_ALIASES = new Map([
  ["Cooking-Amator", "Zelda-TotK-Cooking-Amateur.mp3"],
  ["Fi-Is-Always-Among-Us", "Zelda-TotK-Fis-Always-Among-Us.mp3"],
  ["Heart-And-Stamina", "Zelda-TotK-Heart-And-Stamina-Up.mp3"],
  ["Supreme-Cooking", "Zelda-TotK-Superb-Cooking.mp3"],
]);

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    output: DEFAULT_OUTPUT_DIR,
    publish: false,
    redownload: false,
    segmentSource: "auto",
    silenceMode: "fixed",
    tailPadding: DEFAULT_TAIL_PADDING_SECONDS,
    manifestStartTolerance: DEFAULT_MANIFEST_START_TOLERANCE_SECONDS,
    manifestEndTolerance: DEFAULT_MANIFEST_END_TOLERANCE_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--publish") {
      options.publish = true;
      continue;
    }

    if (arg === "--redownload") {
      options.redownload = true;
      continue;
    }

    if (arg === "--segment-source") {
      index += 1;
      options.segmentSource = argv[index];
      continue;
    }

    if (arg === "--silence-mode") {
      index += 1;
      options.silenceMode = argv[index];
      continue;
    }

    if (arg === "--tail-padding") {
      index += 1;
      options.tailPadding = Number(argv[index]);
      continue;
    }

    if (arg === "--manifest-start-tolerance") {
      index += 1;
      options.manifestStartTolerance = Number(argv[index]);
      continue;
    }

    if (arg === "--manifest-end-tolerance") {
      index += 1;
      options.manifestEndTolerance = Number(argv[index]);
      continue;
    }

    if (arg === "--output") {
      index += 1;
      options.output = resolve(argv[index]);
      continue;
    }

    if (arg === "--url") {
      index += 1;
      options.url = argv[index];
      continue;
    }

    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      options.url = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      [`${command} ${args.join(" ")}`]
        .concat(stderr ? [`stderr: ${stderr}`] : [])
        .concat(stdout ? [`stdout: ${stdout}`] : [])
        .join("\n"),
    );
  }

  return result;
}

function ensureCommand(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Required command not found: ${command}`);
  }
}

function ensureDirectories() {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
}

function compileOCRBinary() {
  const needsCompile =
    !existsSync(OCR_BINARY) ||
    statSync(OCR_BINARY).mtimeMs < statSync(OCR_SOURCE).mtimeMs;

  if (!needsCompile) return;

  run("swiftc", [OCR_SOURCE, "-o", OCR_BINARY]);
}

function sanitizeForFilename(value) {
  return value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function inferVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.replace(/^\//, "") || null;
    }
    if (parsed.hostname.includes("youtube.com")) {
      return parsed.searchParams.get("v");
    }
  } catch {
    return null;
  }
  return null;
}

function loadManifestByVideoId(videoId) {
  if (!videoId) return null;

  const path = manifestPathForVideo(videoId);
  if (!existsSync(path)) return null;

  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.videoId !== videoId) {
    throw new Error(`Manifest video id mismatch in ${path}`);
  }

  return { path, manifest };
}

function inspectSource(url) {
  const inferredId = inferVideoId(url);
  const manifestSelection = loadManifestByVideoId(inferredId);

  if (existsSync(SOURCE_VIDEO) && manifestSelection) {
    return {
      id: manifestSelection.manifest.videoId,
      title: manifestSelection.manifest.title,
      duration: probeDuration(SOURCE_VIDEO),
      url,
    };
  }

  try {
    const result = run(
      "yt-dlp",
      [
        "--skip-download",
        "--print",
        "%(id)s\t%(title)s\t%(duration)s",
        url,
      ],
      { capture: true },
    );
    const [id, title, duration] = result.stdout.trim().split("\t");
    return {
      id,
      title,
      duration: Number(duration),
      url,
    };
  } catch (error) {
    if (existsSync(SOURCE_VIDEO) && inferredId) {
      return {
        id: inferredId,
        title: manifestSelection?.manifest.title || inferredId,
        duration: probeDuration(SOURCE_VIDEO),
        url,
      };
    }
    throw error;
  }
}

function downloadVideo(url, redownload) {
  if (redownload) {
    rmSync(SOURCE_VIDEO, { force: true });
  }

  if (existsSync(SOURCE_VIDEO)) {
    return;
  }

  run("yt-dlp", [
    "--no-progress",
    "--no-part",
    "--merge-output-format",
    "mp4",
    "--output",
    join(TMP_DIR, "source-video.%(ext)s"),
    url,
  ]);

  if (!existsSync(SOURCE_VIDEO)) {
    throw new Error(`yt-dlp did not produce ${SOURCE_VIDEO}`);
  }
}

function extractAudio() {
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    SOURCE_VIDEO,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "44100",
    FULL_AUDIO,
  ]);
}

function probeDuration(path) {
  return Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      path,
    ], { encoding: "utf8" }).trim(),
  );
}

function findWavDataOffset(buffer) {
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return {
        offset: offset + 8,
        size: chunkSize,
      };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  throw new Error("WAV data chunk not found");
}

function magnitudeToDb(magnitude) {
  if (magnitude <= 0) return -120;
  return 20 * Math.log10(magnitude / 32768);
}

function buildSampleHistogram(path) {
  const buffer = readFileSync(path);
  const { offset, size } = findWavDataOffset(buffer);
  const totalSamples = Math.floor(size / 2);
  const histogram = new Uint32Array(32769);

  for (let index = 0; index < totalSamples; index += 1) {
    const sample = Math.abs(buffer.readInt16LE(offset + index * 2));
    histogram[sample] += 1;
  }

  let nonZeroSamples = 0;
  for (let magnitude = 1; magnitude < histogram.length; magnitude += 1) {
    nonZeroSamples += histogram[magnitude];
  }

  return {
    histogram,
    totalSamples,
    zeroSamples: histogram[0],
    nonZeroSamples,
  };
}

function magnitudeAtPercentile(histogram, sampleCount, percentile, includeZero = false) {
  if (sampleCount <= 0) return 0;

  const target = Math.max(1, Math.ceil(sampleCount * percentile));
  let seen = 0;

  for (let magnitude = includeZero ? 0 : 1; magnitude < histogram.length; magnitude += 1) {
    seen += histogram[magnitude];
    if (seen >= target) return magnitude;
  }

  return histogram.length - 1;
}

function runSilenceDetect(thresholdDb) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      FULL_AUDIO,
      "-af",
      `silencedetect=n=${thresholdDb.toFixed(2)}dB:d=${MIN_SIGNIFICANT_SILENCE}`,
      "-f",
      "null",
      "-",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  const log = result.stderr || "";

  if (result.status !== 0) {
    throw new Error("ffmpeg silencedetect failed");
  }

  return log;
}

function countDetectedSilences(log) {
  return (log.match(/silence_start/g) || []).length;
}

function parseSilences(log) {
  const silences = [];
  let currentStart = null;

  for (const line of log.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);

    if (startMatch) {
      currentStart = Number(startMatch[1]);
    }

    if (endMatch && currentStart !== null) {
      silences.push({
        start: Number(currentStart.toFixed(3)),
        end: Number(Number(endMatch[1]).toFixed(3)),
        duration: Number(Number(endMatch[2]).toFixed(3)),
      });
      currentStart = null;
    }
  }

  return silences;
}

function manifestPathForVideo(videoId) {
  return join(MANIFESTS_DIR, `${videoId}.json`);
}

function loadManifestForSource(source) {
  return loadManifestByVideoId(source.id);
}

function deriveSilenceThreshold() {
  const stats = buildSampleHistogram(FULL_AUDIO);
  const exactMagnitude = magnitudeAtPercentile(
    stats.histogram,
    stats.totalSamples,
    SILENCE_PERCENTILE_TARGET,
    true,
  );
  const exactNonZeroMagnitude = magnitudeAtPercentile(
    stats.histogram,
    stats.nonZeroSamples,
    SILENCE_PERCENTILE_TARGET,
    false,
  );

  const minimumRequiredSilences = CANONICAL_TITLES.length;
  const candidates = [];
  let selected = null;

  for (const percentile of SILENCE_PERCENTILE_LADDER) {
    const magnitude = magnitudeAtPercentile(
      stats.histogram,
      stats.nonZeroSamples,
      percentile,
      false,
    );
    const thresholdDb = magnitudeToDb(magnitude);
    const log = runSilenceDetect(thresholdDb);
    const detectedSilences = countDetectedSilences(log);
    const candidate = {
      percentile,
      magnitude,
      thresholdDb: Number(thresholdDb.toFixed(2)),
      detectedSilences,
      log,
    };
    candidates.push(candidate);

    if (!selected && detectedSilences >= minimumRequiredSilences) {
      selected = candidate;
    }
  }

  if (!selected) {
    selected = candidates[candidates.length - 1];
  }

  return {
    mode: "percentile",
    stats: {
      totalSamples: stats.totalSamples,
      zeroSamples: stats.zeroSamples,
      nonZeroSamples: stats.nonZeroSamples,
      exactPercentile: {
        percentile: SILENCE_PERCENTILE_TARGET,
        includeZero: true,
        magnitude: exactMagnitude,
        thresholdDb: Number(magnitudeToDb(exactMagnitude).toFixed(2)),
      },
      nonZeroPercentile: {
        percentile: SILENCE_PERCENTILE_TARGET,
        includeZero: false,
        magnitude: exactNonZeroMagnitude,
        thresholdDb: Number(magnitudeToDb(exactNonZeroMagnitude).toFixed(2)),
      },
    },
    candidates: candidates.map((candidate) => ({
      percentile: candidate.percentile,
      magnitude: candidate.magnitude,
      thresholdDb: candidate.thresholdDb,
      detectedSilences: candidate.detectedSilences,
    })),
    selected: {
      percentile: selected.percentile,
      magnitude: selected.magnitude,
      thresholdDb: selected.thresholdDb,
      detectedSilences: selected.detectedSilences,
    },
    log: selected.log,
  };
}

function fixedSilenceThreshold() {
  const log = runSilenceDetect(FIXED_SILENCE_THRESHOLD_DB);
  return {
    mode: "fixed",
    stats: null,
    candidates: [
      {
        percentile: null,
        magnitude: null,
        thresholdDb: FIXED_SILENCE_THRESHOLD_DB,
        detectedSilences: countDetectedSilences(log),
      },
    ],
    selected: {
      percentile: null,
      magnitude: null,
      thresholdDb: FIXED_SILENCE_THRESHOLD_DB,
      detectedSilences: countDetectedSilences(log),
    },
    log,
  };
}

function nearestValue(items, selector, target) {
  let best = null;

  for (const item of items) {
    const value = selector(item);
    const distance = Math.abs(value - target);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && value > selector(best.item))
    ) {
      best = { item, distance };
    }
  }

  return best?.item || null;
}

function segmentsFromManifest(manifest, audioEnd, tailPaddingSeconds, silenceLog, options) {
  const significantSilences = parseSilences(silenceLog).filter(
    (silence) => silence.duration >= MIN_SIGNIFICANT_SILENCE,
  );

  return manifest.clips.map((clip, index) => {
    const nextClip = manifest.clips[index + 1] || null;
    const nextClipStart = nextClip ? nextClip.start : audioEnd;
    const manifestEndHint = clip.contentEnd ?? (nextClip ? nextClip.start : null);

    const startCandidates = clip.fixedStart
      ? []
      : significantSilences.filter(
          (silence) =>
            silence.end >= clip.start - options.manifestStartTolerance &&
            silence.end <= clip.start + options.manifestStartTolerance &&
            silence.end < nextClipStart,
        );
    const startBoundary = clip.fixedStart
      ? null
      : nearestValue(startCandidates, (silence) => silence.end, clip.start);
    const start = Number((startBoundary ? startBoundary.end : clip.start).toFixed(3));

    const hasExplicitEnd = clip.contentEnd != null;
    const endHint = manifestEndHint ?? audioEnd;
    const endWindowCandidates = hasExplicitEnd
      ? []
      : significantSilences.filter(
          (silence) =>
            silence.start >= Math.max(
              start + DEFAULT_MIN_CLIP_DURATION_SECONDS,
              endHint - options.manifestEndTolerance,
            ) &&
            silence.start <= Math.min(nextClipStart, endHint + options.manifestEndTolerance),
        );
    const endBoundary = hasExplicitEnd
      ? null
      : nearestValue(endWindowCandidates, (silence) => silence.start, endHint) ||
        significantSilences.find(
          (silence) =>
            silence.start >= Math.max(start + DEFAULT_MIN_CLIP_DURATION_SECONDS, endHint) &&
            silence.start < nextClipStart,
        ) ||
        null;

    const contentEnd = Number((endBoundary ? endBoundary.start : endHint).toFixed(3));
    const maxTailEnd = hasExplicitEnd ? contentEnd : endBoundary ? endBoundary.end : nextClipStart;
    const end = Math.min(contentEnd + tailPaddingSeconds, maxTailEnd, audioEnd);
    const duration = end - start;

    if (duration < 0.5 || duration > DEFAULT_MAX_MANIFEST_CLIP_DURATION_SECONDS) {
      throw new Error(`Invalid manifest duration for ${clip.title}: ${duration.toFixed(3)}s`);
    }

    return {
      index,
      start,
      contentEnd,
      end: Number(end.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      midpoint: Number((start + duration / 2).toFixed(3)),
      tailPaddingApplied: Number((end - contentEnd).toFixed(3)),
      manifestTitle: clip.title,
      manifestStartHint: clip.start,
      manifestEndHint,
    };
  });
}

function analyzeManifestSegments(segments, candidates) {
  const candidateIndex = new Map(candidates.map((candidate) => [candidate.slug, candidate]));

  return segments.map((segment) => {
    const match = candidateIndex.get(segment.manifestTitle);
    if (!match) {
      throw new Error(`Manifest title is not a known candidate: ${segment.manifestTitle}`);
    }

    return {
      ...segment,
      sampledAt: null,
      chosenFrame: null,
      rawTitleText: segment.manifestTitle.replace(/-/g, " "),
      match: { ...match, score: 1 },
    };
  });
}

function parseSegments(log, audioEnd, tailPaddingSeconds) {
  const boundaries = parseSilences(log).filter((silence) => silence.duration >= MIN_SIGNIFICANT_SILENCE);
  const segments = [];

  for (let index = 0; index < boundaries.length; index += 1) {
    const nextBoundary = boundaries[index + 1] || null;
    const start = boundaries[index].end;
    const contentEnd = nextBoundary ? nextBoundary.start : audioEnd;
    const maxTailEnd = nextBoundary ? nextBoundary.end : audioEnd;
    const end = Math.min(contentEnd + tailPaddingSeconds, maxTailEnd, audioEnd);
    const duration = end - start;

    if (duration < 0.5 || duration > DEFAULT_MAX_SILENCE_CLIP_DURATION_SECONDS) continue;

    segments.push({
      index: segments.length,
      start,
      contentEnd,
      end,
      duration: Number(duration.toFixed(3)),
      midpoint: Number((start + duration / 2).toFixed(3)),
      tailPaddingApplied: Number((end - contentEnd).toFixed(3)),
    });
  }

  writeFileSync(SEGMENTS_JSON, JSON.stringify(segments, null, 2) + "\n");
  return segments;
}

function loadCandidates() {
  return CANONICAL_TITLES.map((slug) => ({
    slug,
    filename: `Zelda-TotK-${slug}.mp3`,
    title: slug.replace(/-/g, " "),
  }));
}

function extractFrame(time, destination) {
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    SOURCE_VIDEO,
    "-ss",
    time.toFixed(3),
    "-frames:v",
    "1",
    destination,
  ]);
}

function ocrFrame(framePath) {
  const output = execFileSync(OCR_BINARY, [framePath], { encoding: "utf8" });
  return JSON.parse(output);
}

function normalizeOCRText(text) {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanObservationText(observation) {
  let text = normalizeOCRText(observation.text);

  if (!text) return "";
  if (text === "THE LEGEND OF") return "";
  if (/^TEARS.*KINGDOM$/.test(text) && observation.x < 0.5) return "";

  text = text
    .replace(/^THE LEGEND OF\s+/, "")
    .replace(/^(?:A|H)?ELDA\s*/, "")
    .replace(/^TEARS.*KINGDOM\s*/, "")
    .replace(/\b(?:A|H)?ELDA\b/g, " ")
    .replace(/\bTEARS.*KINGDOM\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= 2 && text !== "DA") return "";
  return text;
}

function extractTitleText(observations) {
  const lines = observations
    .map((observation) => ({
      ...observation,
      cleaned: cleanObservationText(observation),
    }))
    .filter((observation) =>
      observation.cleaned &&
      (observation.x > 0.45 || observation.width > 0.35 || observation.y < 0.55),
    )
    .map((observation) => observation.cleaned);

  const deduped = [];
  for (const line of lines) {
    if (!deduped.includes(line)) deduped.push(line);
  }
  return deduped.join(" ").trim();
}

function normalizeForMatch(text) {
  return normalizeOCRText(text).replace(/\s+/g, "");
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let col = 0; col < cols; col += 1) matrix[0][col] = col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function tokenSimilarity(a, b) {
  const tokensA = new Set(normalizeOCRText(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeOCRText(b).split(" ").filter(Boolean));

  if (!tokensA.size || !tokensB.size) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  return intersection / Math.max(tokensA.size, tokensB.size);
}

function scoreMatch(text, candidateTitle) {
  const normalizedText = normalizeForMatch(text);
  const normalizedCandidate = normalizeForMatch(candidateTitle);

  if (!normalizedText || !normalizedCandidate) return 0;

  const lev = 1 - (
    levenshtein(normalizedText, normalizedCandidate) /
    Math.max(normalizedText.length, normalizedCandidate.length)
  );
  const containment =
    normalizedText.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedText)
      ? Math.min(normalizedText.length, normalizedCandidate.length) /
        Math.max(normalizedText.length, normalizedCandidate.length)
      : 0;
  const token = tokenSimilarity(text, candidateTitle);

  return Number(Math.max(lev, (lev + containment + token) / 3).toFixed(4));
}

function bestCandidateFor(text, candidates) {
  if (!text) return null;

  let best = null;

  for (const candidate of candidates) {
    const score = scoreMatch(text, candidate.title);
    if (!best || score > best.score) {
      best = { ...candidate, score };
    }
  }

  return best;
}

function chooseSegmentMatch(segment, candidates) {
  const sampleDir = join(FRAMES_DIR, `.segment-${String(segment.index).padStart(3, "0")}`);
  rmSync(sampleDir, { recursive: true, force: true });
  mkdirSync(sampleDir, { recursive: true });

  let bestSample = null;

  for (const [sampleIndex, fraction] of SAMPLE_FRACTIONS.entries()) {
    const time = Math.min(
      segment.contentEnd - 0.05,
      segment.start + Math.max(0.04, (segment.contentEnd - segment.start) * fraction),
    );
    const samplePath = join(sampleDir, `sample_${sampleIndex}.png`);

    extractFrame(time, samplePath);
    const observations = ocrFrame(samplePath);
    const titleText = extractTitleText(observations);
    const match = bestCandidateFor(titleText, candidates);

    const sample = {
      fraction,
      time: Number(time.toFixed(3)),
      frame: samplePath,
      titleText,
      observations,
      match,
    };

    if (!bestSample || (match?.score || 0) > (bestSample.match?.score || 0)) {
      bestSample = sample;
    }
  }

  const chosenFrame = join(FRAMES_DIR, `frame_${String(segment.index).padStart(3, "0")}.png`);
  renameSync(bestSample.frame, chosenFrame);
  rmSync(sampleDir, { recursive: true, force: true });

  return {
    ...segment,
    chosenFrame,
    sampledAt: bestSample.time,
    rawTitleText: bestSample.titleText,
    match: bestSample.match && bestSample.match.score >= 0.33 ? bestSample.match : null,
  };
}

function extractClip(segment, destination) {
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    SOURCE_VIDEO,
    "-ss",
    segment.start.toFixed(3),
    "-t",
    segment.duration.toFixed(3),
    "-vn",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    destination,
  ]);
}

function buildCurrentLibraryIndex() {
  const index = new Map();

  for (const file of readdirSync(SOUNDS_DIR).filter((entry) => entry.startsWith("Zelda-TotK-") && entry.endsWith(".mp3"))) {
    index.set(file, {
      file,
      duration: Number(probeDuration(join(SOUNDS_DIR, file)).toFixed(3)),
    });
  }

  return index;
}

function getCurrentComparisonFile(filename, currentLibrary) {
  const slug = filename.replace(/^Zelda-TotK-/, "").replace(/\.mp3$/, "");
  if (CURRENT_LIBRARY_ALIASES.has(slug)) {
    const aliased = CURRENT_LIBRARY_ALIASES.get(slug);
    if (currentLibrary.has(aliased)) return aliased;
  }
  return filename;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!["auto", "manifest", "silence"].includes(options.segmentSource)) {
    throw new Error(`Unknown segment source: ${options.segmentSource}`);
  }
  if (!["fixed", "percentile"].includes(options.silenceMode)) {
    throw new Error(`Unknown silence mode: ${options.silenceMode}`);
  }
  if (!Number.isFinite(options.tailPadding) || options.tailPadding < 0) {
    throw new Error(`Invalid tail padding: ${options.tailPadding}`);
  }
  if (!Number.isFinite(options.manifestStartTolerance) || options.manifestStartTolerance < 0) {
    throw new Error(`Invalid manifest start tolerance: ${options.manifestStartTolerance}`);
  }
  if (!Number.isFinite(options.manifestEndTolerance) || options.manifestEndTolerance < 0) {
    throw new Error(`Invalid manifest end tolerance: ${options.manifestEndTolerance}`);
  }

  ensureCommand("yt-dlp");
  ensureCommand("ffmpeg");
  ensureCommand("ffprobe");
  ensureCommand("swiftc");
  ensureDirectories();
  compileOCRBinary();

  const source = inspectSource(options.url);
  downloadVideo(options.url, options.redownload);
  extractAudio();

  const audioEnd = probeDuration(FULL_AUDIO);
  const candidates = loadCandidates();
  const manifestSelection =
    options.segmentSource === "silence" ? null : loadManifestForSource(source);
  const shouldUseManifest =
    options.segmentSource === "manifest" ||
    (options.segmentSource === "auto" && manifestSelection !== null);

  if (options.segmentSource === "manifest" && !manifestSelection) {
    throw new Error(`No manifest available for source video ${source.id}`);
  }

  let segmentSource = null;
  let silenceThreshold = null;
  let segments = null;

  if (shouldUseManifest) {
    silenceThreshold = fixedSilenceThreshold();
    const silenceLog = silenceThreshold.log;
    segmentSource = {
      mode: "manifest",
      path: manifestSelection.path,
      videoId: manifestSelection.manifest.videoId,
      title: manifestSelection.manifest.title,
      refinedWithSilence: true,
    };
    writeFileSync(SILENCE_LOG, silenceLog);
    segments = segmentsFromManifest(
      manifestSelection.manifest,
      audioEnd,
      options.tailPadding,
      silenceLog,
      options,
    );
  } else {
    silenceThreshold =
      options.silenceMode === "percentile"
        ? deriveSilenceThreshold()
        : fixedSilenceThreshold();
    const silenceLog = silenceThreshold.log;
    writeFileSync(SILENCE_LOG, silenceLog);
    segments = parseSegments(silenceLog, audioEnd, options.tailPadding);
    segmentSource = {
      mode: "silence",
      silenceMode: silenceThreshold.mode,
    };
  }

  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const analyzed = shouldUseManifest
    ? analyzeManifestSegments(segments, candidates)
    : segments.map((segment) => chooseSegmentMatch(segment, candidates));
  const byTitle = new Map();

  for (const segment of analyzed) {
    if (!segment.match) continue;

    const existing = byTitle.get(segment.match.slug);
    if (!existing || segment.match.score > existing.match.score) {
      byTitle.set(segment.match.slug, segment);
    }
  }

  const reportSegments = analyzed.map((segment) => {
    if (!segment.match) {
      return {
        ...segment,
        skip: { reason: "unmatched" },
      };
    }

    const canonical = byTitle.get(segment.match.slug);
    if (canonical.index !== segment.index) {
      return {
        ...segment,
        skip: {
          reason: "duplicate",
          keptSegment: canonical.index,
        },
      };
    }

    return segment;
  });

  const accepted = reportSegments
    .filter((segment) => segment.match && !segment.skip)
    .sort((lhs, rhs) => lhs.index - rhs.index);

  rmSync(options.output, { recursive: true, force: true });
  mkdirSync(options.output, { recursive: true });

  for (const segment of accepted) {
    const filename = `Zelda-TotK-${sanitizeForFilename(segment.match.slug)}.mp3`;
    const destination = join(options.output, filename);
    extractClip(segment, destination);
    segment.outputFile = destination;

    if (options.publish) {
      copyFileSync(destination, join(SOUNDS_DIR, filename));
    }
  }

  const currentLibrary = buildCurrentLibraryIndex();
  const comparison = accepted.map((segment) => {
    const filename = `Zelda-TotK-${sanitizeForFilename(segment.match.slug)}.mp3`;
    const generatedDuration = Number(probeDuration(segment.outputFile).toFixed(3));
    const current = currentLibrary.get(getCurrentComparisonFile(filename, currentLibrary));
    return {
      filename,
      segment: segment.index,
      generatedDuration,
      currentDuration: current?.duration ?? null,
      delta: current ? Number((generatedDuration - current.duration).toFixed(3)) : null,
      score: segment.match.score,
      rawTitleText: segment.rawTitleText,
    };
  });

  const exportedFilenames = new Set(comparison.map((entry) => entry.filename));
  const currentOnlySounds = [...currentLibrary.keys()]
    .filter((filename) => !exportedFilenames.has(filename) && ![...CURRENT_LIBRARY_ALIASES.values()].includes(filename))
    .sort();

  const report = {
    generatedAt: new Date().toISOString(),
    source,
    options,
    segmentSource,
    silenceThreshold,
    totalSegments: segments.length,
    matchedSegments: analyzed.filter((segment) => segment.match).length,
    exportedSounds: accepted.length,
    unmatchedSegments: reportSegments.filter((segment) => segment.skip?.reason === "unmatched").map((segment) => ({
      index: segment.index,
      rawTitleText: segment.rawTitleText,
      duration: segment.duration,
    })),
    duplicateSegments: reportSegments.filter((segment) => segment.skip?.reason === "duplicate").map((segment) => ({
      index: segment.index,
      title: segment.match.slug,
      keptSegment: segment.skip.keptSegment,
      rawTitleText: segment.rawTitleText,
    })),
    currentOnlySounds,
    comparisons: comparison,
    segments: reportSegments.map((segment) => ({
      index: segment.index,
      start: segment.start,
      contentEnd: segment.contentEnd,
      end: segment.end,
      duration: segment.duration,
      tailPaddingApplied: segment.tailPaddingApplied,
      manifestStartHint: segment.manifestStartHint ?? null,
      manifestEndHint: segment.manifestEndHint ?? null,
      sampledAt: segment.sampledAt,
      rawTitleText: segment.rawTitleText,
      chosenFrame: segment.chosenFrame,
      match: segment.match ? {
        title: segment.match.slug,
        score: segment.match.score,
      } : null,
      skip: segment.skip ?? null,
    })),
  };

  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + "\n");

  console.log(`Source: ${source.title} (${source.id})`);
  console.log(`Segments: ${segments.length}`);
  console.log(`Matched: ${analyzed.filter((segment) => segment.match).length}`);
  console.log(`Exported: ${accepted.length}`);
  console.log(`Tail padding: ${options.tailPadding}s`);
  console.log(
    segmentSource.mode === "manifest"
      ? `Segment source: manifest (${segmentSource.path})`
      : `Silence threshold: ${
          silenceThreshold.mode === "percentile"
            ? `${silenceThreshold.selected.thresholdDb}dB (percentile ${silenceThreshold.selected.percentile})`
            : `${silenceThreshold.selected.thresholdDb}dB (fixed)`
        }`,
  );
  if (segmentSource.mode === "manifest") {
    console.log(
      `Silence refinement: ${silenceThreshold.selected.thresholdDb}dB, start tolerance ${options.manifestStartTolerance}s, end tolerance ${options.manifestEndTolerance}s`,
    );
  }
  console.log(`Report: ${REPORT_JSON}`);
  console.log(`Output: ${options.output}`);

  const notableDiffs = comparison
    .filter((entry) => entry.delta !== null && Math.abs(entry.delta) >= 0.05)
    .sort((lhs, rhs) => Math.abs(rhs.delta) - Math.abs(lhs.delta))
    .slice(0, 10);

  if (notableDiffs.length) {
    console.log("\nLargest duration deltas vs current library:");
    for (const entry of notableDiffs) {
      console.log(
        `  ${entry.filename}: new=${entry.generatedDuration}s current=${entry.currentDuration}s delta=${entry.delta}s`,
      );
    }
  }
}

main();
