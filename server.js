const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const EXOTEL_API_KEY     = process.env.EXOTEL_API_KEY    || '58fec69a504fc318a5ab9eba00e6a7ecff8527c753df7feb';
const EXOTEL_API_TOKEN   = process.env.EXOTEL_API_TOKEN  || 'be8d6a5f56a2414d28a535004af863bcf1173626c8165575';
const EXOTEL_ACCOUNT_SID = process.env.EXOTEL_ACCOUNT_SID|| 'slprice1';
const EXOTEL_CALLER_ID   = process.env.EXOTEL_CALLER_ID  || '07948501640';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const PORT               = process.env.PORT || 3000;
const BASE_URL           = process.env.BASE_URL;

const EXOTEL_BASE = `https://${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/${EXOTEL_ACCOUNT_SID}`;

// Store scripts by phone number — survives across calls in same session
const scriptStore = {};
const callLog = {};

async function generateScript(customer) {
  if (!GEMINI_API_KEY) return buildTemplate(customer);
  try {
    const isAQKey = GEMINI_API_KEY.startsWith('AQ.');
    const url = isAQKey
      ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
      : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const headers = isAQKey
      ? { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }
      : { 'Content-Type': 'application/json' };
    const res = await axios.post(url, {
      contents: [{ parts: [{ text: `Generate a short Hinglish payment reminder for phone call:
Customer: ${customer.name}, Amount: Rs ${customer.outstanding}, Company: SLP Price
- Max 2 sentences
- Warm Hinglish (Hindi+English mix)
- Only spoken words, no labels` }] }],
      generationConfig: { maxOutputTokens: 150, temperature: 0.7 }
    }, { headers });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || buildTemplate(customer);
  } catch (err) {
    console.error('Gemini error:', err?.response?.data || err.message);
    return buildTemplate(customer);
  }
}

function buildTemplate(customer) {
  const name = customer.name || 'aap';
  const amt  = customer.outstanding || 'kuch';
  return `Namaste ${name} ji! Main SLP Price ki taraf se bol raha hoon. Aapka hamare paas rupaye ${amt} ka outstanding payment pending hai. Kripya jald se jald payment kar dijiye. Dhanyawad!`;
}

function formatPhone(phone) {
  let p = phone.toString().replace(/\D/g, '');
  if (p.length === 10) p = '0' + p;
  return p;
}

// ─── /exoml — Exotel fetches this when call connects ──
// Looks up script by phone number (CallFrom param sent by Exotel)
app.get('/exoml', (req, res) => {
  console.log('ExoML hit, query:', JSON.stringify(req.query));
  const callFrom = (req.query.CallFrom || req.query.callfrom || '').replace(/\D/g, '');
  const last10 = callFrom.slice(-10);

  // Find script stored for this phone number
  const script = scriptStore[last10] || scriptStore[callFrom] || buildTemplate({ name: 'aap', outstanding: 'outstanding' });
  console.log('Script for', last10, ':', script);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Namaste! Yeh S L P Price ki taraf se ek important call hai.</Say><Pause length="1"/><Say>${script}</Say><Pause length="2"/><Say>${script}</Say><Say>Dhanyawad. Alvida!</Say></Response>`);
});

app.post('/callback', (req, res) => {
  console.log('Callback:', req.body);
  res.sendStatus(200);
});

// ─── Single call ──────────────────────────────────────
app.post('/api/call', async (req, res) => {
  const { name, phone, outstanding, dueSince } = req.body;
  if (!phone || !name || !outstanding)
    return res.status(400).json({ error: 'name, phone, outstanding required' });

  const callId = `call_${Date.now()}`;
  const cleanPhone = phone.toString().replace(/\D/g, '').slice(-10);

  try {
    const script = await generateScript({ name, outstanding, dueSince });

    // Store script by phone number so /exoml can retrieve it
    scriptStore[cleanPhone] = script;
    console.log('Stored script for', cleanPhone, ':', script);

    callLog[callId] = { callId, name, phone: cleanPhone, outstanding, script, status: 'initiated', time: new Date().toISOString() };

    const response = await axios.post(
      `${EXOTEL_BASE}/Calls/connect.json`,
      new URLSearchParams({
        'From':           formatPhone(phone),
        'CallerId':       EXOTEL_CALLER_ID,
        'Url':            `${BASE_URL}/exoml`,
        'StatusCallback': `${BASE_URL}/callback`,
        'TimeLimit':      '120',
        'TimeOut':        '30'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    callLog[callId].exotelSid = response.data?.Call?.Sid || callId;
    res.json({ success: true, callSid: callLog[callId].exotelSid, script });
  } catch (err) {
    console.error('Call error:', err?.response?.data || err.message);
    if (callLog[callId]) callLog[callId].status = 'failed';
    res.status(500).json({ error: err?.response?.data?.RestException?.Message || err.message });
  }
});

// ─── Bulk calls ───────────────────────────────────────
app.post('/api/call-all', async (req, res) => {
  const { customers } = req.body;
  if (!customers?.length) return res.status(400).json({ error: 'No customers' });

  const results = [];
  for (const c of customers) {
    await new Promise(r => setTimeout(r, 3000));
    const callId = `call_${Date.now()}`;
    const cleanPhone = c.phone.toString().replace(/\D/g, '').slice(-10);
    try {
      const script = await generateScript(c);
      scriptStore[cleanPhone] = script;

      callLog[callId] = { callId, name: c.name, phone: cleanPhone, outstanding: c.outstanding, script, status: 'initiated', time: new Date().toISOString() };

      const response = await axios.post(
        `${EXOTEL_BASE}/Calls/connect.json`,
        new URLSearchParams({
          'From':           formatPhone(c.phone),
          'CallerId':       EXOTEL_CALLER_ID,
          'Url':            `${BASE_URL}/exoml`,
          'StatusCallback': `${BASE_URL}/callback`,
          'TimeLimit':      '120',
          'TimeOut':        '30'
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      callLog[callId].exotelSid = response.data?.Call?.Sid || callId;
      results.push({ name: c.name, phone: cleanPhone, status: 'initiated' });
    } catch (err) {
      if (callLog[callId]) callLog[callId].status = 'failed';
      results.push({ name: c.name, phone: cleanPhone, status: 'failed', error: err?.response?.data?.RestException?.Message || err.message });
    }
  }
  res.json({ success: true, results });
});

app.get('/api/logs', (req, res) => res.json(Object.values(callLog).reverse()));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  provider: 'Exotel',
  account: EXOTEL_ACCOUNT_SID,
  callerID: EXOTEL_CALLER_ID,
  scriptEngine: GEMINI_API_KEY ? 'Gemini AI' : 'Template',
  exomlUrl: `${BASE_URL}/exoml`
}));

app.listen(PORT, () => console.log(`AutoCall v3 Server on port ${PORT}`));
