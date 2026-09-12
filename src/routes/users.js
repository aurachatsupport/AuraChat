const express = require('express');

const User = require('../models/User');
const Message = require('../models/Message');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Все роуты ниже требуют авторизации
router.use(authMiddleware);

// GET /api/users?search=&limit=&offset=
router.get('/', (req, res) => {
  const { search, limit, offset } = req.query;
  const users = User.findAll({
    search: search || null,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
    excludeId: req.user.id,
  }).map(User.toContactView);
  res.json({ users });
});

// GET /api/users/:id — публичный профиль (глазами другого пользователя)
router.get('/:id', (req, res) => {
  const user = User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (Number(req.params.id) === req.user.id) {
    return res.json({ user: User.toPublic(user) }); // свой профиль — видно всё
  }
  res.json({ user: User.toContactView(user) });
});

// GET /api/users/:id/messages — история переписки с пользователем :id
router.get('/:id/messages', (req, res) => {
  const { limit, offset } = req.query;
  const messages = Message.getConversation(req.user.id, req.params.id, {
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });

  // Помечаем прочитанным, только если у ЧИТАЮЩЕГО (req.user) включён статус прочтения —
  // иначе отправитель никогда не узнает, что сообщение открыли, а сам читающий
  // соответственно тоже не увидит чужие статусы прочтения (см. /api/me/privacy).
  if (User.hasReadReceipts(req.user.id)) {
    Message.markAsRead(req.user.id, req.params.id);
  }

  res.json({ messages });
});

module.exports = router;
