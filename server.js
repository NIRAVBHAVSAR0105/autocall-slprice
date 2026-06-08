const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const EXOTEL_API_KEY     = '58fec69a504fc318a5ab9eba00e6a7ecff8527c753df7feb';
const EXOTEL_API_TOKEN   = 'be8d6a5f56a2414d28a535004af863bcf1173626c8165575';
const EXOTEL_ACCOUNT_SID = 'slprice1';
const EXOTEL_CALLER_ID   = '07948501640';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const PORT               = process.env.PORT || 3000;
const BASE_URL           = process.env.BASE_URL || 'https://autocall-slprice.onrender.com';
const EXOTEL_BASE        = `https://${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}@api.exotel.com/v1/Accounts/${EXOTEL_ACCOUNT_SID}`;

const scriptStore = {};
const callLog = {};

// ─── Serve frontend FIRST ────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Generate Hinglish script ─────────────────────────
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
      contents: [{ parts: [{ text: `Generate a short Hinglish payment reminder for a phone call.
Customer name: ${customer.name}
Outstanding amount: Rs ${customer.outstanding}
Company name: SLP Price
Rules:
- Exactly 2-3 sentences
- Warm and polite Hinglish
- Mention customer name and exact amount
- Only return spoken words` }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.7 }
    }, { headers });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || buildTemplate(customer);
  } catch (err) {
    console.error('Gemini error:', err.message);
    return buildTemplate(customer);
  }
}

function buildTemplate(customer) {
  const name = customer.name || 'aap';
  const amt  = customer.outstanding || 'kuch';
  return `Namaste ${name} ji! Main SLP Price ki taraf se bol raha hoon. Aapka rupaye ${amt} ka outstanding payment pending hai. Kripya jald payment karein. Dhanyawad!`;
}

function formatPhone(phone) {
  let p = phone.toString().replace(/\D/g, '');
  if (p.length === 10) p = '0' + p;
  return p;
}

// ─── ExoML endpoint ───────────────────────────────────
app.get('/exoml', (req, res) => {
  console.log('ExoML hit:', JSON.stringify(req.query));
  const customField = req.query.CustomField || '';
  const callFrom = (req.query.CallFrom || '').replace(/\D/g, '').slice(-10);
  const log = callLog[customField];
  const script = log?.script || scriptStore[callFrom] || buildTemplate({ name: 'aap', outstanding: 'kuch' });
  console.log('Script:', script.substring(0, 80));
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${script}</Say><Pause length="1"/><Say>${script}</Say><Hangup/></Response>`);
});

// ─── Callback ─────────────────────────────────────────
app.post('/callback', (req, res) => {
  console.log('Callback:', JSON.stringify(req.body));
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
    scriptStore[cleanPhone] = script;
    callLog[callId] = { callId, name, phone: cleanPhone, outstanding, script, status: 'initiated', time: new Date().toISOString() };
    console.log('Calling', cleanPhone, '| Script:', script.substring(0, 60));

    const params = new URLSearchParams();
    params.append('From', formatPhone(phone));
    params.append('CallerId', EXOTEL_CALLER_ID);
    params.append('Url', 'http://my.exotel.com/slprice1/exoml/start_voice/1262658');
    params.append('CallType', 'trans');
    params.append('CustomField', callId);
    params.append('TimeLimit', '120');
    params.append('TimeOut', '30');
    params.append('StatusCallback', `${BASE_URL}/callback`);

    const response = await axios.post(
      `${EXOTEL_BASE}/Calls/connect.json`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    callLog[callId].exotelSid = response.data?.Call?.Sid || callId;
    console.log('Call SID:', callLog[callId].exotelSid);
    res.json({ success: true, callSid: callLog[callId].exotelSid, script });
  } catch (err) {
    console.error('Error:', err?.response?.status, JSON.stringify(err?.response?.data));
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

      const params = new URLSearchParams();
      params.append('From', formatPhone(c.phone));
      params.append('CallerId', EXOTEL_CALLER_ID);
      params.append('Url', 'http://my.exotel.com/slprice1/exoml/start_voice/1262658');
      params.append('CallType', 'trans');
      params.append('CustomField', callId);
      params.append('TimeLimit', '120');
      params.append('TimeOut', '30');
      params.append('StatusCallback', `${BASE_URL}/callback`);

      const response = await axios.post(
        `${EXOTEL_BASE}/Calls/connect.json`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      callLog[callId].exotelSid = response.data?.Call?.Sid || callId;
      results.push({ name: c.name, phone: cleanPhone, status: 'initiated', script });
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
  version: 'v8-fixed',
  account: EXOTEL_ACCOUNT_SID,
  callerID: EXOTEL_CALLER_ID,
  exomlUrl: `${BASE_URL}/exoml`,
  scriptEngine: GEMINI_API_KEY ? 'Gemini AI' : 'Template'
}));

app.listen(PORT, () => console.log(`AutoCall v8 ready on port ${PORT}`));
