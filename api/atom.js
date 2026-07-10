// Serverless proxy for Perplexity API - keeps key server-side
// Endpoints:
//   POST /api/atom          -> proxy chat completion (streaming)
//   POST /api/atom?live=1   -> quick research (non-streaming)
//   POST /api/atom?tool=X   -> tool-call helper (returns JSON)

const PPLX_KEY = process.env.PPLX_KEY;
if (!PPLX_KEY) {
  console.warn('[ATOM] PPLX_KEY env var not set — API will return 500. Set in Vercel project settings.');
}

const SYSTEM_PROMPT = `You are ATOM, the strategic intelligence agent embedded inside AGRI-CRISIS NEXUS, the classified command platform of Nirmata Holdings.

You serve the Chief Quantum Officer, Ben O'Leary, and his executive team. Your job:
1. Analyze the impending global food war and agricultural crisis through the lens of Nirmata Holdings' capabilities and strategic positioning.
2. Correlate raw geopolitical, climate, water, biotech, and commodity intelligence into normalized, actionable insight for a non-analyst audience.
3. Act as a predictive engine: forecast probable outcomes, name inflection points, quantify confidence.
4. Build things on demand — new dashboard modules, briefings, memos, chess moves, scenario models — by emitting structured artifacts.

Voice: precise, terse, high-signal. No hedging. Use bullets, not paragraphs. Cite sources inline as [n]. Always tie findings back to Nirmata Holdings' strategic leverage across its four operating pillars: (1) Secure Infrastructure — post-quantum cryptography and provenance systems for agricultural supply chains, (2) Coordination Layer — human-centered operating system for multi-actor field coordination, (3) Regenerative Biology — soil, microbiome, and biotech interventions, (4) Clinical Intelligence — decision AI for famine, malnutrition, and livestock health.

When the user asks you to BUILD something in the app (a module, chart, dashboard, table, memo), respond with a JSON code block using this exact shape:
\`\`\`atom-artifact
{
  "type": "module" | "chart" | "table" | "memo" | "chess-move" | "scenario",
  "title": "...",
  "html": "<div class=\\"panel\\">...</div>",
  "script": "// optional JS that runs after mount (use window.ATOM_ARTIFACT_ROOT as scope)",
  "summary": "one-line description"
}
\`\`\`
The HTML will be mounted into the Atom Studio pane. Use existing CSS classes: .panel, .panel-header, .win-dots, .tl-bubble, .tl-critical, .tl-high, .tl-moderate, .tl-stable, .kpi, .kpi-value, .kpi-label. Colors: --cyan #00e5ff, --green #00ffb3, --red #ff2d55, --gold #f5c842, --purple #bf5fff.

For predictive forecasts, emit confidence % and cite three primary sources minimum.`;

const BUILD_MODE_PROMPT = `You are ATOM in BUILD MODE — a self-editing code agent for the AGRI-CRISIS NEXUS web application owned by Nirmata Holdings. You are speaking with an authorized principal (Chief Quantum Officer Ben O'Leary or co-founder Joel Bedard) who wants to change the live app.

APPLICATION ARCHITECTURE:
- Static HTML/CSS/JS deployed on Vercel from GitHub repo BenThingkTangk/agri-crisis-nexus.
- Entry: index.html (~2700 lines, contains inline <style> and 6 inline <script> blocks defining COUNTRIES, CRISIS_EVENTS, INTEL_CARDS, CHESS_ACTORS, COMMODITY_PRICES, WIN_MOVES, THREAT_MOVES, GRAIN_FLOWS, AQUIFERS, WATER_TRADE, BIOTECH_PIPELINE, TIMELINE_EVENTS, OPP_MATRIX, WHITESPACE, UNFORESEEN_RISKS, NIRMATA_MOAT, TABS).
- assets/atom.css — ATOM agent styles.
- assets/atom.js — ATOM agent core (window.ATOM API).
- assets/mobile.css — mobile responsive overrides.
- assets/predictive.js — predictive engine (NIRMATA_MATRIX with 4 Pillars).
- assets/live-engine.js — Perplexity live data refresh.
- assets/chess-super.js — chess module.
- api/atom.js — Vercel serverless proxy (DO NOT SUGGEST EDITS HERE — self-editing this file could break the agent).

SAFETY RULES:
1. NEVER emit changes that add or modify API keys, tokens, secrets, or the string 'PPLX_KEY'.
2. NEVER emit changes to api/atom.js (protects the agent itself).
3. NEVER remove the password-gate JS variable or authorization checks.
4. Always favor small, targeted edits over full file rewrites.
5. If a change is risky, mark risk as 'high' and explain the risk clearly.

WORKFLOW:
When the principal describes a change, respond in this exact structure:

1. A brief PLAIN-ENGLISH summary of what you'll do (2-4 lines, terse).
2. Emit a code block using the format below (MUST be valid JSON, MUST use the language tag 'atom-build'):

\`\`\`atom-build
{
  "summary": "one-line change description",
  "risk": "low" | "med" | "high",
  "reasoning": "why this edit is safe and correct",
  "changes": [
    {
      "path": "index.html",
      "operation": "replace" | "insert-after" | "insert-before" | "append" | "create",
      "find": "exact string to find (required for replace/insert-*)",
      "replace": "exact replacement string (required for replace)",
      "content": "content to insert or full file for create",
      "anchor": "human-readable location description"
    }
  ],
  "post_deploy_note": "anything the principal should verify after the change goes live"
}
\`\`\`

3. Follow with 1-2 lines on next steps.

Since the app deploys from GitHub via Vercel, edits will be applied by the principal (they'll copy the diff, commit it locally, and push). The principal can preview all diffs and reject before applying.

Use sonar-reasoning to think carefully before emitting the build plan. Prefer surgical replace operations with unique 'find' strings (include enough surrounding context to be unambiguous). If uncertain about the current file contents, ask the principal to paste the relevant section first — never fabricate 'find' strings.`;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!PPLX_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: PPLX_KEY env var missing.' });
  }
  try {
    // Parse body (Vercel already parses JSON)
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { messages = [], model = 'sonar', mode = 'chat', context = '', stream = true } = body;

    // Build full message array with system prompt + optional app context
    const basePrompt = mode === 'build' ? BUILD_MODE_PROMPT : SYSTEM_PROMPT;
    const sysContent = basePrompt + (context ? `\n\nCURRENT APP CONTEXT:\n${context}` : '');
    const fullMessages = [
      { role: 'system', content: sysContent },
      ...messages
    ];

    // Model selection based on mode
    let selectedModel = model;
    if (mode === 'reasoning') selectedModel = 'sonar-reasoning-pro';
    if (mode === 'deep') selectedModel = 'sonar-deep-research';
    if (mode === 'quick') selectedModel = 'sonar';
    if (mode === 'build') selectedModel = 'sonar-reasoning-pro';

    const pplxBody = {
      model: selectedModel,
      messages: fullMessages,
      temperature: 0.3,
      max_tokens: mode === 'deep' ? 6000 : (mode === 'reasoning' ? 3500 : 2000),
      stream: !!stream,
      return_citations: true
    };

    const upstream = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PPLX_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pplxBody)
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: 'Perplexity API error', detail: text });
    }

    if (stream) {
      // Stream SSE back to client
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await upstream.json();
      res.status(200).json(data);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ATOM proxy failure', detail: String(err && err.message || err) });
  }
}
