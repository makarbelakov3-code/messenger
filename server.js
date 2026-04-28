const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Хранилище для файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, size: req.file.size });
});

// ============ БАЗА ДАННЫХ ============
const USERS_FILE = 'users.json';
const CHATS_FILE = 'chats.json';

function loadUsers() {
  try { if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) {}
  return {};
}

function loadChats() {
  try { if (fs.existsSync(CHATS_FILE)) return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch(e) {}
  return {};
}

let users = loadUsers();
let chats = loadChats();
let messages = {}; // chatId -> массив сообщений
let userSockets = new Map(); // userId -> socketId
let onlineUsers = new Map(); // userId -> { online, lastSeen }
let typingUsers = new Map(); // chatId -> Set of userIds

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveChats() { fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2)); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// Инициализация публичного чата
if (!chats.public) {
  chats.public = { id: 'public', type: 'public', name: 'Общий чат', participants: [], createdAt: new Date().toISOString() };
  messages.public = [];
  saveChats();
}

// API
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (users[username]) return res.status(400).json({ error: 'Пользователь уже существует' });
  users[username] = {
    id: generateId(),
    username,
    password: bcrypt.hashSync(password, 10),
    name: name || username,
    avatar: null,
    bio: '',
    online: false,
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  saveUsers();
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }
  res.json({ success: true, user: { id: user.id, username: user.username, name: user.name, avatar: user.avatar, bio: user.bio } });
});

app.get('/api/users', (req, res) => {
  res.json(Object.values(users).map(u => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar, online: u.online, lastSeen: u.lastSeen })));
});

app.get('/api/chats/:userId', (req, res) => {
  const userChats = [];
  for (const [id, chat] of Object.entries(chats)) {
    if (chat.participants.includes(req.params.userId) || chat.type === 'public') {
      const lastMsg = messages[id]?.[messages[id].length - 1];
      let displayName = chat.name;
      if (chat.type === 'private') {
        const otherId = chat.participants.find(p => p !== req.params.userId);
        const other = Object.values(users).find(u => u.id === otherId);
        displayName = other?.name || other?.username || 'Пользователь';
      }
      userChats.push({ id, type: chat.type, name: displayName, lastMessage: lastMsg, updatedAt: lastMsg?.createdAt || chat.createdAt });
    }
  }
  userChats.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(userChats);
});

app.get('/api/messages/:chatId', (req, res) => { res.json(messages[req.params.chatId] || []); });

app.get('/api/search/:chatId', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const chatMessages = messages[req.params.chatId] || [];
  const results = chatMessages.filter(m => m.text?.toLowerCase().includes(q.toLowerCase()));
  res.json(results);
});

app.post('/api/group', (req, res) => {
  const { name, participants, createdBy } = req.body;
  const chatId = generateId();
  chats[chatId] = { id: chatId, type: 'group', name, participants: [createdBy, ...participants], createdAt: new Date().toISOString(), createdBy };
  messages[chatId] = [];
  saveChats();
  participants.forEach(p => { const s = userSockets.get(p); if(s) io.to(s).emit('chat_created', { chatId, chat: chats[chatId] }); });
  res.json({ success: true, chatId });
});

app.post('/api/group/add', (req, res) => {
  const { chatId, userId } = req.body;
  if (chats[chatId] && !chats[chatId].participants.includes(userId)) {
    chats[chatId].participants.push(userId);
    saveChats();
    const s = userSockets.get(userId);
    if(s) io.to(s).emit('chat_created', { chatId, chat: chats[chatId] });
    res.json({ success: true });
  } else res.status(400).json({ error: 'Не удалось добавить' });
});

