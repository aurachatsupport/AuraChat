const express = require('express');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/ice-servers — конфигурация STUN/TURN для WebRTC (только Electron дёргает это в звонках).
// TURN — облачный провайдер (Twilio/Xirsys/др.), креды берутся из .env.
router.get('/', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  res.json({ iceServers });
});

module.exports = router;
