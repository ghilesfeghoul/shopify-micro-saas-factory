import 'dotenv/config';
import { detectSkills } from './detector';
import { formatSkillsForPrompt, pickRelevantSkills } from './injector';

console.log('🔍 Detecting installed skills...\n');

const skills = detectSkills();

if (skills.length === 0) {
  console.log('❌ No skills detected.');
  console.log('');
  console.log('Expected locations checked:');
  console.log('  - ~/.claude/skills/');
  console.log('  - ~/.claude/plugins/');
  console.log('  - $SKILLS_PATH (colon-separated)');
  console.log('');
  console.log('To add custom paths, set SKILLS_PATH in .env:');
  console.log('  SKILLS_PATH="/path/to/shopify-skills:/path/to/superpowers"');
  process.exit(1);
}

console.log(`✅ Found ${skills.length} skills:\n`);
for (const skill of skills) {
  console.log(`  📦 ${skill.name}`);
  console.log(`     Source: ${skill.source}`);
  console.log(`     Path:   ${skill.skillFilePath}`);
  console.log(`     Tags:   ${skill.tags.join(', ') || '(none)'}`);
  console.log(`     Desc:   ${skill.shortDescription.slice(0, 80)}...`);
  console.log('');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Per-role skill assignment:\n');

const roles = ['backend', 'ui', 'database', 'tests', 'config'] as const;
for (const role of roles) {
  const relevant = pickRelevantSkills(skills, role);
  console.log(`  ${role}: ${relevant.length} skills`);
  for (const r of relevant) console.log(`     • ${r.name}`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Sample prompt fragment for backend sub-agent:\n');
console.log(formatSkillsForPrompt(pickRelevantSkills(skills, 'backend')));
