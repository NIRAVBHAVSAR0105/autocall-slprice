const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── CREDENTIALS (hardcoded for your setup) ───────────
const EXOTEL_API_KEY     = process.env.EXOTEL_API_KEY    || '58fec69a504fc318a5ab9eba00e6a7ecff8527c753df7feb';
const EXOTEL_API_TOKEN   = process.env.EXOTEL_API_TOKEN  || 'be8d6a5f56a2414d28a535004af863bcf1173626c8165575';
const EXOTEL_ACCOUNT_SID = process.env.EXOTEL_ACCOUNT_SID|| 'slprice1';
const EXOTEL_CALLER_ID   = process.env.EXOTEL_CALLER_ID  || '07948501640';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;    // free — get from aistudio.google.com
const PORT               = process.env.PORT || 3000;
const BASE_URL           = process.env.BASE_URL;          // your Render.com URL

const EXOTEL_BASE = `https://${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/${EXOTEL_ACCOUNT_SID}`;

// In-memory call log
const callLog = {};

// ─── Generate Hinglish script via Google Gemini (FREE) ─
async function generateScript(customer) {
  // If no Gemini key, fall back to smart template
  if (!GEMINI_API_KEY) return buildTemplate(customer);

  try {
    // AQ. prefix keys use x-goog-api-key header; AIza keys use ?key= param — this handles both
    const isAQKey = GEMINI_API_KEY.startsWith('AQ.');
    const url = isAQKey
      ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
      : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const headers = isAQKey
      ? { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }
      : { 'Content-Type': 'application/json' };
    const res = await axios.post(url,
      {
        contents: [{
          parts: [{
            text: `Generate a short, polite Hinglish (Hindi + English mix) payment reminder phone call script for:
Customer name: ${customer.name}
Outstanding amount: ₹${customer.outstanding}
Due since: ${customer.dueSince || 'kuch time'}
Company: SLP Price

Rules:
- Max 3 sentences only
- Warm and respectful tone
- Mix Hindi and English naturally (Hinglish)
- End with polite request to pay soon
- Only return the spoken words, no labels or stage directions
- Simple words for a phone call`
          }]
        }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.7 }
      }
    );
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || buildTemplate(customer);
  } catch (err) {
    console.error('Gemini error:', err?.response?.data || err.message);
    return buildTemplate(customer); // fallback to template
  }
}

// ─── Fallback Hinglish template (no API needed) ────────
function buildTemplate(customer) {
  const name = customer.name || 'Customer';
  const amt  = customer.outstanding || '0';
  const due  = customer.dueSince ? `jo ${customer.dueSince} se` : 'jo kaafi time se';
  return `Namaste ${name} ji! Main SLP Price ki taraf se bol raha hoon. Aapka hamare paas rupaye ${amt} ka outstanding payment ${due} pending hai. Kripya jald se jald payment kar dijiye. Bahut bahut dhanyawad!`;
}

// ─── Format phone for Exotel ──────────────────────────
function formatPhone(phone) {
  let p = phone.toString().replace(/\D/g, '');
  if (p.length === 10) p = '0' + p;
  return p;
}

// ─── ExoML — static endpoint set in Exotel App ────────
// Exotel calls this URL when customer picks up
// CallSid is passed as query param by Exotel automatically
app.get('/exoml', (req, res) => {
  const exotelSid = req.query.CallSid || req.query.callsid || '';
  const log = Object.values(callLog).find(l =>
    l.exotelSid === exotelSid || l.callId === exotelSid
  );
  const script = log?.script || buildTemplate({ name: 'ji', outstanding: 'kuch' });

  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say lang="hi" voice="female">${script}</Say>
  <Pause length="1"/>
  <Say lang="hi" voice="female">${script}</Say>
  <Say lang="hi" voice="female">Dhanyawad. Alvida!</Say>
</Response>`);
});

// ─── ExoML — dynamic per callId (backup) ──────────────
app.get('/tts/:callId', (req, res) => {
  const log = Object.values(callLog).find(l => l.callId === req.params.callId);
  const script = log?.script || buildTemplate({});
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say lang="hi" voice="female">${script}</Say>
  <Pause length="1"/>
  <Say lang="hi" voice="female">${script}</Say>
  <Say lang="hi" voice="female">Dhanyawad. Alvida!</Say>
</Response>`);
});

