import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger';

interface InstalledPluginsJson {
  version: number;
  plugins: Record<
    string,
    Array<{ installPath: string; scope?: string; version?: string }>
  >;
}

/**
 * A detected skill that the development agent can offer to sub-agents.
 *
 * Skills can come from several sources:
 * - User-global: ~/.claude/skills/<name>/SKILL.md
 * - Project-local: <cwd>/.claude/skills/<name>/SKILL.md
 * - Custom paths via SKILLS_PATH env var (colon-separated list)
 *
 * "Plugins" like Superpowers are also detected here if they expose a SKILL.md.
 */
export interface DetectedSkill {
  /** Short identifier, e.g. "shopify-app-dev" or "superpowers-tdd" */
  name: string;
  /** Absolute path to the SKILL.md file */
  skillFilePath: string;
  /** Absolute path to the skill's root directory */
  rootPath: string;
  /** Source category for logging/debug */
  source: 'user' | 'project' | 'custom' | 'plugin';
  /** First 200 chars of the SKILL.md description for quick reference */
  shortDescription: string;
  /** Tags / categories extracted from frontmatter or guessed from the name */
  tags: string[];
}

const DEFAULT_USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const DEFAULT_USER_PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const INSTALLED_PLUGINS_JSON = join(DEFAULT_USER_PLUGINS_DIR, 'installed_plugins.json');

/**
 * Detect all installed skills relevant to the development agent.
 * Returns a deduplicated list.
 */
export function detectSkills(): DetectedSkill[] {
  const skills: DetectedSkill[] = [];
  const seen = new Set<string>();

  // 1. User-global skills
  if (existsSync(DEFAULT_USER_SKILLS_DIR)) {
    skills.push(...scanDirectory(DEFAULT_USER_SKILLS_DIR, 'user'));
  }

  // 2. User-global plugins via installed_plugins.json
  skills.push(...scanInstalledPlugins());

  // 3. Custom paths from SKILLS_PATH env var
  const customPaths = (process.env.SKILLS_PATH || '').split(':').filter(Boolean);
  for (const customPath of customPaths) {
    if (existsSync(customPath)) {
      skills.push(...scanDirectory(customPath, 'custom'));
    } else {
      logger.warn(`SKILLS_PATH entry does not exist: ${customPath}`);
    }
  }

  // 4. Deduplicate by name (later sources win)
  const deduped = new Map<string, DetectedSkill>();
  for (const skill of skills) {
    if (seen.has(skill.skillFilePath)) continue;
    seen.add(skill.skillFilePath);
    deduped.set(skill.name, skill);
  }

  const result = [...deduped.values()];
  logger.info(`Detected ${result.length} skills`, {
    skills: result.map((s) => `${s.name} (${s.source})`),
  });
  return result;
}

/**
 * Read installed_plugins.json and scan the `skills/` subdirectory of each
 * plugin's installPath.  Skills are named "<pluginName>:<skillName>" to avoid
 * collisions between plugins.
 */
function scanInstalledPlugins(): DetectedSkill[] {
  if (!existsSync(INSTALLED_PLUGINS_JSON)) return [];

  let parsed: InstalledPluginsJson;
  try {
    parsed = JSON.parse(readFileSync(INSTALLED_PLUGINS_JSON, 'utf-8')) as InstalledPluginsJson;
  } catch (err) {
    logger.warn('Cannot parse installed_plugins.json', { error: (err as Error).message });
    return [];
  }

  const skills: DetectedSkill[] = [];

  for (const [pluginKey, installations] of Object.entries(parsed.plugins ?? {})) {
    // pluginKey looks like "superpowers@claude-plugins-official"
    const pluginName = pluginKey.split('@')[0] ?? pluginKey;

    for (const install of installations) {
      const skillsDir = join(install.installPath, 'skills');
      if (!existsSync(skillsDir)) continue;

      let entries: string[];
      try {
        entries = readdirSync(skillsDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(skillsDir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const skillPath = join(fullPath, 'SKILL.md');
        if (!existsSync(skillPath)) continue;

        skills.push(buildSkillEntry(`${pluginName}:${entry}`, skillPath, fullPath, 'plugin'));
      }
    }
  }

  return skills;
}

function scanDirectory(rootDir: string, source: DetectedSkill['source']): DetectedSkill[] {
  const skills: DetectedSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch (err) {
    logger.warn(`Cannot read directory ${rootDir}`, { error: (err as Error).message });
    return [];
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    const fullPath = join(rootDir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Look for SKILL.md inside the directory or one level deep
    const skillPath = findSkillMd(fullPath);
    if (!skillPath) continue;

    skills.push(buildSkillEntry(entry, skillPath, fullPath, source));
  }

  return skills;
}

function findSkillMd(directory: string): string | null {
  const direct = join(directory, 'SKILL.md');
  if (existsSync(direct)) return direct;

  // Some skills nest one level (e.g. /path/skill-name/skill-name/SKILL.md)
  try {
    const subdirs = readdirSync(directory);
    for (const sub of subdirs) {
      const candidate = join(directory, sub, 'SKILL.md');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }

  return null;
}

function buildSkillEntry(
  name: string,
  skillFilePath: string,
  rootPath: string,
  source: DetectedSkill['source']
): DetectedSkill {
  let content = '';
  try {
    content = readFileSync(skillFilePath, 'utf-8');
  } catch {
    /* ignore */
  }

  const shortDescription = extractShortDescription(content);
  const tags = extractTags(name, content);

  return {
    name,
    skillFilePath,
    rootPath,
    source,
    shortDescription,
    tags,
  };
}

function extractShortDescription(content: string): string {
  // Try frontmatter "description: ..." first
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const desc = fmMatch[1]!.match(/description:\s*(.+)/i);
    if (desc) return desc[1]!.trim().slice(0, 200);
  }

  // Otherwise, take the first non-heading paragraph
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('---')) continue;
    return trimmed.slice(0, 200);
  }

  return '';
}

function extractTags(name: string, content: string): string[] {
  const tags = new Set<string>();

  // Name-based heuristics
  const lowered = name.toLowerCase();
  if (lowered.includes('shopify')) tags.add('shopify');
  if (lowered.includes('react') || lowered.includes('polaris')) tags.add('frontend');
  if (lowered.includes('test') || lowered.includes('jest')) tags.add('testing');
  if (lowered.includes('superpower')) tags.add('superpowers');
  if (lowered.includes('tdd')) tags.add('tdd');
  if (lowered.includes('git')) tags.add('git');

  // Frontmatter tags
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const tagLine = fmMatch[1]!.match(/tags?:\s*(.+)/i);
    if (tagLine) {
      tagLine[1]!.split(/[,\s]+/).forEach((t) => {
        const cleaned = t.replace(/[\[\]"']/g, '').trim().toLowerCase();
        if (cleaned) tags.add(cleaned);
      });
    }
  }

  return [...tags];
}

/**
 * Filter skills by tags — used to give a sub-agent only the relevant skills.
 */
export function filterSkillsByTags(skills: DetectedSkill[], tags: string[]): DetectedSkill[] {
  if (tags.length === 0) return skills;
  return skills.filter((skill) => skill.tags.some((t) => tags.includes(t)));
}
