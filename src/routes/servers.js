const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const Server = require('../models/Server');
const Channel = require('../models/Channel');
const ChannelMessage = require('../models/ChannelMessage');
const Role = require('../models/Role');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE, 10) || 10 * 1024 * 1024;
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', '..', 'uploads', 'servers')),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname)),
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Аватар должен быть изображением'));
    cb(null, true);
  },
});

function requireMembership(req, res, serverId) {
  if (!Server.isMember(serverId, req.user.id)) {
    res.status(403).json({ error: 'Вы не участник этого сервера' });
    return false;
  }
  return true;
}

function isAdminLike(serverId, userId) {
  return Server.isOwner(serverId, userId) || Role.isAdmin(serverId, userId);
}

function requirePermission(req, res, serverId, permission) {
  if (Server.isOwner(serverId, req.user.id)) return true; // владелец может всё всегда
  if (!Role.hasPermission(serverId, req.user.id, permission)) {
    res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    return false;
  }
  return true;
}

function requireNotBanned(req, res, serverId) {
  if (Server.isBanned(serverId)) {
    res.status(403).json({ error: 'Этот сервер заблокирован администрацией' });
    return false;
  }
  return true;
}

// Публичный вид роли участника — используется в списках/детали сервера
function attachRolesToMembers(serverId, members) {
  const assignments = Role.getAllAssignments(serverId);
  const roles = Role.listForServer(serverId);
  const rolesById = Object.fromEntries(roles.map((r) => [r.id, r]));
  const rolesByUser = {};
  assignments.forEach(({ user_id, role_id }) => {
    if (!rolesByUser[user_id]) rolesByUser[user_id] = [];
    if (rolesById[role_id]) rolesByUser[user_id].push(rolesById[role_id]);
  });
  return members.map((m) => ({ ...m, roles: rolesByUser[m.id] || [] }));
}

// GET /api/servers — сервера, где я состою
router.get('/', (req, res) => {
  const servers = Server.listForUser(req.user.id);
  res.json({ servers });
});

// POST /api/servers { name } — создать сервер (автоматически создаётся канал #general)
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажи название сервера' });

  const server = Server.create({ name: name.trim(), ownerId: req.user.id });
  const generalChannel = Channel.create({ serverId: server.id, name: 'general', type: 'text' });

  const io = req.app.get('io');
  io?.sockets.sockets.forEach((s) => {
    if (s.userId === req.user.id) s.join(`server:${server.id}`).join(`channel:${generalChannel.id}`);
  });

  res.status(201).json({ server, channels: [generalChannel] });
});

// POST /api/servers/join { inviteCode }
router.post('/join', (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'inviteCode обязателен' });

  const server = Server.findByInviteCode(inviteCode.trim());
  if (!server) return res.status(404).json({ error: 'Сервер с таким инвайт-кодом не найден' });
  if (server.is_banned) return res.status(403).json({ error: 'Этот сервер заблокирован администрацией' });

  if (Server.isMember(server.id, req.user.id)) {
    return res.status(409).json({ error: 'Ты уже на этом сервере' });
  }

  Server.addMember(server.id, req.user.id, 'member');
  const channels = Channel.listForServer(server.id);

  const io = req.app.get('io');
  io?.sockets.sockets.forEach((s) => {
    if (s.userId === req.user.id) {
      s.join(`server:${server.id}`);
      channels.forEach((c) => s.join(`channel:${c.id}`));
    }
  });

  const joiner = User.findById(req.user.id);
  io?.to(`server:${server.id}`).emit('server:member_joined', {
    serverId: server.id,
    member: { id: joiner.id, username: joiner.username, name: joiner.name, avatar_url: joiner.avatar_url, roles: [] },
  });

  res.json({ server, channels });
});

// GET /api/servers/:id — детали сервера + каналы + участники (с ролями) + мои права
router.get('/:id', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;

  const server = Server.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const members = attachRolesToMembers(serverId, Server.listMembers(serverId));
  const myPermissions = Server.isOwner(serverId, req.user.id)
    ? [...Role.PERMISSIONS]
    : Array.from(new Set(Role.getMemberRoles(serverId, req.user.id).flatMap((r) => r.permissions)));

  res.json({
    server,
    channels: Channel.listForServer(serverId),
    members,
    roles: Role.listForServer(serverId),
    myPermissions,
    isOwner: Server.isOwner(serverId, req.user.id),
  });
});

// PATCH /api/servers/:id { name } — переименовать (MANAGE_SERVER)
router.patch('/:id', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_SERVER')) return;

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажи название' });

  const server = Server.updateName(serverId, name.trim());
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('server:updated', { server });

  res.json({ server });
});

// POST /api/servers/:id/avatar — аватар сервера (MANAGE_SERVER)
router.post('/:id/avatar', avatarUpload.single('avatar'), (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_SERVER')) return;
  if (!req.file) return res.status(400).json({ error: 'Файл не был загружен' });

  const server = Server.updateAvatar(serverId, `/uploads/servers/${req.file.filename}`);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('server:updated', { server });

  res.json({ server });
});

// DELETE /api/servers/:id/leave — выйти с сервера (владелец выходить не может, только удалить)
router.delete('/:id/leave', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;

  if (Server.isOwner(serverId, req.user.id)) {
    return res.status(400).json({ error: 'Владелец не может выйти — удали сервер, если он больше не нужен' });
  }

  Server.removeMember(serverId, req.user.id);

  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('server:member_left', { serverId, userId: req.user.id });
  io?.sockets.sockets.forEach((s) => {
    if (s.userId === req.user.id) s.leave(`server:${serverId}`);
  });

  res.json({ success: true });
});

