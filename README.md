# AGRI·CRISIS NEXUS

**Strategic Intelligence Platform · Nirmata Holdings · CQO Eyes Only**

Category-defining agricultural crisis intelligence + predictive engine + embedded ATOM AI agent, all powered by Perplexity Sonar and Nirmata Holdings' proprietary correlation matrix.

## Modules

1. Global Crisis Command Map
2. Tactical Threat Radar
3. Geopolitical Chess Board (live moves + ATOM strategist)
4. Live Intelligence Feed (real-time via Perplexity)
5. Data Suite
6. Impact Pulse (sentiment force graph + resilience list)
7. Global Status Board (traffic-light bubble grid)
8. Water & Aquifer Intelligence
9. Biotech Pipeline
10. Strategic Timeline 2020–2050
11. Ops Matrix (+ Predictive Engine + Nirmata Leverage Map + Scenario Sandbox + ATOM Studio)

## ATOM Agent

Click the ATOM orb (bottom-right, or press **⌘K** / **A**) to invoke your strategic agent. Modes:

- **CHAT** — day-to-day analyst mode
- **REASONING** — multi-step strategic reasoning (sonar-reasoning)
- **DEEP RESEARCH** — comprehensive briefings (sonar-deep-research)
- **QUICK** — snap facts (sonar)

ATOM can build things inside the app — try:
- "Build me a memo comparing 2026 shocks to 1973 oil crisis"
- "Predict wheat price if Black Sea corridor collapses"
- "Correlate current Sahel food crisis to Nirmata Holdings' Regenerative Biology and Clinical Intelligence pillars"

## Live Data Engine

Continuous refresh (2–15 min intervals) via Perplexity Sonar for:
wheat / corn / rice / FFPI / breaking headlines / IPC hotspots / chess moves.

## Deployment

- Frontend: static `index.html` + `/assets/*`
- API: `/api/atom.js` (Vercel serverless) — proxies Perplexity API server-side, key never exposed to client
- Password: JS variable (no localStorage — sandbox-safe)

## Environment

Set on Vercel:

```
PPLX_KEY = pplx-...   # Perplexity API key (server-side only)
```

If unset, falls back to embedded key (dev only).

### Account authentication (operator sign-in)

The topbar **Sign in** opens server-validated account authentication for the
initial Nirmata Holdings operators. This is separate from the outer platform
access gate and from the DB-backed team collaboration layer. Sessions are
short-lived (default 8h, max 12h), signed, tamper-evident bearer tokens held
only in browser memory (no cookie, no localStorage) and replayed via the
`Authorization: Bearer` header, so a page reload requires signing in again.

Two server-side env vars drive it — **never commit real values, and never put
raw passwords anywhere**:

```
AGRIOS_SESSION_SECRET = <random string, >= 32 chars>   # HMAC signing key for session tokens
AGRIOS_AUTH_USERS_JSON = [ {user record}, {user record} ]   # see format below
```

`AGRIOS_AUTH_USERS_JSON` is a JSON array (a `{ "users": [...] }` wrapper object
is also accepted). Each record:

```json
{
  "email": "operator@nirmata.example",   // normalized lowercase; used as the login id
  "name":  "Display Name",                // 1-80 chars, shown in the identity menu
  "role":  "owner",                        // "owner" (high-impact actions) or "operator"
  "salt":  "<hex, >= 16 bytes>",          // per-user scrypt salt
  "hash":  "<hex, 64-byte scrypt output>" // scrypt(password, salt, N=16384,r=8,p=1,keylen=64)
}
```

Roles:
- **owner** — full operator access **plus** high-impact actions such as the
  manual live-feed refresh (`POST /api/intel?action=refresh`). Enforced
  server-side via the bearer verifier, not just in the UI.
- **operator** — standard mission/intelligence access.

#### Generating records (never type raw passwords into files or argv)

Use the helper, which reads the password **only from stdin** and prints only
the non-secret derivation material (email/name/role/salt/hash):

```
node scripts/hash-user.mjs --email ben@nirmata.example  --name "Ben"  --role owner
node scripts/hash-user.mjs --email joel@nirmata.example --name "Joel" --role operator
```

(Or pipe non-interactively: `printf '%s' "$PW" | node scripts/hash-user.mjs --email … --name … --role …`.)

Wrap the two emitted objects in an array and paste as `AGRIOS_AUTH_USERS_JSON`:

```
AGRIOS_AUTH_USERS_JSON=[{...ben record...},{...joel record...}]
```

#### Rotation / revocation procedure

1. Generate a new record for the affected user with `scripts/hash-user.mjs`.
2. Replace that user's object in `AGRIOS_AUTH_USERS_JSON` (Vercel → Project →
   Settings → Environment Variables) and redeploy. Old passwords stop working
   immediately on the new deployment.
3. To force all existing sessions to expire on next verification, rotate
   `AGRIOS_SESSION_SECRET` as well — every previously issued token fails its
   signature check. (Tokens are short-lived regardless, ≤ 12h.)
4. To remove a user entirely, delete their object from the array and redeploy.

If either env var is missing or malformed, sign-in returns a single generic
"temporarily unavailable" response — the app never reveals which piece of
config is absent, and the rest of the platform (public feeds, bundled intel)
remains operational.

## Stack

Vanilla JS · Leaflet · Chart.js · D3 · GSAP · Perplexity Sonar (chat / reasoning / deep research)
