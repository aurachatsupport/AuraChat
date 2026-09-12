// Проверяет заголовок X-Admin-Key против ADMIN_API_KEY из .env.
// Это отдельный секрет, никак не связанный с обычной JWT-авторизацией пользователей —
// админ-тул не требует быть залогиненным как какой-то конкретный аккаунт.
function adminAuthMiddleware(req, res, next) {
  const providedKey = req.headers['x-admin-key'];

  if (!process.env.ADMIN_API_KEY || process.env.ADMIN_API_KEY === 'change_this_to_a_long_random_admin_secret') {
    return res.status(503).json({ error: 'ADMIN_API_KEY не настроен на сервере — задай его в .env' });
  }
  if (!providedKey || providedKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Неверный или отсутствующий админ-ключ' });
  }
  next();
}

module.exports = adminAuthMiddleware;
