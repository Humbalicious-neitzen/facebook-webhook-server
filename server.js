const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// 👉 Must match the Verify Token you type in Facebook
const VERIFY_TOKEN = 'mytoken123';

app.use(bodyParser.json());

// ✅ Serve the privacy policy page
app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

// Required GET endpoint for Facebook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Optional POST for receiving messages
app.post('/webhook', (req, res) => {
  console.log('🔔 Incoming webhook payload:');
  console.dir(req.body, { depth: null });
  res.status(200).send('EVENT_RECEIVED');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
