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
PPLX_KEY = pplx-...   # Perplexity API key
```

If unset, falls back to embedded key (dev only).

## Stack

Vanilla JS · Leaflet · Chart.js · D3 · GSAP · Perplexity Sonar (chat / reasoning / deep research)