// DELETE /api/servers/:id/members/:userId — исключить участника (KICK_MEMBERS)
router.delete('/:id/members/:userId', (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'KICK_MEMBERS')) return;
  if (Server.isOwner(serverId, targetId)) return res.status(400).json({ error: 'Нельзя исключить владельца' });

  Server.removeMember(serverId, targetId);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('server:member_left', { serverId, userId: targetId, kicked: true });
  io?.to(`user:${targetId}`).emit('server:kicked', { serverId });

  res.json({ success: true });
});

// DELETE /api/servers/:id — удалить сервер (только владелец)
router.delete('/:id', (req, res) => {
  const serverId = Number(req.params.id);
  if (!Server.isOwner(serverId, req.user.id)) {
    return res.status(403).json({ error: 'Удалить сервер может только владелец' });
  }

  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('server:deleted', { serverId });

  Server.delete(serverId); // каскадно удалит participants/channels/channel_messages/roles/member_roles
  res.json({ success: true });
});

// ---- Каналы ----

// POST /api/servers/:id/channels { name, type, restrictedToAdmins } — создать канал (MANAGE_CHANNELS)
router.post('/:id/channels', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_CHANNELS')) return;

  const { name, type, restrictedToAdmins } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажи название канала' });
  if (!['text', 'voice'].includes(type)) return res.status(400).json({ error: 'type должен быть text или voice' });

  const channel = Channel.create({ serverId, name: name.trim(), type, restrictedToAdmins: !!restrictedToAdmins });

  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('channel:created', { serverId, channel });
  io?.sockets.sockets.forEach((s) => {
    if (s.rooms.has(`server:${serverId}`)) s.join(`channel:${channel.id}`);
  });

  res.status(201).json({ channel });
});

// PATCH /api/servers/:id/channels/:channelId { restrictedToAdmins } — переключить "закрытую тему" (MANAGE_CHANNELS)
router.patch('/:id/channels/:channelId', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_CHANNELS')) return;

  const channel = Channel.findById(req.params.channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'Канал не найден' });

  const updated = Channel.setRestricted(channel.id, !!req.body.restrictedToAdmins);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('channel:updated', { serverId, channel: updated });

  res.json({ channel: updated });
});

// DELETE /api/servers/:id/channels/:channelId — удалить канал (MANAGE_CHANNELS)
router.delete('/:id/channels/:channelId', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_CHANNELS')) return;

  const channel = Channel.findById(req.params.channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'Канал не найден' });

  Channel.delete(channel.id);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('channel:deleted', { serverId, channelId: channel.id });

  res.json({ success: true });
});

// GET /api/servers/:id/channels/:channelId/messages — история текстового канала
router.get('/:id/channels/:channelId/messages', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;

  const channel = Channel.findById(req.params.channelId);
  if (!channel || channel.server_id !== serverId) return res.status(404).json({ error: 'Канал не найден' });

  const { limit, offset } = req.query;
  const messages = ChannelMessage.getHistory(channel.id, {
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  res.json({ messages });
});

// ---- Роли ----

// GET /api/servers/:id/roles
router.get('/:id/roles', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  res.json({ roles: Role.listForServer(serverId), permissions: Role.PERMISSIONS });
});

// POST /api/servers/:id/roles { name, color, permissions } — создать роль (MANAGE_ROLES)
router.post('/:id/roles', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_ROLES')) return;

  const { name, color, permissions } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажи название роли' });

  const role = Role.create({ serverId, name: name.trim(), color, permissions: permissions || [] });
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('role:created', { serverId, role });

  res.status(201).json({ role });
});

// PATCH /api/servers/:id/roles/:roleId — изменить роль (MANAGE_ROLES)
router.patch('/:id/roles/:roleId', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_ROLES')) return;

  const role = Role.findById(req.params.roleId);
  if (!role || role.server_id !== serverId) return res.status(404).json({ error: 'Роль не найдена' });

  const updated = Role.update(role.id, req.body);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('role:updated', { serverId, role: updated });

  res.json({ role: updated });
});

// DELETE /api/servers/:id/roles/:roleId (MANAGE_ROLES)
router.delete('/:id/roles/:roleId', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_ROLES')) return;

  const role = Role.findById(req.params.roleId);
  if (!role || role.server_id !== serverId) return res.status(404).json({ error: 'Роль не найдена' });

  Role.delete(role.id);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('role:deleted', { serverId, roleId: role.id });

  res.json({ success: true });
});

// POST /api/servers/:id/roles/:roleId/assign { userId } (MANAGE_ROLES)
router.post('/:id/roles/:roleId/assign', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_ROLES')) return;

  const role = Role.findById(req.params.roleId);
  if (!role || role.server_id !== serverId) return res.status(404).json({ error: 'Роль не найдена' });
  if (!Server.isMember(serverId, req.body.userId)) return res.status(400).json({ error: 'Пользователь не на этом сервере' });

  Role.assignToMember(serverId, req.body.userId, role.id);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('member:role_assigned', { serverId, userId: req.body.userId, role });

  res.json({ success: true });
});

// DELETE /api/servers/:id/roles/:roleId/assign/:userId (MANAGE_ROLES)
router.delete('/:id/roles/:roleId/assign/:userId', (req, res) => {
  const serverId = Number(req.params.id);
  if (!requireMembership(req, res, serverId)) return;
  if (!requirePermission(req, res, serverId, 'MANAGE_ROLES')) return;

  const roleId = Number(req.params.roleId);
  const userId = Number(req.params.userId);
  Role.removeFromMember(serverId, userId, roleId);
  const io = req.app.get('io');
  io?.to(`server:${serverId}`).emit('member:role_removed', { serverId, userId, roleId });

  res.json({ success: true });
});

module.exports = router;
