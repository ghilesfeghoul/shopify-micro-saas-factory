import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import type { TechnicalSpec } from '../utils/types';

export interface ComplianceCheck {
  name: string;
  passed: boolean;
  message: string;
}

const REQUIRED_GDPR_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
];

/**
 * Static scan of generated code for Shopify compliance requirements.
 *
 * This catches the most common App Store rejection causes:
 * - Missing GDPR webhooks
 * - Scopes not declared in shopify.app.toml matching the spec
 * - Hardcoded secrets that shouldn't be there
 */
export function runShopifyComplianceChecks(
  workspacePath: string,
  spec: TechnicalSpec
): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];

  // 1. GDPR webhooks must be present in source code
  const sourceFiles = collectSourceFiles(workspacePath);
  const allSource = sourceFiles
    .map((f) => {
      try {
        return readFileSync(f, 'utf-8');
      } catch {
        return '';
      }
    })
    .join('\n');

  for (const topic of REQUIRED_GDPR_TOPICS) {
    const present = allSource.includes(topic);
    checks.push({
      name: `GDPR webhook: ${topic}`,
      passed: present,
      message: present
        ? `Reference to ${topic} found in source`
        : `MANDATORY: no reference to ${topic} found — App Store will reject`,
    });
  }

  // 2. shopify.app.toml exists and lists the required scopes
  const tomlPath = join(workspacePath, 'shopify.app.toml');
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, 'utf-8');
    const scopesLine = toml.match(/scopes\s*=\s*"([^"]+)"/);
    if (scopesLine) {
      const declaredScopes = new Set(scopesLine[1]!.split(',').map((s) => s.trim()));
      const expectedScopes = new Set(spec.shopify.requiredScopes);

      const missing = [...expectedScopes].filter((s) => !declaredScopes.has(s));
      const extra = [...declaredScopes].filter((s) => !expectedScopes.has(s));

      checks.push({
        name: 'Scopes declared in shopify.app.toml',
        passed: missing.length === 0,
        message:
          missing.length === 0
            ? `All ${expectedScopes.size} expected scopes declared` +
              (extra.length > 0 ? ` (extra: ${extra.join(', ')})` : '')
            : `Missing scopes in toml: ${missing.join(', ')}`,
      });
    } else {
      checks.push({
        name: 'Scopes declared in shopify.app.toml',
        passed: false,
        message: 'shopify.app.toml exists but no scopes line found',
      });
    }
  } else {
    checks.push({
      name: 'shopify.app.toml exists',
      passed: false,
      message: 'shopify.app.toml not found at workspace root',
    });
  }

  // 3. No hardcoded API keys or secrets
  const secretPatterns = [
    /shpat_[a-f0-9]{32,}/g,           // Shopify API access token
    /shpss_[a-f0-9]{32,}/g,           // Shopify shared secret
    /sk-ant-[a-zA-Z0-9_-]{20,}/g,     // Anthropic API key
    /sk_live_[a-zA-Z0-9]{24,}/g,      // Stripe live key
  ];

  let secretsFound: string[] = [];
  for (const file of sourceFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const pattern of secretPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        secretsFound.push(`${file}: ${matches[0].slice(0, 20)}...`);
      }
    }
  }

  checks.push({
    name: 'No hardcoded secrets',
    passed: secretsFound.length === 0,
    message:
      secretsFound.length === 0
        ? 'No secret patterns detected'
        : `Hardcoded secrets found: ${secretsFound.join('; ')}`,
  });

  // 4. .env.example exists
  const envExamplePath = join(workspacePath, '.env.example');
  checks.push({
    name: '.env.example exists',
    passed: existsSync(envExamplePath),
    message: existsSync(envExamplePath)
      ? '.env.example present'
      : '.env.example missing — merchants need it to configure',
  });

  // 5. README.md exists at root
  const readmePath = join(workspacePath, 'README.md');
  checks.push({
    name: 'README.md at root',
    passed: existsSync(readmePath),
    message: existsSync(readmePath) ? 'README.md present' : 'README.md missing',
  });

  return checks;
}

function collectSourceFiles(rootPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip noise
      if (
        entry === 'node_modules' ||
        entry === '.git' ||
        entry === 'dist' ||
        entry === '.next' ||
        entry === 'transcripts' ||
        entry.startsWith('.env') // Don't scan .env files (they're SUPPOSED to have secrets)
      ) {
        continue;
      }

      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|toml|json|md)$/.test(entry)) {
        files.push(full);
      }
    }
  }

  walk(rootPath);
  return files;
}

/**
 * Format checks as a markdown report (for INTEGRATION_REPORT.md or similar).
 */
export function formatComplianceReport(checks: ComplianceCheck[]): string {
  const lines: string[] = ['# Shopify Compliance Report', ''];
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  lines.push(`**Result:** ${passed} passed, ${failed} failed`);
  lines.push('');
  lines.push('| Check | Status | Notes |');
  lines.push('|-------|--------|-------|');
  for (const check of checks) {
    const icon = check.passed ? '✅' : '❌';
    lines.push(`| ${check.name} | ${icon} | ${check.message} |`);
  }

  return lines.join('\n');
}

logger.debug('Shopify compliance checks module loaded');
