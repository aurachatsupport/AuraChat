require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = require('./src/app');
const { initDatabase } = require('./src/config/database');
const { initSocket } = require('./src/socket/index');

// Инициализация базы данных
initDatabase();

// Создаём HTTP-сервер
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    credentials: true,
  },
});

// Инициализация Socket.IO
initSocket(io);

// Даём роутам доступ к Socket.IO
app.set('io', io);

// Render передаёт PORT через переменную окружения
const PORT = process.env.PORT || 3001;

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] AuraChat backend запущен на порту ${PORT}`);
});
