const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { sendVerificationEmail } = require('../config/mailer');
const { generateVerificationCode } = require('../utils/emailCheck');

const router = express.Router();
const SALT_ROUNDS = 10;
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000; // 15 минут

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Короткоживущий токен для второго шага логина (ввод кода 2FA) — НЕ даёт доступа к API,
// только подтверждает, что логин/пароль на первом шаге уже были верны.
function signPreAuthToken(user) {
  return jwt.sign(
    { id: user.id, twoFactorPending: true },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

// Короткоживущий токен для подтверждения email при логине с неподтверждённым адресом.
function signEmailVerifyToken(user) {
  return jwt.sign(
    { id: user.id, emailVerificationPending: true },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

async function issueAndSendVerificationCode(userId, email) {
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
  User.setEmailVerificationCode(userId, code, expiresAt);
  await sendVerificationEmail(email, code);
}

// POST /api/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, name } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email и password обязательны' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    }

    if (User.findByUsername(username)) {
      return res.status(409).json({ error: 'Это имя пользователя уже занято' });
    }
    if (User.findByEmail(email)) {
      return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = User.create({ username, email, passwordHash, name });

    let emailSendError = null;
    try {
      await issueAndSendVerificationCode(user.id, user.email);
    } catch (err) {
      console.error('[auth/register] Не удалось отправить письмо с кодом', err.message);
      emailSendError = 'Не удалось отправить письмо — используй кнопку "Отправить код ещё раз"';
    }

    // Токен выдаём сразу (регистрация — не то же самое, что логин): пользователь может
    // ввести код подтверждения в рамках уже открытой сессии, не логинясь заново.
    // А вот СЛЕДУЮЩИЕ входы (POST /api/login) уже требуют подтверждённый email.
    const token = signToken(user);
    res.status(201).json({ token, user: User.toPublic(user), emailSendError });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// POST /api/login — шаг 1: логин/пароль.
// Порядок проверок: пароль -> email подтверждён? -> включена ли 2FA?
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = username или email

    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier и password обязательны' });
    }

    const user = User.findByUsernameOrEmail(identifier);
    if (!user) {
      return res.status(401).json({ error: 'Неверные учётные данные' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Неверные учётные данные' });
    }

    if (user.is_banned) {
      return res.status(403).json({
        error: user.ban_reason
          ? `Аккаунт заблокирован: ${user.ban_reason}`
          : 'Аккаунт заблокирован',
      });
    }

    if (!user.email_verified) {
      const emailVerifyToken = signEmailVerifyToken(user);
      return res.json({ requiresEmailVerification: true, emailVerifyToken });
    }

    if (user.totp_enabled) {
      const preAuthToken = signPreAuthToken(user);
      return res.json({ requiresTwoFactor: true, preAuthToken });
    }

    User.updateStatus(user.id, 'online');
    const token = signToken(user);
    res.json({ token, user: User.toPublic(user) });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

// ---- Подтверждение email ----
// Принимает токен ЛЮБОГО из двух видов: обычный сессионный (сразу после регистрации,
// когда пользователь уже "вошёл") ИЛИ emailVerifyToken (когда логин был заблокирован
// из-за неподтверждённого email). В обоих случаях после успеха выдаём свежий полный токен.

// POST /api/verify-email { token, code }
router.post('/verify-email', async (req, res) => {
  try {
    const { token, code } = req.body;
    if (!token || !code) return res.status(400).json({ error: 'token и code обязательны' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Токен недействителен или истёк, войдите заново' });
    }

    const ok = User.verifyEmailCode(payload.id, code);
    if (!ok) return res.status(401).json({ error: 'Неверный или истёкший код' });

    const user = User.findById(payload.id);
    User.updateStatus(user.id, 'online');
    const freshToken = signToken(user);
    res.json({ token: freshToken, user: User.toPublic(user) });
  } catch (err) {
    console.error('[auth/verify-email]', err);
    res.status(500).json({ error: 'Ошибка сервера при подтверждении email' });
  }
});

// POST /api/resend-verification { token }
router.post('/resend-verification', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token обязателен' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Токен недействителен или истёк, войдите заново' });
    }

    const user = User.findById(payload.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.email_verified) return res.status(400).json({ error: 'Email уже подтверждён' });
    if (!User.canResendVerification(user.id)) {
      return res.status(429).json({ error: 'Подожди минуту перед повторной отправкой' });
    }

    await issueAndSendVerificationCode(user.id, user.email);
    res.json({ success: true });
  } catch (err) {
    console.error('[auth/resend-verification]', err);
    res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

// POST /api/login/2fa — шаг 2: подтверждение кода из приложения-аутентификатора
router.post('/login/2fa', async (req, res) => {
  try {
    const { preAuthToken, code } = req.body;
    if (!preAuthToken || !code) {
      return res.status(400).json({ error: 'preAuthToken и code обязательны' });
    }

    let payload;
    try {
      payload = jwt.verify(preAuthToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'preAuthToken недействителен или истёк, войдите заново' });
    }
    if (!payload.twoFactorPending) {
      return res.status(401).json({ error: 'Недействительный токен для этого шага' });
    }

    const user = User.findById(payload.id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ error: 'У этого аккаунта не включена двухфакторная аутентификация' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: code,
      window: 1, // допускаем расхождение времени в ±1 интервал (30 сек)
    });
    if (!verified) {
      return res.status(401).json({ error: 'Неверный код' });
    }

    User.updateStatus(user.id, 'online');
    const token = signToken(user);
    res.json({ token, user: User.toPublic(user) });
  } catch (err) {
    console.error('[auth/login/2fa]', err);
    res.status(500).json({ error: 'Ошибка сервера при проверке кода' });
  }
});

// GET /api/me — текущий пользователь по токену
router.get('/me', authMiddleware, (req, res) => {
  const user = User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: User.toPublic(user) });
});

// PATCH /api/me — обновить свой профиль (name, bio, birthdate, language, username, email)
router.patch('/me', authMiddleware, (req, res) => {
  const { username, email, name, bio, birthdate, language } = req.body;

  if (username) {
    const existing = User.findByUsername(username);
    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({ error: 'Это имя пользователя уже занято' });
    }
  }
  if (email) {
    const existing = User.findByEmail(email);
    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
    }
  }

  const updated = User.updateProfile(req.user.id, {
    username,
    email,
    name,
    bio,
    birthdate,
    language,
  });
  res.json({ user: User.toPublic(updated) });
});

