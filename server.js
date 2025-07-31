const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ Must match the Verify Token you type in Facebook Developer Console
const VERIFY_TOKEN = 'mytoken123';

app.use(bodyParser.json());

// ✅ Serve the privacy policy page
app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

// ✅ GET endpoint for Facebook webhook verification
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

// ✅ POST endpoint to receive messages
app.post('/webhook', (req, res) => {
  console.log('📩 Incoming webhook payload:');
  console.dir(req.body, { depth: null });

  const body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(entry => {
      const webhookEvent = entry.messaging[0];

      // ✅ Extract PSID here
      const senderPsid = webhookEvent.sender.id;
      console.log('✅ PSID:', senderPsid);

      // You can also check the message content if needed
      if (webhookEvent.message && webhookEvent.message.text) {
        console.log('💬 Message Text:', webhookEvent.message.text);
      }
    });
  }

  res.status(200).send('EVENT_RECEIVED');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
