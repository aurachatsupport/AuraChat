const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const filesRoutes = require('./routes/files');
const friendsRoutes = require('./routes/friends');
const messagesRoutes = require('./routes/messages');
const iceRoutes = require('./routes/ice');
const emailRoutes = require('./routes/email');
const adminRoutes = require('./routes/admin');
const serversRoutes = require('./routes/servers');

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || '*',
    credentials: true,
  })
);
app.use(express.json());
app.use(morgan('dev'));

// Статика для аватаров и вложений
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Статика веб-версии клиента (index.html + api-integration.js кладутся в backend/public/).
// Отдаётся с того же origin, что и API — упрощает CORS и работу cookie/токена.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/upload', filesRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/ice-servers', iceRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/servers', serversRoutes);

// 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Роут не найден' });
});

// Общий обработчик ошибок
app.use((err, req, res, next) => {
  console.error('[app error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

module.exports = app;
