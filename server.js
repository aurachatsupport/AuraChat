require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = require('./src/app');
const { initDatabase } = require('./src/config/database');
const { initSocket } = require('./src/socket/index');

initDatabase();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    credentials: true,
  },
});

initSocket(io);

// Роуты (friends.js и т.д.) должны уметь слать сокет-события конкретным пользователям
// в реальном времени (например, "тебе пришла заявка в друзья") — даём им доступ к io.
app.set('io', io);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`[server] AuraChat backend запущен на порту ${PORT}`);
});
