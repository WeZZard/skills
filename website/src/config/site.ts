/**
 * Site Configuration
 * Loads configuration from TOML files
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import toml from "toml";

// Types
export interface SiteConfig {
  site: {
    name: string;
    description: string;
  };
  hero: {
    slogan: string;
    subtitle: string;
  };
  footer: {
    copyright: string;
  };
}

// Load site configuration from TOML
function loadSiteConfig(): SiteConfig {
  const configPath = join(process.cwd(), "site.toml");

  if (!existsSync(configPath)) {
    throw new Error(
      `Missing required site configuration file: ${configPath}\n\n` +
      `Create a "site.toml" file in the website root directory with the following TOML format:\n\n` +
      `# Site Configuration\n` +
      `# Edit this file to customize site-wide content\n` +
      `\n` +
      `[site]\n` +
      `name = "Your Site Name"\n` +
      `description = "A short description of your site"\n` +
      `\n` +
      `[hero]\n` +
      `slogan = "Your Slogan"\n` +
      `subtitle = "A subtitle for the hero section"\n` +
      `\n` +
      `[footer]\n` +
      `copyright = "Your Name"\n`
    );
  }

  const content = readFileSync(configPath, "utf-8");
  return toml.parse(content) as SiteConfig;
}

// Export loaded config
export const siteConfig = loadSiteConfig();
