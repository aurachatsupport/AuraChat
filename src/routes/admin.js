const express = require('express');

const User = require('../models/User');
const Server = require('../models/Server');
const adminAuthMiddleware = require('../middleware/adminAuth');

const router = express.Router();
router.use(adminAuthMiddleware);

// GET /api/admin/users/:username — полная информация об аккаунте
router.get('/users/:username', (req, res) => {
  const user = User.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: User.toAdminView(user) });
});

// POST /api/admin/users/:username/ban { reason }
router.post('/users/:username/ban', (req, res) => {
  const user = User.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const updated = User.ban(user.id, req.body?.reason);
  const io = req.app.get('io');
  // Если пользователь сейчас онлайн — рвём его сокет-соединение немедленно
  io?.to(`user:${user.id}`).emit('account:banned', { reason: updated.ban_reason });
  io?.in(`user:${user.id}`).disconnectSockets(true);

  res.json({ user: User.toAdminView(updated) });
});

// POST /api/admin/users/:username/unban
router.post('/users/:username/unban', (req, res) => {
  const user = User.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const updated = User.unban(user.id);
  res.json({ user: User.toAdminView(updated) });
});

// DELETE /api/admin/users/:username — удаляет аккаунт (сообщения/дружбы удалятся
// каскадно, т.к. в схеме messages/friends стоит ON DELETE CASCADE на users.id)
router.delete('/users/:username', (req, res) => {
  const user = User.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const io = req.app.get('io');
  io?.to(`user:${user.id}`).emit('account:deleted', {});
  io?.in(`user:${user.id}`).disconnectSockets(true);

  User.delete(user.id);
  res.json({ success: true });
});

// ---- Сервера (сообщества) — ищутся по числовому id ИЛИ по инвайт-коду ----

// GET /api/admin/servers/:identifier
router.get('/servers/:identifier', (req, res) => {
  const server = Server.findByIdOrInviteCode(req.params.identifier);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });
  const owner = User.findById(server.owner_id);
  res.json({
    server: { ...server, memberCount: Server.listMembers(server.id).length, ownerUsername: owner?.username },
  });
});

// POST /api/admin/servers/:identifier/ban { reason }
router.post('/servers/:identifier/ban', (req, res) => {
  const server = Server.findByIdOrInviteCode(req.params.identifier);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const updated = Server.ban(server.id, req.body?.reason);
  const io = req.app.get('io');
  io?.to(`server:${server.id}`).emit('server:banned', { serverId: server.id, reason: updated.ban_reason });

  res.json({ server: updated });
});

// POST /api/admin/servers/:identifier/unban
router.post('/servers/:identifier/unban', (req, res) => {
  const server = Server.findByIdOrInviteCode(req.params.identifier);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const updated = Server.unban(server.id);
  res.json({ server: updated });
});

// DELETE /api/admin/servers/:identifier — удаляет сервер (каналы/роли/сообщения каскадно)
router.delete('/servers/:identifier', (req, res) => {
  const server = Server.findByIdOrInviteCode(req.params.identifier);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const io = req.app.get('io');
  io?.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });

  Server.delete(server.id);
  res.json({ success: true });
});

module.exports = router;
