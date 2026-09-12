const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const User = require('../models/User');
const Message = require('../models/Message');
const Friend = require('../models/Friend');
const Server = require('../models/Server');
const Channel = require('../models/Channel');
const ChannelMessage = require('../models/ChannelMessage');
const Role = require('../models/Role');

// userId -> Set(socket.id)  — поддержка нескольких вкладок/устройств на юзера
const onlineUsers = new Map();

// callId -> { callId, callerId, calleeId, status }
// status: 'ringing' | 'connecting' | 'active'
const activeCalls = new Map();

// channelId -> Map(userId -> username)  — кто сейчас в голосовом канале (в памяти,
// это состояние "прямо сейчас", хранить в БД смысла нет)
const voiceChannelParticipants = new Map();

function getVoiceParticipants(channelId) {
  return Array.from((voiceChannelParticipants.get(channelId) || new Map()).entries())
    .map(([id, username]) => ({ id, username }));
}

function addOnlineSocket(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}

function removeOnlineSocket(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}

function isOnline(userId) {
  return onlineUsers.has(userId);
}

// Ищет активный звонок, в котором участвует userId (звонящий или принимающий)
function findActiveCallForUser(userId) {
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.calleeId === userId) return call;
  }
  return null;
}

function initSocket(io) {
  // Аутентификация сокета через JWT, переданный при handshake.
  // clientType передаётся клиентом сам ("electron" | "web") — это НЕ криптографическая
  // гарантия (недоверенный клиент теоретически может подделать значение), но этого
  // достаточно, чтобы обычный веб-клиент по ТЗ не имел доступа к звонкам: сам UI звонков
  // в веб-версии не подключается вовсе, а здесь — дополнительный барьер на сервере.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('Токен не предоставлен'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const account = User.findById(payload.id);
      if (!account) return next(new Error('Пользователь не найден'));
      if (account.is_banned) return next(new Error('Аккаунт заблокирован'));
      socket.userId = payload.id;
      socket.username = payload.username;
      socket.clientType = socket.handshake.auth?.clientType === 'electron' ? 'electron' : 'web';
      next();
    } catch (err) {
      next(new Error('Недействительный токен'));
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket;
    addOnlineSocket(userId, socket.id);
    User.updateStatus(userId, 'online');

    // Личная комната пользователя — удобно для точечной отправки событий
    socket.join(`user:${userId}`);
    // Если у пользователя выключено "показывать в сети" — не рассылаем его online-статус остальным.
    if (User.findById(userId)?.show_online) {
      socket.broadcast.emit('user:status', { userId, status: 'online' });
    }

    // Подписываемся на комнаты всех серверов/каналов, где пользователь состоит —
    // чтобы сообщения в текстовых каналах и события сервера долетали сразу.
    Server.listForUser(userId).forEach((server) => {
      socket.join(`server:${server.id}`);
      Channel.listForServer(server.id).forEach((channel) => socket.join(`channel:${channel.id}`));
    });

    console.log(`[socket] ${socket.username} (${userId}) подключился, sid=${socket.id}, clientType=${socket.clientType}`);

    // Отправка личного сообщения
    socket.on('message:send', (payload, callback) => {
      try {
        const {
          receiverId,
          content,
          type = 'text',
          attachmentUrl = null,
          attachmentName = null,
          attachmentSize = null,
          attachmentMime = null,
        } = payload || {};

        if (!receiverId || (!content && !attachmentUrl)) {
          const error = 'receiverId и (content или attachmentUrl) обязательны';
          if (callback) return callback({ error });
          return;
        }

        const message = Message.create({
          senderId: userId,
          receiverId,
          content,
          type,
          attachmentUrl,
          attachmentName,
          attachmentSize,
          attachmentMime,
        });

        io.to(`user:${receiverId}`).emit('message:new', message);
        io.to(`user:${userId}`).emit('message:new', message); // эхо отправителю (др. вкладки)

        if (callback) callback({ message });
      } catch (err) {
        console.error('[socket message:send]', err);
        if (callback) callback({ error: 'Не удалось отправить сообщение' });
      }
    });

    // Индикатор "печатает..."
    socket.on('typing:start', ({ receiverId }) => {
      if (!receiverId) return;
      io.to(`user:${receiverId}`).emit('typing:start', { userId });
    });

    socket.on('typing:stop', ({ receiverId }) => {
      if (!receiverId) return;
      io.to(`user:${receiverId}`).emit('typing:stop', { userId });
    });

    // Пометить сообщения от senderId прочитанными — только если у ЧИТАЮЩЕГО (userId)
    // включён статус прочтения (см. PATCH /api/me/privacy). Иначе отправитель не узнает,
    // что сообщение открыли, а сам читающий соответственно не увидит чужие статусы тоже.
    socket.on('message:read', ({ senderId }) => {
      if (!senderId) return;
      if (!User.hasReadReceipts(userId)) return;
      Message.markAsRead(userId, senderId);
      io.to(`user:${senderId}`).emit('message:read', { by: userId });
    });

    // ============================================================
    //  ЗВОНКИ (Этап 1: 1-на-1, аудио) — ТОЛЬКО Windows Electron.
    //  Сервер лишь ретранслирует SDP/ICE между двумя конкретными
    //  сокетами — сам медиапоток идёт напрямую по WebRTC (P2P/TURN),
    //  через сервер не проходит.
    // ============================================================
    function requireElectron(callback) {
      if (socket.clientType === 'electron') return true;
      const error = 'Звонки доступны только в desktop-приложении';
      if (callback) callback({ error });
      return false;
    }

    socket.on('call:request', ({ calleeId }, callback) => {
      if (!requireElectron(callback)) return;
      if (!calleeId || calleeId === userId) {
        return callback?.({ error: 'Некорректный получатель звонка' });
      }
      if (!Friend.areFriends(userId, calleeId)) {
        return callback?.({ error: 'Звонить можно только друзьям' });
      }
      if (findActiveCallForUser(userId)) {
        return callback?.({ error: 'У вас уже есть активный звонок' });
      }
      if (findActiveCallForUser(calleeId)) {
        return callback?.({ error: 'Пользователь сейчас на другом звонке', busy: true });
      }
      if (!isOnline(calleeId)) {
        return callback?.({ error: 'Пользователь не в сети' });
      }

      const callId = crypto.randomUUID();
      activeCalls.set(callId, { callId, callerId: userId, calleeId, status: 'ringing' });

      const caller = User.findById(userId);
      io.to(`user:${calleeId}`).emit('call:incoming', {
        callId,
        from: { id: caller.id, username: caller.username, name: caller.name, avatar_url: caller.avatar_url },
      });

      callback?.({ callId });
    });

    socket.on('call:accept', ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call || call.calleeId !== userId) return;
      call.status = 'connecting';
      io.to(`user:${call.callerId}`).emit('call:accepted', { callId });
    });

    socket.on('call:reject', ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call || call.calleeId !== userId) return;
      io.to(`user:${call.callerId}`).emit('call:rejected', { callId });
      activeCalls.delete(callId);
    });

    socket.on('call:cancel', ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call || call.callerId !== userId) return;
      io.to(`user:${call.calleeId}`).emit('call:cancelled', { callId });
      activeCalls.delete(callId);
    });

    socket.on('call:end', ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      call.status = 'active'; // на всякий случай фиксируем, что соединение реально было установлено
      const otherId = call.callerId === userId ? call.calleeId : call.callerId;
      io.to(`user:${otherId}`).emit('call:ended', { callId });
      activeCalls.delete(callId);
    });

    // SDP/ICE — сервер только пересылает второй стороне звонка, не заглядывая внутрь
    function relayToOtherParty(callId, event, data) {
      const call = activeCalls.get(callId);
      if (!call) return;
      if (call.callerId !== userId && call.calleeId !== userId) return;
      const targetId = call.callerId === userId ? call.calleeId : call.callerId;
      io.to(`user:${targetId}`).emit(event, { callId, ...data });
    }

    socket.on('webrtc:offer', ({ callId, sdp }) => relayToOtherParty(callId, 'webrtc:offer', { sdp }));
    socket.on('webrtc:answer', ({ callId, sdp }) => relayToOtherParty(callId, 'webrtc:answer', { sdp }));
    socket.on('webrtc:ice-candidate', ({ callId, candidate }) =>
      relayToOtherParty(callId, 'webrtc:ice-candidate', { candidate })
    );

    socket.on('media:mute', ({ callId, muted }) => relayToOtherParty(callId, 'media:mute', { muted }));

    // ============================================================
    //  ТЕКСТОВЫЕ КАНАЛЫ (внутри серверов)
    // ============================================================
    socket.on('channel:send', (payload, callback) => {
      try {
        const { channelId, content, type = 'text', attachmentUrl = null, attachmentName = null, attachmentSize = null, attachmentMime = null } = payload || {};
        const channel = Channel.findById(channelId);
        if (!channel) return callback?.({ error: 'Канал не найден' });
        if (channel.type !== 'text') return callback?.({ error: 'Это не текстовый канал' });
        if (!Server.isMember(channel.server_id, userId)) return callback?.({ error: 'Вы не участник этого сервера' });
        if (Server.isBanned(channel.server_id)) return callback?.({ error: 'Этот сервер заблокирован администрацией' });
        if (channel.restricted_to_admins && !Server.isOwner(channel.server_id, userId) && !Role.isAdmin(channel.server_id, userId)) {
          return callback?.({ error: 'Эта тема закрыта — писать могут только администраторы' });
        }
        if (!content && !attachmentUrl) return callback?.({ error: 'content или attachmentUrl обязательны' });

        const message = ChannelMessage.create({
          channelId, senderId: userId, content, type, attachmentUrl, attachmentName, attachmentSize, attachmentMime,
        });
        const sender = User.findById(userId);
        const enriched = {
          ...message,
          sender_username: sender.username,
          sender_name: sender.name,
          sender_avatar_url: sender.avatar_url,
        };

        io.to(`channel:${channelId}`).emit('channel:message', enriched);
        callback?.({ message: enriched });
      } catch (err) {
        console.error('[socket channel:send]', err);
        callback?.({ error: 'Не удалось отправить сообщение' });
      }
    });

    // ============================================================
    //  ГОЛОСОВЫЕ КАНАЛЫ — mesh P2P (каждый с каждым), без SFU.
    //  Годится для небольших групп (3-5 человек), сервер только
    //  пересылает SDP/ICE конкретному адресату по targetUserId.
    // ============================================================
    socket.on('voice:join', (payload, callback) => {
      const { channelId } = payload || {};
      const channel = Channel.findById(channelId);
      if (!channel) return callback?.({ error: 'Канал не найден' });
      if (channel.type !== 'voice') return callback?.({ error: 'Это не голосовой канал' });
      if (!Server.isMember(channel.server_id, userId)) return callback?.({ error: 'Вы не участник этого сервера' });
      if (Server.isBanned(channel.server_id)) return callback?.({ error: 'Этот сервер заблокирован администрацией' });

      if (!voiceChannelParticipants.has(channelId)) voiceChannelParticipants.set(channelId, new Map());
      const participants = getVoiceParticipants(channelId); // список ДО добавления себя — именно с ними и нужно соединиться

      voiceChannelParticipants.get(channelId).set(userId, socket.username);
      socket.join(`voice:${channelId}`);

      socket.to(`voice:${channelId}`).emit('voice:user_joined', { channelId, userId, username: socket.username });
      callback?.({ participants });
    });

    socket.on('voice:leave', ({ channelId }) => {
      voiceChannelParticipants.get(channelId)?.delete(userId);
      socket.leave(`voice:${channelId}`);
      socket.to(`voice:${channelId}`).emit('voice:user_left', { channelId, userId });
    });

    socket.on('voice:offer', ({ channelId, targetUserId, sdp }) => {
      io.to(`user:${targetUserId}`).emit('voice:offer', { channelId, fromUserId: userId, sdp });
    });
    socket.on('voice:answer', ({ channelId, targetUserId, sdp }) => {
      io.to(`user:${targetUserId}`).emit('voice:answer', { channelId, fromUserId: userId, sdp });
    });
    socket.on('voice:ice-candidate', ({ channelId, targetUserId, candidate }) => {
      io.to(`user:${targetUserId}`).emit('voice:ice-candidate', { channelId, fromUserId: userId, candidate });
    });
    socket.on('voice:mute', ({ channelId, muted }) => {
      socket.to(`voice:${channelId}`).emit('voice:mute', { channelId, userId, muted });
    });

    socket.on('disconnect', () => {
      removeOnlineSocket(userId, socket.id);
      console.log(`[socket] ${socket.username} (${userId}) отключился, sid=${socket.id}`);

      // Выходим из всех голосовых каналов, в которых сидели — иначе для остальных
      // участник останется "висеть" в списке навсегда.
      voiceChannelParticipants.forEach((participants, channelId) => {
        if (participants.has(userId)) {
          participants.delete(userId);
          socket.to(`voice:${channelId}`).emit('voice:user_left', { channelId, userId });
        }
      });

      // Если у отключившегося был активный звонок — сообщаем второй стороне, что связь оборвалась
      const call = findActiveCallForUser(userId);
      if (call) {
        const otherId = call.callerId === userId ? call.calleeId : call.callerId;
        io.to(`user:${otherId}`).emit('call:ended', { callId: call.callId, reason: 'disconnected' });
        activeCalls.delete(call.callId);
      }

      if (!isOnline(userId)) {
        User.updateStatus(userId, 'offline');
        if (User.findById(userId)?.show_online) {
          socket.broadcast.emit('user:status', { userId, status: 'offline' });
        }
      }
    });
  });
}

module.exports = { initSocket, isOnline, onlineUsers };
