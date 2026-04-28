/**
 * Smoke test for Claude Code provider.
 * Verifies that:
 *   1. The `claude` binary is on PATH
 *   2. Authentication works (you can call it from a script)
 *   3. The --json-schema flag produces structured output as expected
 *
 * Run: npm run test:claude-code
 */
import 'dotenv/config';
import { ClaudeCodeProvider } from './claude-code-provider';

async function main(): Promise<void> {
  console.log('🧪 Testing Claude Code provider...\n');

  const provider = new ClaudeCodeProvider({
    timeoutMs: 60_000,
  });

  const testSchema = {
    type: 'object',
    properties: {
      opportunities: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'score'],
          properties: {
            name: { type: 'string' },
            score: { type: 'integer', minimum: 0, maximum: 10 },
          },
        },
      },
    },
    required: ['opportunities'],
  };

  try {
    const response = await provider.analyze({
      systemPrompt: 'You are a test analyzer. Always return exactly 2 fake opportunities.',
      userMessage: 'Generate 2 fake test opportunities with arbitrary names and scores.',
      jsonSchema: testSchema,
    });

    console.log('✅ Claude Code responded successfully\n');
    console.log('Response data:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\nUsage:');
    console.log(`  Backend: ${response.backend}`);
    console.log(`  Duration: ${(response.usage.durationMs / 1000).toFixed(1)}s`);
    if (response.usage.costUsd !== undefined) {
      console.log(`  Cost: $${response.usage.costUsd.toFixed(4)}`);
    }
    console.log('\n✅ All checks passed. Claude Code is ready to use.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Claude Code test failed:');
    console.error(`   ${(error as Error).message}\n`);
    console.error('Troubleshooting:');
    console.error('  • Verify install:    which claude');
    console.error('  • Verify auth:       claude -p "say hi" --bare');
    console.error('  • Update CLI:        npm update -g @anthropic-ai/claude-code');
    process.exit(1);
  }
}

main();