// ============ WEBSOCKETS ============
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  let currentUserId = null;

  socket.on('login', ({ username, password }) => {
    const user = users[username];
    if (!user || !bcrypt.compareSync(password, user.password)) {
      socket.emit('login_error', { error: 'Неверное имя или пароль' });
      return;
    }
    currentUserId = user.id;
    userSockets.set(user.id, socket.id);
    user.online = true;
    user.lastSeen = new Date().toISOString();
    saveUsers();
    socket.emit('login_success', { user: { id: user.id, username: user.username, name: user.name, avatar: user.avatar, bio: user.bio } });
    io.emit('user_status', { userId: user.id, online: true, lastSeen: user.lastSeen });
    io.emit('users_list', Object.values(users).map(u => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar, online: u.online, lastSeen: u.lastSeen })));
    const userChats = [];
    for (const [id, chat] of Object.entries(chats)) {
      if (chat.participants.includes(user.id) || chat.type === 'public') {
        const lastMsg = messages[id]?.[messages[id].length - 1];
        let displayName = chat.name;
        if (chat.type === 'private') {
          const otherId = chat.participants.find(p => p !== user.id);
          const other = Object.values(users).find(u => u.id === otherId);
          displayName = other?.name || other?.username || 'Пользователь';
        }
        userChats.push({ id, type: chat.type, name: displayName, lastMessage: lastMsg });
      }
    }
    socket.emit('chats_list', userChats);
  });

  socket.on('create_private_chat', ({ targetUserId }) => {
    if (!currentUserId) return;
    let existing = null;
    for (const [id, chat] of Object.entries(chats)) {
      if (chat.type === 'private' && chat.participants.includes(currentUserId) && chat.participants.includes(targetUserId)) {
        existing = chat;
        break;
      }
    }
    if (existing) {
      socket.emit('chat_created', { chatId: existing.id, chat: existing });
      return;
    }
    const chatId = generateId();
    chats[chatId] = { id: chatId, type: 'private', participants: [currentUserId, targetUserId], createdAt: new Date().toISOString() };
    messages[chatId] = [];
    saveChats();
    socket.emit('chat_created', { chatId, chat: chats[chatId] });
    const targetSocket = userSockets.get(targetUserId);
    if (targetSocket) io.to(targetSocket).emit('chat_created', { chatId, chat: chats[chatId] });
  });

  socket.on('send_message', async ({ chatId, text, files, replyTo }) => {
    if (!currentUserId) return;
    const user = Object.values(users).find(u => u.id === currentUserId);
    if (!user) return;
    const message = {
      id: generateId(),
      from: user.id,
      fromName: user.name || user.username,
      text: text || '',
      files: files || [],
      replyTo: replyTo || null,
      reactions: {},
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false
    };
    if (!messages[chatId]) messages[chatId] = [];
    messages[chatId].push(message);
    const chat = chats[chatId];
    if (chat) {
      chat.participants.forEach(pid => {
        const s = userSockets.get(pid);
        if (s) io.to(s).emit('new_message', { chatId, message });
      });
    }
  });

  socket.on('edit_message', ({ chatId, messageId, newText }) => {
    if (!currentUserId) return;
    const msgs = messages[chatId];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (msg && msg.from === currentUserId) {
      msg.text = newText;
      msg.editedAt = new Date().toISOString();
      const chat = chats[chatId];
      chat.participants.forEach(pid => {
        const s = userSockets.get(pid);
        if (s) io.to(s).emit('message_edited', { chatId, messageId, newText, editedAt: msg.editedAt });
      });
    }
  });

  socket.on('delete_message', ({ chatId, messageId }) => {
    if (!currentUserId) return;
    const msgs = messages[chatId];
    if (!msgs) return;
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex !== -1 && msgs[msgIndex].from === currentUserId) {
      msgs[msgIndex].deleted = true;
      msgs[msgIndex].text = 'Сообщение удалено';
      const chat = chats[chatId];
      chat.participants.forEach(pid => {
        const s = userSockets.get(pid);
        if (s) io.to(s).emit('message_deleted', { chatId, messageId });
      });
    }
  });

  socket.on('react_to_message', ({ chatId, messageId, emoji }) => {
    if (!currentUserId) return;
    const msgs = messages[chatId];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions) msg.reactions = {};
      if (msg.reactions[currentUserId] === emoji) {
        delete msg.reactions[currentUserId];
      } else {
        msg.reactions[currentUserId] = emoji;
      }
      const chat = chats[chatId];
      chat.participants.forEach(pid => {
        const s = userSockets.get(pid);
        if (s) io.to(s).emit('message_reacted', { chatId, messageId, reactions: msg.reactions });
      });
    }
  });

  socket.on('typing', ({ chatId, isTyping }) => {
    if (!currentUserId) return;
    if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Set());
    if (isTyping) typingUsers.get(chatId).add(currentUserId);
    else typingUsers.get(chatId).delete(currentUserId);
    const chat = chats[chatId];
    if (chat) {
      chat.participants.forEach(pid => {
        if (pid !== currentUserId) {
          const s = userSockets.get(pid);
          if (s) io.to(s).emit('user_typing', { chatId, userId: currentUserId, isTyping });
        }
      });
    }
  });

  socket.on('call_user', ({ targetUserId, offer }) => {
    if (!currentUserId) return;
    const targetSocket = userSockets.get(targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('incoming_call', { from: currentUserId, offer });
    }
  });

  socket.on('call_answer', ({ targetUserId, answer }) => {
    if (!currentUserId) return;
    const targetSocket = userSockets.get(targetUserId);
    if (targetSocket) io.to(targetSocket).emit('call_answered', { from: currentUserId, answer });
  });

  socket.on('ice_candidate', ({ targetUserId, candidate }) => {
    if (!currentUserId) return;
    const targetSocket = userSockets.get(targetUserId);
    if (targetSocket) io.to(targetSocket).emit('ice_candidate', { from: currentUserId, candidate });
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      const user = Object.values(users).find(u => u.id === currentUserId);
      if (user) {
        user.online = false;
        user.lastSeen = new Date().toISOString();
        saveUsers();
        io.emit('user_status', { userId: currentUserId, online: false, lastSeen: user.lastSeen });
      }
      userSockets.delete(currentUserId);
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на http://localhost:${PORT}`));
