import 'dotenv/config';
import { getArchitectClient } from './client';

async function main(): Promise<void> {
  console.log('🧪 Testing connection to opportunity-architecture...\n');

  const client = getArchitectClient();

  console.log('1. Health check (no auth)...');
  try {
    const health = await client.health();
    console.log(`   ✅ Architect status: ${health.status} at ${health.timestamp}\n`);
  } catch (error) {
    console.error(`   ❌ Health check failed: ${(error as Error).message}\n`);
    process.exit(1);
  }

  console.log('2. Listing specs (HMAC auth)...');
  try {
    const specs = await client.listSpecs({ limit: 5 });
    console.log(`   ✅ Got ${specs.length} specs\n`);
    for (const s of specs) {
      console.log(`   - [${s.specId}] ${s.appName} (status: ${s.status})`);
    }
    console.log('');
  } catch (error) {
    console.error(`   ❌ List failed: ${(error as Error).message}\n`);
    process.exit(1);
  }

  console.log('✅ All connection checks passed.');
  process.exit(0);
}

main();
