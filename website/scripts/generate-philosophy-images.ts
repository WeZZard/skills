/**
 * Generate philosophy illustration images for the Amplify plugin page.
 *
 * Uses the CLIproxy API (localhost:8317) with gemini-3-pro-image model
 * to generate editorial-style illustrations for each Design Philosophy card.
 *
 * Usage:
 *   CLIPROXY_API_KEY=<key> npx tsx scripts/generate-philosophy-images.ts
 *
 * Or set CLIPROXY_API_KEY in the root .env file.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: join(__dirname, "../../.env") });

const CLIPROXY_BASE_URL = "http://localhost:8317";
const MODEL = "gemini-3-pro-image";
const OUTPUT_DIR = join(__dirname, "../public/images/philosophies");

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Style preamble shared across all prompts ──────────────────────────
// This ensures visual consistency across the illustrations.
//
// CONFIGURATION: Edit these preambles to change the overall visual style.
// - STYLE_PREAMBLE: Used for single hero images (parallelism, plan-audit)
// - COMPARISON_STYLE_PREAMBLE: Used for comparison pair images (raw/amplify)
//
const STYLE_PREAMBLE = `You are generating a single clean icon-style illustration. Think of an app icon or a simple infographic symbol.

STRICT STYLE REQUIREMENTS — follow these exactly:
- Extremely simple, clean, and minimal — like a well-designed app icon or a single symbol
- Maximum 2-3 distinct visual elements in the entire image
- Use ONLY these colors: deep charcoal (#2C2416) for outlines/shapes, one accent color per image (either #C4704B terracotta OR #7D9B84 sage green, not both), and white (#FFFFFF) background
- Thick, confident line work — no thin or sketchy lines
- No gradients, no shadows, no texture, no noise
- No text, no labels, no words, no letters, no numbers
- No human faces or realistic figures
- Aspect ratio: landscape, roughly 16:10
- Pure white background with at least 30% whitespace around the subject
- The illustration should be immediately recognizable as a concept at thumbnail size
- Think: Apple's SF Symbols, or Notion's page icons — that level of simplicity
`;

const COMPARISON_STYLE_PREAMBLE = `You are generating a single clean icon-style illustration. Think of an app icon or a simple infographic symbol.

STRICT STYLE REQUIREMENTS — follow these exactly:
- Extremely simple, clean, and minimal — like a well-designed app icon or a single symbol
- Maximum 2-3 distinct visual elements in the entire image
- Use ONLY these colors: deep charcoal (#2C2416) for outlines/shapes, one accent color per image (either #C4704B terracotta OR #7D9B84 sage green, not both), and white (#FFFFFF) background
- Thick, confident line work — no thin or sketchy lines
- No gradients, no shadows, no texture, no noise
- No text, no labels, no words, no letters, no numbers
- No human faces or realistic figures
- Aspect ratio: roughly 4:3 (compact)
- Pure white background with at least 30% whitespace around the subject
- The illustration should be immediately recognizable as a concept at thumbnail size
- Think: Apple's SF Symbols, or Notion's page icons — that level of simplicity
`;

// ── Per-philosophy prompts ─────────────────────────────────────────────

interface PhilosophyPrompt {
  id: string;
  filename: string;
  prompt: string;
}

// ── Per-philosophy prompts ─────────────────────────────────────────────
//
// CONFIGURATION: Edit individual prompts below to change what each image depicts.
// Each prompt is concatenated with its style preamble.
//
// To regenerate all:  npx tsx scripts/generate-philosophy-images.ts --force
// To regenerate one:  rm public/images/philosophies/<filename> && npx tsx scripts/generate-philosophy-images.ts
//

const philosophyPrompts: PhilosophyPrompt[] = [
  // ── Comparison pairs (Raw + Amplify) ──────────────────────────────────
  //
  // "Raw" images use charcoal (#2C2416) only — no accent color — to feel limited.
  // "Amplify" images use sage green (#7D9B84) accent — to feel expanded.
  //
  {
    id: "ground-truth-first-raw",
    filename: "ground-truth-first-raw.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw a single closed book, viewed from a slight angle, centered on a white background. The book is drawn with thick charcoal (#2C2416) outlines only — no fill color, no accent color. The book is small relative to the canvas, surrounded by empty white space. Nothing else in the image. Conveys: isolation, single source, limitation.`,
  },
  {
    id: "ground-truth-first-amplify",
    filename: "ground-truth-first-amplify.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw an open book in the center with three simple circles (nodes) floating above it, connected by thin lines forming a small network. The book and connecting lines are charcoal (#2C2416). The three nodes are filled with sage green (#7D9B84). White background. Conveys: knowledge expanding outward, multiple verified sources connected.`,
  },
  {
    id: "clear-plan-raw",
    filename: "clear-plan-raw.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw three sticky notes or small squares, overlapping each other at random angles, slightly rotated. Drawn with thick charcoal (#2C2416) outlines only — no fill, no accent color. They look scattered and disorganized. White background, generous whitespace. Conveys: freeform, unstructured, ad-hoc.`,
  },
  {
    id: "clear-plan-amplify",
    filename: "clear-plan-amplify.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw three rectangles neatly stacked vertically with equal spacing, connected by a single vertical line on the left side (like a simple flowchart or outline). The rectangles have charcoal (#2C2416) outlines. The connecting line and small bullet dots are sage green (#7D9B84). White background. Conveys: structured, organized, clear hierarchy.`,
  },
  {
    id: "error-recovery-raw",
    filename: "error-recovery-raw.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw a single straight path (thick line) going from left toward a target (simple circle) on the right. Midway, the path hits a gap (break in the line) and then continues as a dashed zigzag line veering downward away from the target. All in charcoal (#2C2416), no accent color. White background. Conveys: hitting an error and drifting off course.`,
  },
  {
    id: "error-recovery-amplify",
    filename: "error-recovery-amplify.jpg",
    prompt: `${COMPARISON_STYLE_PREAMBLE}
Draw a single straight path (thick line) going from left toward a target (simple circle) on the right. Midway, the path hits a gap (break in the line), but then curves smoothly back upward and reconnects to reach the target. The path is charcoal (#2C2416). The target circle is filled with sage green (#7D9B84). White background. Conveys: hitting an error but recovering to reach the goal.`,
  },
  // ── Single illustrations (no comparison) ──────────────────────────────
  {
    id: "parallelism",
    filename: "parallelism.jpg",
    prompt: `${STYLE_PREAMBLE}
Draw three horizontal lines (tracks) running parallel from left to right, evenly spaced. Each track has a small circle on it at a different position along the track, like three tasks progressing simultaneously. On the right side, the three tracks merge into a single point (a filled circle). The tracks and circles are charcoal (#2C2416). The merge point is filled with terracotta (#C4704B). White background. Conveys: parallel execution converging to completion.`,
  },
  {
    id: "plan-audit",
    filename: "plan-audit.jpg",
    prompt: `${STYLE_PREAMBLE}
Draw a simple document outline (rectangle with a folded corner) on the left. To its right, draw three horizontal rows. The first two rows have a small filled circle (checkmark indicator) in terracotta (#C4704B). The third row has a half-filled circle. Thin charcoal (#2C2416) lines connect the document to each row. White background. Conveys: systematic verification of a plan, task-by-task audit.`,
  },
];

// ── API call ───────────────────────────────────────────────────────────

async function generateImage(prompt: string): Promise<Buffer> {
  const apiKey = process.env.CLIPROXY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CLIPROXY_API_KEY not set. Add it to .env or pass as environment variable."
    );
  }

  const response = await fetch(`${CLIPROXY_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const images = data?.choices?.[0]?.message?.images;

  if (!images || images.length === 0) {
    // Check if there's text content instead (model refused or returned text)
    const textContent = data?.choices?.[0]?.message?.content;
    if (textContent) {
      throw new Error(`Model returned text instead of image: ${textContent.slice(0, 200)}`);
    }
    throw new Error("No images in response");
  }

  const dataUri = images[0].image_url.url;
  const base64Data = dataUri.split(",", 2)[1];
  if (!base64Data) {
    throw new Error("Could not extract base64 data from image URL");
  }

  return Buffer.from(base64Data, "base64");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("🎨 Generating philosophy illustrations for Amplify plugin page\n");
  console.log(`   Model: ${MODEL}`);
  console.log(`   Output: ${OUTPUT_DIR}\n`);

  const apiKey = process.env.CLIPROXY_API_KEY;
  if (!apiKey || apiKey === "your-cliproxy-api-key-here") {
    console.error("❌ CLIPROXY_API_KEY not set or still placeholder.");
    console.error("   Please set your CLIproxy API key in .env:");
    console.error("   CLIPROXY_API_KEY=your-actual-key\n");
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const phil of philosophyPrompts) {
    const outputPath = join(OUTPUT_DIR, phil.filename);

    // Skip if image already exists (use --force to regenerate)
    if (existsSync(outputPath) && !process.argv.includes("--force")) {
      console.log(`  ⏭  ${phil.id}: already exists (use --force to regenerate)`);
      successCount++;
      continue;
    }

    console.log(`  ⟳  ${phil.id}: generating...`);

    try {
      const imageBuffer = await generateImage(phil.prompt);
      writeFileSync(outputPath, imageBuffer);
      const sizeKB = Math.round(imageBuffer.length / 1024);
      console.log(`  ✓  ${phil.id}: saved (${sizeKB} KB)`);
      successCount++;
    } catch (error) {
      console.error(`  ✗  ${phil.id}: failed —`, (error as Error).message);
      failCount++;
    }

    // Small delay between requests to be respectful to the API
    if (phil !== philosophyPrompts[philosophyPrompts.length - 1]) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`\n✨ Done! ${successCount} succeeded, ${failCount} failed.`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main();
