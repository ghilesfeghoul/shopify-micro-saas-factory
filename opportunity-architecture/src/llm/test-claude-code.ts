import 'dotenv/config';
import { ClaudeCodeProvider } from './claude-code-provider';

async function main(): Promise<void> {
  console.log('🧪 Testing Claude Code provider for architect service...\n');

  const provider = new ClaudeCodeProvider({
    timeoutMs: 60_000,
    useBare: process.env.CLAUDE_CODE_USE_BARE === 'true',
  });

  const testSchema = {
    type: 'object',
    required: ['ping'],
    properties: { ping: { type: 'string' } },
  };

  try {
    const response = await provider.analyze({
      systemPrompt: 'You are a connectivity tester. Respond with {"ping":"pong"}.',
      userMessage: 'ping',
      jsonSchema: testSchema,
    });

    console.log('✅ Claude Code responded:', JSON.stringify(response.data));
    console.log(`   Duration: ${(response.usage.durationMs / 1000).toFixed(1)}s`);
    if (response.usage.costUsd !== undefined) {
      console.log(`   Cost: $${response.usage.costUsd.toFixed(4)}`);
    }
    process.exit(0);
  } catch (error) {
    console.error('❌ Claude Code test failed:', (error as Error).message);
    process.exit(1);
  }
}

main();
