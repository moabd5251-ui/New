#!/usr/bin/env node
import { loadEnv } from './config.js';
import { authorize, hasCredentials, CREDENTIALS_FILE, SCOPES } from './google-auth.js';
import { getChannel } from './youtube.js';

loadEnv();

async function main() {
  const force = process.argv.includes('--force');

  if (hasCredentials() && !force) {
    console.log('\n  Already authorised.');
    try {
      const channel = await getChannel();
      if (channel) console.log(`  Channel: ${channel.title} (${channel.id})`);
    } catch (err) {
      console.log(`  ! could not read channel: ${err.message}`);
      console.log('  Run with --force to re-authorise.');
      process.exit(1);
    }
    console.log('  Re-run with --force to authorise a different account.\n');
    return;
  }

  console.log('\n  Authorising YouTube upload access.');
  console.log('  Scopes requested:');
  for (const scope of SCOPES) console.log(`    ${scope.replace('https://www.googleapis.com/auth/', '')}`);

  await authorize();

  const channel = await getChannel();
  console.log(`\n  Authorised: ${channel ? `${channel.title} (${channel.id})` : 'unknown channel'}`);
  console.log(`  Token stored at ${CREDENTIALS_FILE} (gitignored, mode 600)\n`);

  console.log('  Before you upload, read this:');
  console.log('  Videos uploaded through an API project that has not passed');
  console.log('  Google\'s audit are locked to private permanently, and the lock');
  console.log('  cannot be appealed. See the "Verification" section of the README.\n');
}

main().catch((err) => {
  console.error(`\n  auth failed: ${err.message}\n`);
  process.exit(1);
});
