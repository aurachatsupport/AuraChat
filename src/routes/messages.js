const path = require('path');
const fs = require('fs');
const express = require('express');

const Message = require('../models/Message');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Удаляет файл вложения с диска — best-effort, ошибка тут не должна ломать сам запрос
// удаления сообщения (файла может уже не быть, путь может быть чужим и т.д.).
function deleteAttachmentFile(attachmentUrl) {
  if (!attachmentUrl || !attachmentUrl.startsWith('/uploads/')) return;
  try {
    const filePath = path.join(__dirname, '..', '..', attachmentUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[messages] Не удалось удалить файл вложения', err.message);
  }
}

// DELETE /api/messages/:id/for-me — скрыть сообщение только у себя.
// Если после этого сообщение скрыто у ОБЕИХ сторон — физически стирается вместе с файлом.
router.delete('/:id/for-me', (req, res) => {
  const result = Message.markDeletedForUser(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (result.error === 'forbidden') return res.status(403).json({ error: 'Это не ваша переписка' });

  if (result.purged) deleteAttachmentFile(result.message.attachment_url);

  // Уведомляем другие вкладки/окна ЭТОГО ЖЕ пользователя — у второй стороны сообщение
  // всё ещё видно, ей знать не нужно.
  const io = req.app.get('io');
  io?.to(`user:${req.user.id}`).emit('message:deleted', {
    messageId: Number(req.params.id),
    scope: 'me',
  });

  res.json({ success: true, purged: result.purged });
});

// DELETE /api/messages/:id/for-everyone — удалить у всех (только автор), сразу физически.
router.delete('/:id/for-everyone', (req, res) => {
  const result = Message.markDeletedForEveryone(req.params.id, req.user.id);
  if (!result) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (result.error === 'forbidden') {
    return res.status(403).json({ error: 'Можно удалить у всех только своё сообщение' });
  }

  deleteAttachmentFile(result.message.attachment_url);

  const io = req.app.get('io');
  const payload = { messageId: Number(req.params.id), scope: 'everyone' };
  io?.to(`user:${result.message.sender_id}`).emit('message:deleted', payload);
  io?.to(`user:${result.message.receiver_id}`).emit('message:deleted', payload);

  res.json({ success: true, purged: true });
});

module.exports = router;
