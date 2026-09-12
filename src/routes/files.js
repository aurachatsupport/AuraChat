const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE, 10) || 10 * 1024 * 1024;

function makeStorage(subfolder) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(__dirname, '..', '..', 'uploads', subfolder));
    },
    filename: (req, file, cb) => {
      const uniqueName = crypto.randomUUID() + path.extname(file.originalname);
      cb(null, uniqueName);
    },
  });
}

const avatarUpload = multer({
  storage: makeStorage('avatars'),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Аватар должен быть изображением'));
    }
    cb(null, true);
  },
});

const attachmentUpload = multer({
  storage: makeStorage('attachments'),
  limits: { fileSize: MAX_SIZE },
});

// POST /api/upload/avatar — form-data, поле "avatar"
router.post('/avatar', avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не был загружен' });

  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  const user = User.updateAvatar(req.user.id, avatarUrl);
  res.json({ url: avatarUrl, user: User.toPublic(user) });
});

// DELETE /api/upload/avatar — убрать аватар (файл на диске не удаляется, просто отвязывается)
router.delete('/avatar', (req, res) => {
  const user = User.updateAvatar(req.user.id, null);
  res.json({ user: User.toPublic(user) });
});

// POST /api/upload/attachment — form-data, поле "file"
router.post('/attachment', attachmentUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не был загружен' });

  res.json({
    url: `/uploads/attachments/${req.file.filename}`,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});

// Обработка ошибок multer (размер файла, тип файла и т.д.)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
