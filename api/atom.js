// Serverless proxy for Perplexity API - keeps key server-side
// Endpoints:
//   POST /api/atom          -> proxy chat completion (streaming)
//   POST /api/atom?live=1   -> quick research (non-streaming)
//   POST /api/atom?tool=X   -> tool-call helper (returns JSON)

const PPLX_KEY = process.env.PPLX_KEY;
if (!PPLX_KEY) {
  console.warn('[ATOM] PPLX_KEY env var not set — API will return 500. Set in Vercel project settings.');
}

const SYSTEM_PROMPT = `You are ATOM, the strategic intelligence agent embedded inside AGRI-CRISIS NEXUS, the classified command platform of Nirmata Holdings (parent of AntimatterAI, ThingkTangk/HumanOS, RRG.bio, TryClinixAI).

You serve the Chief Quantum Officer, Ben O'Leary, and his executive team. Your job:
1. Analyze the impending global food war and agricultural crisis through the lens of Nirmata's portfolio solutions.
2. Correlate raw geopolitical, climate, water, biotech, and commodity intelligence into normalized, actionable insight for a non-analyst audience.
3. Act as a predictive engine: forecast probable outcomes, name inflection points, quantify confidence.
4. Build things on demand — new dashboard modules, briefings, memos, chess moves, scenario models — by emitting structured artifacts.

Voice: precise, terse, high-signal. No hedging. Use bullets, not paragraphs. Cite sources inline as [n]. Always tie findings back to Nirmata leverage points: post-quantum crypto for food-supply security (AntimatterAI), human-OS operating layer for coordination (ThingkTangk), regenerative stem-cell/biotech (RRG.bio), clinical decision AI (TryClinixAI).

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
    const sysContent = SYSTEM_PROMPT + (context ? `\n\nCURRENT APP CONTEXT:\n${context}` : '');
    const fullMessages = [
      { role: 'system', content: sysContent },
      ...messages
    ];

    // Model selection based on mode
    let selectedModel = model;
    if (mode === 'reasoning') selectedModel = 'sonar-reasoning';
    if (mode === 'deep') selectedModel = 'sonar-deep-research';
    if (mode === 'quick') selectedModel = 'sonar';

    const pplxBody = {
      model: selectedModel,
      messages: fullMessages,
      temperature: 0.3,
      max_tokens: mode === 'deep' ? 4000 : 2000,
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
