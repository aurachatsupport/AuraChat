# AuraChat Backend (SQLite)

## Установка

```bash
cd backend
npm install
npm run dev   # или npm start
```

При старте `server.js` вызывает `initDatabase()` — файл `database.sqlite` и таблицы `users`/`messages` создаются автоматически, если их ещё нет.

## Переменные окружения (`.env`)

- `PORT` — порт сервера
- `JWT_SECRET` — секрет для подписи токенов (замени перед продом!)
- `JWT_EXPIRES_IN` — срок жизни токена
- `DB_PATH` — путь к файлу SQLite
- `CLIENT_URL` — origin фронтенда для CORS
- `MAX_UPLOAD_SIZE` — лимит размера файла в байтах

## REST API

| Метод  | Путь                        | Авторизация | Описание                                          |
|--------|-----------------------------|:-----------:|----------------------------------------------------|
| POST   | /api/register               | нет         | Регистрация (username, email, password, name?)     |
| POST   | /api/login                  | нет         | Вход (identifier = username/email)                 |
| GET    | /api/me                     | да          | Текущий пользователь                                |
| PATCH  | /api/me                     | да          | Обновить профиль (name, bio, birthdate, language…)  |
| PATCH  | /api/me/password            | да          | Смена пароля (oldPassword, newPassword)             |
| PUT    | /api/me/pin                 | да          | Установить/сменить код-пароль (PIN, 4-6 цифр)       |
| DELETE | /api/me/pin                 | да          | Отключить код-пароль                                |
| POST   | /api/me/pin/verify          | да          | Проверить введённый PIN                             |
| GET    | /api/users                  | да          | Список / поиск (?search=)                           |
| GET    | /api/users/:id              | да          | Публичный профиль пользователя                      |
| PATCH  | /api/users/:id              | да          | (устаревш., используйте PATCH /api/me)              |
| GET    | /api/users/:id/messages     | да          | История переписки                                   |
| POST   | /api/upload/avatar          | да          | Загрузить аватар (`avatar`)                         |
| POST   | /api/upload/attachment      | да          | Загрузить вложение (`file`)                         |
| GET    | /api/friends                | да          | Список принятых друзей                              |
| GET    | /api/friends/requests       | да          | Входящие/исходящие заявки в друзья                  |
| POST   | /api/friends/request        | да          | Отправить заявку ({username} или {userId})          |
| POST   | /api/friends/:id/accept     | да          | Принять заявку (id — id строки friends)             |
| DELETE | /api/friends/:id            | да          | Отклонить заявку / удалить из друзей                |
| POST   | /api/friends/:userId/block  | да          | Заблокировать пользователя по его id                |
| GET    | /api/health                 | нет         | Проверка живости сервера                            |

JWT передаётся в заголовке: `Authorization: Bearer <token>`.

## Socket.IO

Подключение с токеном:

```js
const socket = io('http://localhost:3001', {
  auth: { token: jwtToken }
});
```

События:
- `message:send` `{ receiverId, content, type, attachmentUrl }` → сервер отвечает через callback и рассылает `message:new`
- `message:new` — новое сообщение (входящее/эхо)
- `message:read` `{ senderId }` → рассылает `message:read` отправителю
- `typing:start` / `typing:stop` `{ receiverId }`
- `user:status` `{ userId, status }` — онлайн/офлайн другого пользователя

## Структура

```
backend/
├── src/
│   ├── config/database.js
│   ├── models/{User,Message,Friend}.js
│   ├── routes/{auth,users,files,friends}.js
│   ├── middleware/auth.js
│   ├── socket/index.js
│   └── app.js
├── uploads/{avatars,attachments}/
├── database.sqlite   (создаётся автоматически)
├── package.json
├── .env
└── server.js
```

## Схема БД (users, расширенная)

`id, username, email, password_hash, name, bio, birthdate, language, avatar_url, status, pin_hash, last_seen, created_at`

Таблица `friends`: `id, user_id (отправитель заявки), friend_id (получатель), status (pending|accepted|blocked), created_at, updated_at`.
