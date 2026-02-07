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

export interface PluginWebsiteConfig {
  philosophy?: {
    intro: string;
    sections: Array<{
      title: string;
      content: string;
    }>;
  };
}

// Load site configuration from TOML
function loadSiteConfig(): SiteConfig {
  const configPath = join(process.cwd(), "site.toml");

  if (!existsSync(configPath)) {
    // Fallback defaults
    return {
      site: {
        name: "WeZZard Skills",
        description: "Claude Code skills by WeZZard",
      },
      hero: {
        slogan: "Craft with Intention",
        subtitle: "Thoughtful skills for AI-assisted development",
      },
      footer: {
        copyright: "WeZZard",
      },
    };
  }

  const content = readFileSync(configPath, "utf-8");
  return toml.parse(content) as SiteConfig;
}

// Load plugin website configuration from TOML
export function loadPluginWebsiteConfig(pluginName: string): PluginWebsiteConfig | null {
  // Look for website.toml in the plugin directory
  const configPath = join(process.cwd(), "..", "claude", pluginName, "website.toml");

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    return toml.parse(content) as PluginWebsiteConfig;
  } catch (error) {
    console.error(`Failed to parse website.toml for plugin ${pluginName}:`, error);
    return null;
  }
}

// Export loaded config
export const siteConfig = loadSiteConfig();