// ─── Exotel status callback ───────────────────────────
app.post('/callback', (req, res) => {
  const { CallSid, Status } = req.body;
  const log = Object.values(callLog).find(l => l.exotelSid === CallSid);
  if (log) log.status = Status || 'completed';
  res.sendStatus(200);
});

// ─── Make one Exotel call ─────────────────────────────
async function makeExotelCall(phone, callId) {
  const response = await axios.post(
    `${EXOTEL_BASE}/Calls/connect.json`,
    new URLSearchParams({
      'From':           formatPhone(phone),
      'CallerId':       EXOTEL_CALLER_ID,
      'Url':            `${BASE_URL}/tts/${callId}`,
      'StatusCallback': `${BASE_URL}/callback`,
      'TimeLimit':      '120',
      'TimeOut':        '30'
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data;
}

// ─── POST /api/call — single customer ─────────────────
app.post('/api/call', async (req, res) => {
  const { name, phone, outstanding, dueSince } = req.body;
  if (!phone || !name || !outstanding)
    return res.status(400).json({ error: 'name, phone, outstanding are required' });

  const callId = `call_${Date.now()}`;
  try {
    const script = await generateScript({ name, outstanding, dueSince });
    callLog[callId] = { callId, name, phone, outstanding, script, status: 'initiated', time: new Date().toISOString() };

    const data = await makeExotelCall(phone, callId);
    callLog[callId].exotelSid = data?.Call?.Sid || callId;

    res.json({ success: true, callSid: callLog[callId].exotelSid, script });
  } catch (err) {
    console.error('Call error:', err?.response?.data || err.message);
    if (callLog[callId]) callLog[callId].status = 'failed';
    res.status(500).json({ error: err?.response?.data?.RestException?.Message || err.message });
  }
});

// ─── POST /api/call-all — bulk calls ──────────────────
app.post('/api/call-all', async (req, res) => {
  const { customers } = req.body;
  if (!customers?.length)
    return res.status(400).json({ error: 'No customers provided' });

  const results = [];
  for (const c of customers) {
    await new Promise(r => setTimeout(r, 3000));
    const callId = `call_${Date.now()}`;
    try {
      const script = await generateScript(c);
      callLog[callId] = { callId, name: c.name, phone: c.phone, outstanding: c.outstanding, script, status: 'initiated', time: new Date().toISOString() };

      const data = await makeExotelCall(c.phone, callId);
      callLog[callId].exotelSid = data?.Call?.Sid || callId;

      results.push({ name: c.name, phone: c.phone, callSid: callLog[callId].exotelSid, status: 'initiated' });
    } catch (err) {
      if (callLog[callId]) callLog[callId].status = 'failed';
      results.push({ name: c.name, phone: c.phone, status: 'failed', error: err?.response?.data?.RestException?.Message || err.message });
    }
  }
  res.json({ success: true, results });
});

// ─── GET /api/logs ────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.json(Object.values(callLog).reverse());
});

// ─── GET /health ──────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  provider: 'Exotel',
  account: EXOTEL_ACCOUNT_SID,
  callerID: EXOTEL_CALLER_ID,
  scriptEngine: GEMINI_API_KEY ? 'Gemini AI (free)' : 'Hinglish Template'
}));

app.listen(PORT, () => console.log(`AutoCall ready on port ${PORT} | Exotel: ${EXOTEL_ACCOUNT_SID} | Script: ${GEMINI_API_KEY ? 'Gemini' : 'Template'}`));
