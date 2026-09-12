const express = require('express');
const { isValidFormat, domainCanReceiveMail } = require('../utils/emailCheck');

const router = express.Router();

// POST /api/email/check { email } — лёгкая предпроверка ДО регистрации.
// Публичный роут (без авторизации) — используется прямо в форме, пока человек печатает.
// Это НЕ доказывает, что ящик существует — только формат и что у домена есть MX-записи.
// Настоящее подтверждение — код, отправленный на email при регистрации.
router.post('/check', async (req, res) => {
  const { email } = req.body;
  const validFormat = isValidFormat(email);
  const hasMailServer = validFormat ? await domainCanReceiveMail(email) : false;

  res.json({
    validFormat,
    hasMailServer,
    note: 'Это только предварительная проверка формата и домена — не гарантирует, что ящик существует.',
  });
});

module.exports = router;
