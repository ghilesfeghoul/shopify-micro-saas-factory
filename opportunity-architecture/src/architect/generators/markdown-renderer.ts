import type { TechnicalSpec } from '../schemas/spec-schema';

/**
 * Render a TechnicalSpec as Markdown.
 * The JSON is the source of truth — Markdown is computed on demand.
 */
export function renderSpecAsMarkdown(spec: TechnicalSpec): string {
  const lines: string[] = [];
  const push = (s: string = '') => lines.push(s);
  const h1 = (s: string) => push(`# ${s}\n`);
  const h2 = (s: string) => push(`\n## ${s}\n`);
  const h3 = (s: string) => push(`\n### ${s}\n`);

  // ─── Header ────────────────────────────────────────────────
  h1(`${spec.overview.appName}`);
  push(`> ${spec.overview.tagline}`);
  push();
  push(`**Spec ID:** \`${spec.specId}\` &nbsp;·&nbsp; **Opportunity:** \`${spec.opportunityId}\` &nbsp;·&nbsp; **Schema:** v${spec.schemaVersion}`);
  push(`**Generated:** ${spec.metadata.generatedAt} &nbsp;·&nbsp; **Generator:** ${spec.metadata.generatorVersion}`);
  push(`**Source opportunity score:** ${spec.metadata.sourceOpportunityScore}/50`);

  // ─── Overview ──────────────────────────────────────────────
  h2('📋 Overview');
  push(spec.overview.description);
  push();
  push(`**Target merchants:** ${spec.overview.targetMerchants}`);
  push();
  push(`**Value proposition:** ${spec.overview.valueProposition}`);
  push();

  h3('MVP Scope');
  for (const item of spec.overview.mvpScope) push(`- ${item}`);

  if (spec.overview.futureScope?.length) {
    h3('Future scope (post-MVP)');
    for (const item of spec.overview.futureScope) push(`- ${item}`);
  }

  if (spec.overview.nonGoals?.length) {
    h3('Non-goals (explicitly out of scope)');
    for (const item of spec.overview.nonGoals) push(`- ${item}`);
  }

  // ─── Architecture ──────────────────────────────────────────
  h2('🏗️ Architecture');
  push(`| Field | Value |`);
  push(`|-------|-------|`);
  push(`| Pattern | \`${spec.architecture.pattern}\` |`);
  push(`| Backend | \`${spec.architecture.backendFramework}\` |`);
  push(`| Frontend | \`${spec.architecture.frontendFramework}\` |`);
  push(`| Database | \`${spec.architecture.database}\` |`);
  push();
  h3('Diagram');
  push('```');
  push(spec.architecture.diagram);
  push('```');
  push();
  h3('Technical choices justification');
  push(spec.architecture.technicalChoicesJustification);

  // ─── Shopify Integration ───────────────────────────────────
  h2('🛍️ Shopify Integration');
  push(`**API version:** \`${spec.shopify.apiVersion}\` &nbsp;·&nbsp; **App Bridge:** \`${spec.shopify.appBridgeVersion}\` &nbsp;·&nbsp; **Auth:** \`${spec.shopify.authMethod}\``);
  push();
  h3('Required scopes (with justifications)');
  push(`| Scope | Justification |`);
  push(`|-------|---------------|`);
  for (const scope of spec.shopify.requiredScopes) {
    const justif = spec.shopify.scopesJustification[scope] || '*(missing)*';
    push(`| \`${scope}\` | ${justif} |`);
  }
  push();
  h3('Webhooks');
  push(`| Topic | Category | Required | Description |`);
  push(`|-------|----------|----------|-------------|`);
  for (const wh of spec.shopify.webhooks) {
    const req = wh.required ? '✅' : '⚪';
    push(`| \`${wh.topic}\` | ${wh.category} | ${req} | ${wh.description} |`);
  }
  push();
  h3('Rate limit strategy');
  push(spec.shopify.rateLimitStrategy);

  // ─── API Endpoints ─────────────────────────────────────────
  h2('🔌 API Endpoints');
  for (const ep of spec.apiEndpoints) {
    h3(`\`${ep.method}\` ${ep.path}`);
    push(`${ep.description}`);
    push();
    push(`**Auth required:** ${ep.authRequired ? 'Yes' : 'No'}`);
    if (ep.rateLimit) push(`**Rate limit:** ${ep.rateLimit}`);
    push();

    if (ep.requestSchema) {
      push(`**Request:**`);
      push('```json');
      push(JSON.stringify(ep.requestSchema, null, 2));
      push('```');
    }

    push(`**Response:**`);
    push('```json');
    push(JSON.stringify(ep.responseSchema, null, 2));
    push('```');

    push(`**Error cases:**`);
    for (const err of ep.errorCases) {
      push(`- \`${err.statusCode}\` — ${err.description}`);
    }
  }

  // ─── Database ──────────────────────────────────────────────
  h2('🗄️ Database Schema');
  for (const table of spec.database.tables) {
    h3(`Table: \`${table.name}\``);
    push(table.description);
    push();
    push(`| Field | Type | Nullable | Unique | Default | Description |`);
    push(`|-------|------|----------|--------|---------|-------------|`);
    for (const f of table.fields) {
      push(`| \`${f.name}\` | \`${f.type}\` | ${f.nullable ? '✅' : '❌'} | ${f.unique ? '✅' : '—'} | ${f.defaultValue ?? '—'} | ${f.description} |`);
    }

    if (table.indexes?.length) {
      push();
      push(`**Indexes:**`);
      for (const idx of table.indexes) {
        push(`- \`(${idx.fields.join(', ')})\`${idx.unique ? ' UNIQUE' : ''}`);
      }
    }

    if (table.relations?.length) {
      push();
      push(`**Relations:**`);
      for (const rel of table.relations) {
        push(`- \`${rel.name}\` → \`${rel.targetModel}\` (\`${rel.type}\`${rel.onDelete ? `, onDelete: ${rel.onDelete}` : ''})`);
      }
    }
  }

  if (spec.database.seedData) {
    h3('Seed data');
    push(spec.database.seedData);
  }

  // ─── UI ────────────────────────────────────────────────────
  h2('🎨 UI / UX');
  push(`**Design system:** ${spec.ui.designSystem}`);
  push();
  push(`**Accessibility:** ${spec.ui.accessibilityNotes}`);
  push();
  h3('Screens');
  for (const screen of spec.ui.screens) {
    push(`#### \`${screen.path}\` — ${screen.name}`);
    push(screen.description);
    push();
    push(`**Polaris components:** ${screen.primaryComponents.map((c) => `\`${c}\``).join(', ')}`);
    push();
    push(`**User actions:**`);
    for (const action of screen.userActions) push(`- ${action}`);
    push();
    if (screen.apiEndpointsUsed.length) {
      push(`**API endpoints used:** ${screen.apiEndpointsUsed.map((e) => `\`${e}\``).join(', ')}`);
    }
    push();
  }

  // ─── Testing ───────────────────────────────────────────────
  h2('🧪 Testing');
  push(`**Strategy:** ${spec.testing.strategy}`);
  push();
  push(`**Coverage target:** ${spec.testing.coverageTarget}%`);
  push();
  h3('Test cases');
  push(`| Type | Name | Description | Expected behavior |`);
  push(`|------|------|-------------|-------------------|`);
  for (const tc of spec.testing.testCases) {
    push(`| \`${tc.type}\` | ${tc.name} | ${tc.description} | ${tc.expectedBehavior} |`);
  }

  // ─── Stack ─────────────────────────────────────────────────
  h2('📦 Stack & Dependencies');
  push(`**Runtime:** \`${spec.stack.runtime}\` &nbsp;·&nbsp; **Language:** \`${spec.stack.language}\` &nbsp;·&nbsp; **Build tool:** \`${spec.stack.buildTool}\``);
  push();
  h3('Dependencies');
  push(`| Package | Version | Purpose | Dev only |`);
  push(`|---------|---------|---------|----------|`);
  for (const dep of spec.stack.dependencies) {
    push(`| \`${dep.package}\` | \`${dep.version}\` | ${dep.purpose} | ${dep.isDevDependency ? '✅' : '—'} |`);
  }

  // ─── Estimation ────────────────────────────────────────────
  h2('⏱️ Estimation');
  push(`**Total hours:** ${spec.estimation.totalHours}h &nbsp;·&nbsp; **Complexity:** ${spec.estimation.complexityScore}/10`);
  push();
  h3('Breakdown');
  push(`| Module | Hours |`);
  push(`|--------|-------|`);
  for (const b of spec.estimation.breakdown) push(`| ${b.module} | ${b.hours}h |`);
  push();
  h3('Risks');
  push(`| Severity | Description | Mitigation |`);
  push(`|----------|-------------|------------|`);
  for (const r of spec.estimation.risks) {
    const severityIcon = r.severity === 'critical' ? '🔥' : r.severity === 'high' ? '⚠️' : r.severity === 'medium' ? '🟡' : '🟢';
    push(`| ${severityIcon} ${r.severity} | ${r.description} | ${r.mitigation} |`);
  }

  if (spec.estimation.blockers?.length) {
    h3('🚧 Blockers (require human review)');
    for (const blocker of spec.estimation.blockers) push(`- ⚠️ ${blocker}`);
  }

  // ─── Compliance ────────────────────────────────────────────
  h2('✅ Compliance');
  push(`**App Store category:** ${spec.compliance.appStoreCategory}`);
  push();
  push(`**GDPR webhooks implemented:** ${spec.compliance.gdprWebhooksImplemented ? '✅ Yes' : '❌ NO — REJECT'}`);
  push();
  h3('Policy checks');
  push(`| Requirement | Compliant | Notes |`);
  push(`|-------------|-----------|-------|`);
  for (const check of spec.compliance.policyChecks) {
    const icon = check.compliant ? '✅' : '❌';
    push(`| ${check.requirement} | ${icon} | ${check.notes ?? '—'} |`);
  }

  push();
  push(`---`);
  push(`*Generated by ${spec.metadata.generatorVersion} on ${spec.metadata.generatedAt}*`);

  return lines.join('\n');
}
