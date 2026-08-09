import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { ROOT } from './config.js';

/**
 * OAuth 2.0 for an installed ("Desktop app") client.
 *
 * The out-of-band flow that used to make headless auth easy was removed by
 * Google in 2022, so the only supported route is a loopback redirect. That's
 * awkward when the code runs on a remote container and the browser is on your
 * laptop — the redirect lands on *your* machine, not this one.
 *
 * So we do both at once: start a listener on 127.0.0.1 in case the browser is
 * local, and simultaneously accept the redirected URL pasted on stdin for when
 * it isn't. Whichever arrives first wins. The pasted-URL path works even though
 * the browser shows a connection error, because the authorisation code is in
 * the address bar regardless of whether anything answered.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const SCOPES = [
  // Upload only. Deliberately not requesting write access to the rest of the
  // channel — this tool has no reason to be able to delete or edit anything.
  'https://www.googleapis.com/auth/youtube.upload',
  // Read-only, purely so we can print which channel is about to receive the
  // upload before doing it.
  'https://www.googleapis.com/auth/youtube.readonly',
];

const CREDENTIALS_FILE = path.join(ROOT, '.credentials.json');

function clientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.\n' +
        '  Create an OAuth client (type: Desktop app) at\n' +
        '  https://console.cloud.google.com/apis/credentials and put both in .env'
    );
  }
  return { clientId, clientSecret };
}

export function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  // Tokens are as good as a password for the upload scope.
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

export function hasCredentials() {
  const creds = loadCredentials();
  return Boolean(creds && creds.refresh_token);
}

function buildAuthUrl(clientId, redirectUri) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  // offline + consent is what actually returns a refresh_token. Without
  // prompt=consent Google omits it on re-authorisation and the next run fails
  // in a way that looks like a bug in this code.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`token request failed: ${detail}`);
  }
  return body;
}

function extractCode(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept either a full redirect URL or a bare code.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const error = parsed.searchParams.get('error');
      if (error) throw new Error(`authorisation denied: ${error}`);
      return parsed.searchParams.get('code');
    } catch (err) {
      if (err.message.startsWith('authorisation denied')) throw err;
      return null;
    }
  }
  return trimmed;
}

/** Listen on a random loopback port; resolve if the browser lands here. */
function startLoopbackListener() {
  let resolveCode;
  let server;
  const codePromise = new Promise((resolve) => {
    resolveCode = resolve;
  });

  const ready = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const code = parsed.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        code
          ? '<html><body style="font-family:system-ui;padding:3rem"><h2>Authorised.</h2><p>You can close this tab and return to the terminal.</p></body></html>'
          : '<html><body style="font-family:system-ui;padding:3rem"><h2>No authorisation code in this request.</h2></body></html>'
      );
      if (code) resolveCode(code);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    ready,
    codePromise,
    close: () => server && server.close(),
  };
}

function promptForRedirect() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const promise = new Promise((resolve) => {
    rl.question('  Paste the full redirect URL (or just the code): ', (answer) => resolve(answer));
  });
  return { promise, close: () => rl.close() };
}

export async function authorize() {
  const { clientId, clientSecret } = clientConfig();

  let listener = null;
  let port = null;
  try {
    listener = startLoopbackListener();
    port = await listener.ready;
  } catch {
    listener = null;
  }

  // Google allows any port on the loopback address for Desktop app clients, so
  // a random port needs no registration. If we could not bind at all we still
  // need a redirect_uri that matches, so fall back to a fixed conventional one.
  const redirectUri = `http://127.0.0.1:${port || 8080}`;
  const authUrl = buildAuthUrl(clientId, redirectUri);

  console.log('\n  Open this URL in a browser and approve access:\n');
  console.log(`  ${authUrl}\n`);
  if (port) {
    console.log('  If the browser is on this machine, it will redirect automatically.');
  }
  console.log('  If the browser shows "site can\'t be reached" after approving,');
  console.log('  that is expected on a remote machine — copy the URL from the');
  console.log('  address bar and paste it below.\n');

  const prompt = promptForRedirect();
  let code;
  try {
    const raw = await Promise.race([
      listener ? listener.codePromise : new Promise(() => {}),
      prompt.promise,
    ]);
    code = extractCode(raw);
  } finally {
    prompt.close();
    if (listener) listener.close();
  }

  if (!code) throw new Error('no authorisation code received');

  const token = await postForm(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  if (!token.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke this app at\n' +
        '  https://myaccount.google.com/permissions and run auth again.'
    );
  }

  const creds = {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: Date.now() + (token.expires_in || 3600) * 1000,
    scope: token.scope,
  };
  saveCredentials(creds);
  return creds;
}

/** Return a valid access token, refreshing when it is close to expiry. */
export async function getAccessToken() {
  const { clientId, clientSecret } = clientConfig();
  const creds = loadCredentials();
  if (!creds || !creds.refresh_token) {
    throw new Error('not authorised yet — run: npm run auth');
  }

  // 60s of slack so a token cannot expire mid-upload.
  if (creds.access_token && creds.expires_at && creds.expires_at - Date.now() > 60_000) {
    return creds.access_token;
  }

  const token = await postForm(TOKEN_URL, {
    refresh_token: creds.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const updated = {
    ...creds,
    access_token: token.access_token,
    expires_at: Date.now() + (token.expires_in || 3600) * 1000,
  };
  saveCredentials(updated);
  return updated.access_token;
}

export { CREDENTIALS_FILE, extractCode };
