import './load-env.js';

/**
 * One-command Hindsight Cloud smoke test.
 * Run after adding credentials to backend/.env:  npm run verify
 */
const BASE_URL = process.env.HINDSIGHT_BASE_URL || '';
const API_KEY = process.env.HINDSIGHT_API_KEY || '';
const BANK_ID = process.env.HINDSIGHT_BANK_ID || 'social-engagement-agent';

if (!BASE_URL || !API_KEY || API_KEY.includes('PASTE')) {
  console.error('✗  Missing credentials. Fill HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY in backend/.env first.');
  process.exit(1);
}

const { HindsightClient } = await import('@vectorize-io/hindsight-client');
const client = new HindsightClient({ baseUrl: BASE_URL, apiKey: API_KEY });

try {
  const v = await client.getVersion();
  console.log(`✓  Connected to Hindsight at ${BASE_URL} (api_version ${v.api_version})`);
} catch (err) {
  console.error('✗  Connection failed:', err.message);
  process.exit(1);
}

try {
  await client.createBank(BANK_ID, {
    name: 'Social Media Engagement Agent',
    mission:
      'Remember which social posts, hooks and reply styles perform best. Store post metrics as facts so recall surfaces high-CTR winners, and write A/B winning hooks back as top_hook memories.',
  });
  console.log(`✓  Bank created: ${BANK_ID}`);
} catch {
  console.log(`✓  Bank already exists (or creation skipped): ${BANK_ID}`);
}

try {
  await client.retain(BANK_ID, 'Smoke test: the Social Media Engagement Agent can retain memories in Hindsight.', {
    context: 'smoke test',
    tags: ['verify'],
    metadata: { kind: 'verify' },
  });
  console.log('✓  Retain works — memory written to Hindsight');
} catch (err) {
  console.error('✗  Retain failed:', err.message);
  process.exit(1);
}

try {
  const r = await client.recall(BANK_ID, 'engagement agent smoke test', { budget: 'low' });
  console.log(`✓  Recall works — ${r.results?.length ?? 0} result(s)`);
  console.log('\nALL GREEN ✅  Now run the server and POST /api/import to seed the bank:');
  console.log('   npm start   then   curl -X POST http://localhost:4000/api/import');
} catch (err) {
  console.error('✗  Recall failed:', err.message);
  process.exit(1);
}
