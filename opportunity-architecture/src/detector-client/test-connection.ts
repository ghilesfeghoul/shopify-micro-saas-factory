import 'dotenv/config';
import { getDetectorClient } from './client';

async function main(): Promise<void> {
  console.log('🧪 Testing connection to opportunity-detector...\n');

  const client = getDetectorClient();

  console.log('1. Health check (no auth)...');
  try {
    const health = await client.health();
    console.log(`   ✅ Detector status: ${health.status} at ${health.timestamp}\n`);
  } catch (error) {
    console.error(`   ❌ Health check failed: ${(error as Error).message}\n`);
    process.exit(1);
  }

  console.log('2. Listing opportunities (HMAC auth)...');
  try {
    const opps = await client.listOpportunities({ limit: 25 });
    console.log(`   ✅ Got ${opps.length} opportunities\n`);
    for (const opp of opps) {
      console.log(`   - [${opp.opportunityId}] ${opp.title} — score ${opp.totalScore}/50 (${opp.priority})`);
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
