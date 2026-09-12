const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Проверяет заголовок Authorization: Bearer <token>, кладёт payload в req.user.
// Дополнительно проверяет, не забанен ли аккаунт — если да, доступ рвётся сразу,
// даже если сам JWT ещё не истёк (иначе забаненный мог бы пользоваться API до
// истечения токена, до 7 дней по умолчанию).
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const account = User.findById(payload.id);
    if (!account) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    if (account.is_banned) {
      return res.status(403).json({
        error: account.ban_reason ? `Аккаунт заблокирован: ${account.ban_reason}` : 'Аккаунт заблокирован',
      });
    }

    req.user = payload; // { id, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный или истёкший токен' });
  }
}

module.exports = authMiddleware;
