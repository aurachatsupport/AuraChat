const express = require('express');

const Friend = require('../models/Friend');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/friends — список принятых друзей
router.get('/', (req, res) => {
  const friends = Friend.listFriends(req.user.id);
  res.json({ friends });
});

// GET /api/friends/requests — входящие и исходящие заявки
router.get('/requests', (req, res) => {
  const incoming = Friend.listIncomingRequests(req.user.id);
  const outgoing = Friend.listOutgoingRequests(req.user.id);
  res.json({ incoming, outgoing });
});

// POST /api/friends/request { username или userId }
router.post('/request', (req, res) => {
  const { username, userId } = req.body;

  const target = userId ? User.findById(userId) : User.findByUsername(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя добавить самого себя в друзья' });
  }

  const existing = Friend.findRelation(req.user.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') {
      return res.status(409).json({ error: 'Вы уже друзья' });
    }
    if (existing.status === 'pending') {
      return res.status(409).json({ error: 'Заявка уже отправлена' });
    }
    if (existing.status === 'blocked') {
      return res.status(403).json({ error: 'Невозможно отправить заявку' });
    }
  }

  const request = Friend.sendRequest(req.user.id, target.id);

  // Пушим получателю в реальном времени, чтобы его UI обновился без перезахода.
  const io = req.app.get('io');
  const sender = User.findById(req.user.id);
  io?.to(`user:${target.id}`).emit('friend:request', {
    relationId: request.id,
    from: { id: sender.id, username: sender.username, name: sender.name, avatar_url: sender.avatar_url },
  });

  res.status(201).json({ request });
});

// POST /api/friends/:id/accept
router.post('/:id/accept', (req, res) => {
  const result = Friend.acceptRequest(Number(req.params.id), req.user.id);
  if (!result) return res.status(404).json({ error: 'Заявка не найдена или уже обработана' });

  // Пушим ОТПРАВИТЕЛЮ заявки — он не делал этот запрос и не узнает о принятии сам.
  const io = req.app.get('io');
  const accepter = User.findById(req.user.id);
  io?.to(`user:${result.user_id}`).emit('friend:accepted', {
    relationId: result.id,
    friend: { id: accepter.id, username: accepter.username, name: accepter.name, avatar_url: accepter.avatar_url },
  });

  res.json({ relation: result });
});

// DELETE /api/friends/:id — отклонить заявку или удалить из друзей
router.delete('/:id', (req, res) => {
  const relation = Friend.findRelationById(Number(req.params.id));
  const removed = Friend.removeRelation(Number(req.params.id), req.user.id);
  if (!removed) return res.status(404).json({ error: 'Связь не найдена' });

  // Уведомляем вторую сторону, если она есть (отклонили заявку или удалили из друзей).
  if (relation) {
    const io = req.app.get('io');
    const otherUserId = relation.user_id === req.user.id ? relation.friend_id : relation.user_id;
    io?.to(`user:${otherUserId}`).emit('friend:removed', { relationId: relation.id, byUserId: req.user.id });
  }

  res.json({ success: true });
});

// POST /api/friends/:userId/block — заблокировать пользователя по его id
router.post('/:userId/block', (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
  }
  Friend.block(req.user.id, targetId);
  res.json({ success: true });
});

module.exports = router;
