#!/usr/bin/env node
/**
 * gmail-auth.mjs — One-time OAuth2 setup for Gmail API
 *
 * Run this ONCE to authorize Gmail access. It saves a token to gmail-token.json
 * which gmail-sync.mjs will use for all future runs.
 *
 * Prerequisites:
 *   1. Go to Google Cloud Console → APIs → Gmail API → Enable
 *   2. Create credentials: OAuth 2.0 Client ID (Desktop app type)
 *   3. Download as JSON → save as gmail-credentials.json in this directory
 *   4. Run: node gmail-auth.mjs
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { config } from 'dotenv';

config();

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || 'gmail-credentials.json';
const TOKEN_PATH        = process.env.GMAIL_TOKEN_PATH        || 'gmail-token.json';
const SCOPES            = ['https://www.googleapis.com/auth/gmail.readonly'];

if (!existsSync(CREDENTIALS_PATH)) {
  console.error(`\nMissing: ${CREDENTIALS_PATH}`);
  console.error('Steps:');
  console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
  console.error('  2. Create OAuth 2.0 Client ID → Desktop app');
  console.error('  3. Download JSON → save as gmail-credentials.json here');
  console.error('  4. Re-run: node gmail-auth.mjs\n');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
console.log('\nOpen this URL in your browser to authorize:\n');
console.log(authUrl);
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the authorization code here: ', async code => {
  rl.close();
  try {
    const { tokens } = await oAuth2.getToken(code.trim());
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`\nToken saved to ${TOKEN_PATH}`);
    console.log('You can now run: node gmail-sync.mjs\n');
  } catch (e) {
    console.error('Error getting token:', e.message);
    process.exit(1);
  }
});