// PATCH /api/me/privacy — "показывать в сети" и "статус прочтения"
router.patch('/me/privacy', authMiddleware, (req, res) => {
  const { showOnline, readReceiptsEnabled } = req.body;
  const updated = User.updatePrivacy(req.user.id, { showOnline, readReceiptsEnabled });
  res.json({ user: User.toPublic(updated) });
});

// PATCH /api/me/password — смена пароля (нужен текущий пароль)
router.patch('/me/password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'oldPassword и newPassword обязательны' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }

  const user = User.findById(req.user.id);
  const matches = await bcrypt.compare(oldPassword, user.password_hash);
  if (!matches) return res.status(401).json({ error: 'Текущий пароль неверен' });

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  User.updatePasswordHash(req.user.id, newHash);
  res.json({ success: true });
});

// ---- Код-пароль (PIN) — локальная блокировка приложения на 4-6 цифр ----

// PUT /api/me/pin — установить/сменить PIN
router.put('/me/pin', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN должен состоять из 4-6 цифр' });
  }
  const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
  const user = User.updatePin(req.user.id, pinHash);
  res.json({ user: User.toPublic(user) });
});

// DELETE /api/me/pin — отключить PIN-блокировку
router.delete('/me/pin', authMiddleware, (req, res) => {
  User.removePin(req.user.id);
  res.json({ success: true });
});

// POST /api/me/pin/verify — проверить введённый PIN (для экрана блокировки)
router.post('/me/pin/verify', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  const user = User.findById(req.user.id);
  if (!user.pin_hash) return res.json({ valid: true }); // PIN не установлен — блокировки нет

  const valid = pin ? await bcrypt.compare(pin, user.pin_hash) : false;
  res.json({ valid });
});

// ---- Двухфакторная аутентификация (TOTP: Google Authenticator / Authy) ----

// POST /api/me/2fa/setup — генерирует секрет и QR-код для сканирования.
// 2FA ещё НЕ включается — только после успешного /verify-setup.
router.post('/me/2fa/setup', authMiddleware, async (req, res) => {
  const user = User.findById(req.user.id);
  const secret = speakeasy.generateSecret({
    name: `AuraChat (${user.username})`,
    length: 20,
  });

  User.setTotpSecret(req.user.id, secret.base32);

  try {
    const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, otpauthUrl: secret.otpauth_url, qrCode: qrDataUrl });
  } catch (err) {
    console.error('[auth/2fa/setup]', err);
    res.status(500).json({ error: 'Не удалось сгенерировать QR-код' });
  }
});

// POST /api/me/2fa/verify-setup — подтвердить код из приложения и включить 2FA
router.post('/me/2fa/verify-setup', authMiddleware, (req, res) => {
  const { code } = req.body;
  const user = User.findById(req.user.id);
  if (!user.totp_secret) {
    return res.status(400).json({ error: 'Сначала вызовите /api/me/2fa/setup' });
  }

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: 'base32',
    token: code,
    window: 1,
  });
  if (!verified) return res.status(401).json({ error: 'Неверный код' });

  const updated = User.enableTotp(req.user.id);
  res.json({ user: User.toPublic(updated) });
});

// DELETE /api/me/2fa — отключить 2FA (требует текущий пароль)
router.delete('/me/2fa', authMiddleware, async (req, res) => {
  const { password } = req.body;
  const user = User.findById(req.user.id);

  const matches = password ? await bcrypt.compare(password, user.password_hash) : false;
  if (!matches) return res.status(401).json({ error: 'Неверный пароль' });

  User.disableTotp(req.user.id);
  res.json({ success: true });
});

module.exports = router;
