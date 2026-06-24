const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The burn account every registrant transfers 1 Usernode token to.
const BURN_ADDRESS = 'ut1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvpm4ee';
// App namespace + action carried in the on-chain memo (verbatim from the
// product request). We verify these fields rather than an exact string match.
const APP_NAMESPACE = 'binier/crypto_predictions';
const REGISTER_ACTION = 'register';
// Off-chain tokens granted on registration.
const STARTING_BALANCE = 1000;

// Upstream public block explorer the `/explorer-api/*` proxy forwards to.
// Configurable; defaults to the platform's hosted explorer.
const EXPLORER_UPSTREAM = (
  process.env.EXPLORER_UPSTREAM ||
  'https://social-vibecoding.usernodelabs.org/explorer-api'
).replace(/\/$/, '');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);
// Public path prefixes that bypass the JWT gate. `/explorer-api/*` is a
// transparent proxy to the public block explorer — gating it blocks the
// bridge's inclusion polling from inside the iframe (which has no token to
// forward) and adds zero security since anyone can hit the upstream directly.
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Transparent proxy to the public block explorer. The bridge polls this from
// inside the iframe (where it has no platform token) to wait for transaction
// inclusion. Forwards method, path suffix, query and JSON body unchanged; no
// platform token is attached because the explorer is public.
app.all('/explorer-api/*', async (req, res) => {
  try {
    const suffix = req.originalUrl.replace(/^\/explorer-api/, '');
    const url = EXPLORER_UPSTREAM + suffix;
    const init = {
      method: req.method,
      headers: { 'content-type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = JSON.stringify(req.body || {});
    }
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'explorer upstream unreachable', detail: err.message });
  }
});

// --- Registration helpers ---------------------------------------------------

function memoIsRegister(memo) {
  if (!memo) return false;
  try {
    const obj = typeof memo === 'string' ? JSON.parse(memo) : memo;
    return obj && obj.app === APP_NAMESPACE && obj.action === REGISTER_ACTION;
  } catch {
    return false;
  }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

function txId(tx) {
  return pick(tx, ['tx_id', 'txid', 'txId', 'hash', 'tx_hash', 'txHash', 'id']);
}
function txDestination(tx) {
  return pick(tx, ['destination_pubkey', 'destination', 'to']);
}
function txSender(tx) {
  return pick(tx, ['from_pubkey', 'source', 'from', 'sender']);
}

function normalizeTransactions(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.transactions)) return body.transactions;
  if (body.data && Array.isArray(body.data.items)) return body.data.items;
  return [];
}

// Query the explorer (server-side, public) for the sender's recent
// transactions and find the one matching `txHash` that is a valid burn-to-
// register transfer from this exact sender. Returns the matched tx or null.
async function verifyRegistrationTx(pubkey, txHash) {
  const url = EXPLORER_UPSTREAM + '/getTransactions';
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: pubkey, limit: 50 }),
  });
  if (!upstream.ok) return null;
  const body = await upstream.json().catch(() => null);
  const txs = normalizeTransactions(body);
  for (const tx of txs) {
    if (txHash && String(txId(tx)) !== String(txHash)) continue;
    if (txDestination(tx) !== BURN_ADDRESS) continue;
    if (txSender(tx) !== pubkey) continue;
    if (!memoIsRegister(tx.memo)) continue;
    return tx;
  }
  return null;
}

async function getRegistration(userId) {
  const { rows } = await pool.query(
    `SELECT r.user_id, r.username, r.usernode_pubkey, r.registered_at,
            COALESCE(b.balance, 0) AS balance
       FROM registrations r
       LEFT JOIN token_balances b ON b.user_id = r.user_id
      WHERE r.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function insertRegistration({ userId, username, pubkey, txHash, memo, amount }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO registrations (user_id, username, usernode_pubkey, tx_hash, memo, amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, username, pubkey, txHash, memo, amount]
    );
    await client.query(
      `INSERT INTO token_balances (user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, STARTING_BALANCE]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- API routes -------------------------------------------------------------

// Current user's registration status + balance.
app.get('/api/me', async (req, res) => {
  try {
    const reg = await getRegistration(req.user.id);
    res.json({
      registered: !!reg,
      balance: reg ? Number(reg.balance) : 0,
      username: req.user.username,
      usernode_pubkey: req.user.usernode_pubkey || null,
      burnAddress: BURN_ADDRESS,
      staging: IS_STAGING,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm a registration burn transfer. The frontend-reported tx hash is
// never trusted on its own — we re-verify the transfer on-chain server-side.
app.post('/api/register/confirm', async (req, res) => {
  try {
    const pubkey = req.user.usernode_pubkey;

    // Already registered? Idempotent — return existing state.
    const existing = await getRegistration(req.user.id);
    if (existing) {
      return res.json({
        registered: true,
        balance: Number(existing.balance),
        username: existing.username,
        usernode_pubkey: existing.usernode_pubkey,
        burnAddress: BURN_ADDRESS,
        staging: IS_STAGING,
      });
    }

    if (!pubkey) {
      return res.status(400).json({ error: 'No linked Usernode wallet to verify against.' });
    }

    // Verify the burn transfer on-chain — the same path in staging and
    // production. Staging exercises the real bridge send + explorer
    // verification; nothing is granted without a matching on-chain transfer.
    const txHash = (req.body && req.body.tx_hash) || null;
    const matched = await verifyRegistrationTx(pubkey, txHash);
    if (!matched) {
      return res.status(422).json({ error: "Couldn't verify your registration transfer. Please try again." });
    }
    await insertRegistration({
      userId: req.user.id,
      username: req.user.username,
      pubkey,
      txHash: String(txId(matched)),
      memo: typeof matched.memo === 'string' ? matched.memo : JSON.stringify(matched.memo),
      amount: pick(matched, ['amount', 'value']) ?? 1,
    });

    const reg = await getRegistration(req.user.id);
    res.json({
      registered: true,
      balance: reg ? Number(reg.balance) : STARTING_BALANCE,
      username: req.user.username,
      usernode_pubkey: pubkey,
      burnAddress: BURN_ADDRESS,
      staging: IS_STAGING,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // registrations: one row per registered platform user. Holds account /
  // financial material → private (staging gets schema only, no rows).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      usernode_pubkey VARCHAR(255) NOT NULL UNIQUE,
      tx_hash VARCHAR(255) NOT NULL UNIQUE,
      memo TEXT,
      amount NUMERIC,
      registered_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE registrations IS 'staging:private'`);

  // token_balances: off-chain platform token balance per registered user.
  // Financial data → private. FK to registrations is private→private (allowed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_balances (
      user_id INTEGER PRIMARY KEY REFERENCES registrations(user_id),
      balance BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE token_balances IS 'staging:private'`);

  // Staging-only seed: one obviously-fake registered user so the private
  // tables aren't empty for inspection. Idempotent; strictly a no-op in prod.
  if (IS_STAGING) {
    await pool.query(
      `INSERT INTO registrations (user_id, username, usernode_pubkey, tx_hash, memo, amount)
       VALUES (900001, 'Staging demo Trader', 'ut1demo000000000000000000000000000000000000000000demo', 'staging-demo-tx-1', $1, 1)
       ON CONFLICT (user_id) DO NOTHING`,
      [JSON.stringify({ app: APP_NAMESPACE, action: REGISTER_ACTION })]
    );
    await pool.query(
      `INSERT INTO token_balances (user_id, balance)
       VALUES (900001, ${STARTING_BALANCE})
       ON CONFLICT (user_id) DO NOTHING`
    );
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
