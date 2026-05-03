import type { DetectedSkill } from './detector';

/**
 * Format a list of skills as a prompt fragment that sub-agents can read.
 *
 * The development agent passes this to each sub-agent's append-system-prompt
 * so the sub-agent knows which skills are available and can invoke them
 * via Claude Code's natural skill discovery.
 */
export function formatSkillsForPrompt(skills: DetectedSkill[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Compétences (skills) disponibles');
  lines.push('');
  lines.push(
    `Tu as accès aux ${skills.length} skills suivants installés sur la machine. Avant d'écrire du code, lis le SKILL.md de chaque skill pertinent pour la tâche en cours. Les skills encodent les meilleures pratiques spécifiques à l'environnement (versions, conventions, contraintes Shopify, patterns Superpowers).`
  );
  lines.push('');
  lines.push('| Nom | Source | Description courte | Tags |');
  lines.push('|-----|--------|-------------------|------|');

  for (const skill of skills) {
    const desc = skill.shortDescription.replace(/\|/g, '\\|').slice(0, 120);
    const tags = skill.tags.slice(0, 5).join(', ');
    lines.push(`| \`${skill.name}\` | ${skill.source} | ${desc} | ${tags} |`);
  }

  lines.push('');
  lines.push('### Comment utiliser les skills');
  lines.push('');
  lines.push('Quand une tâche correspond à un skill disponible, utilise l\'outil Read (ou view) pour lire son SKILL.md d\'abord, puis suis ses instructions. Ne jamais "deviner" un pattern Shopify ou React si un skill local le couvre — les skills locaux sont la source de vérité prioritaire.');
  lines.push('');
  lines.push('Chemins absolus des skills:');
  for (const skill of skills) {
    lines.push(`- \`${skill.name}\` : \`${skill.skillFilePath}\``);
  }

  return lines.join('\n');
}

/**
 * Pick the most relevant skills for a given sub-agent role, based on tags.
 */
export function pickRelevantSkills(
  skills: DetectedSkill[],
  role: 'backend' | 'ui' | 'database' | 'tests' | 'config' | 'docs' | 'integrator' | 'repair'
): DetectedSkill[] {
  const tagsForRole: Record<string, string[]> = {
    backend: ['shopify', 'backend', 'api', 'oauth', 'superpowers'],
    ui: ['shopify', 'frontend', 'react', 'polaris', 'app-bridge', 'superpowers'],
    database: ['shopify', 'prisma', 'database', 'sqlite', 'postgresql'],
    tests: ['testing', 'jest', 'playwright', 'tdd', 'superpowers'],
    config: ['shopify', 'config', 'cli', 'shopify-cli'],
    docs: ['documentation', 'markdown'],
    integrator: ['shopify', 'integration', 'build', 'lint', 'typescript'],
    repair: ['shopify', 'debugging', 'tests', 'lint', 'typescript', 'superpowers'],
  };

  const wantedTags = tagsForRole[role] ?? ['shopify'];
  // Always include Shopify-tagged skills + any role-specific
  return skills.filter((skill) =>
    skill.tags.some((t) => wantedTags.includes(t)) || skill.name.toLowerCase().includes('shopify')
  );
}
