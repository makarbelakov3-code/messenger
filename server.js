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

// Middleware
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
// Файлы для хранения данных
const USERS_FILE = 'users.json';
const CHATS_FILE = 'chats.json';
const MESSAGES_FILE = 'messages.json';

// Загрузка данных
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function loadChats() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function saveChats(chats) {
  fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// Инициализация данных
let users = loadUsers(); // userId -> { username, password, name, avatar, bio, online, lastSeen, createdAt }
let chats = loadChats(); // chatId -> { type, name, avatar, participants, createdAt, createdBy }
let messages = loadMessages(); // chatId -> [message]
let userSessions = new Map(); // socketId -> userId
let userOnline = new Map(); // userId -> socketId

// Вспомогательные функции
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// API регистрации
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите имя пользователя и пароль' });
  }
  
  if (users[username]) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }
  
  users[username] = {
    id: generateId(),
    username: username,
    password: hashPassword(password),
    name: name || username,
    avatar: null,
    bio: '',
    online: false,
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  saveUsers(users);
  res.json({ success: true, message: 'Регистрация успешна' });
});

// API входа
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = users[username];
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }
  
  res.json({ 
    success: true, 
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio
    }
  });
});

// API поиска пользователей
app.get('/api/users', (req, res) => {
  const search = req.query.search || '';
  const result = Object.values(users)
    .filter(u => u.username.toLowerCase().includes(search.toLowerCase()) || 
                  (u.name && u.name.toLowerCase().includes(search.toLowerCase())))
    .map(u => ({
      id: u.id,
      username: u.username,
      name: u.name,
      avatar: u.avatar,
      bio: u.bio,
      online: u.online,
      lastSeen: u.lastSeen
    }));
  res.json(result);
});

// API получения информации о пользователе
app.get('/api/user/:username', (req, res) => {
  const user = users[req.params.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    bio: user.bio,
    online: user.online,
    lastSeen: user.lastSeen,
    createdAt: user.createdAt
  });
});

// API получения чатов пользователя
app.get('/api/chats/:userId', (req, res) => {
  const userId = req.params.userId;
  const userChats = [];
  
  for (const [chatId, chat] of Object.entries(chats)) {
    if (chat.participants.includes(userId)) {
      const lastMessage = messages[chatId] && messages[chatId].length > 0 
        ? messages[chatId][messages[chatId].length - 1] 
        : null;
      
      let displayName = chat.name;
      let displayAvatar = chat.avatar;
      
      if (chat.type === 'private') {
        const otherUserId = chat.participants.find(p => p !== userId);
        const otherUser = Object.values(users).find(u => u.id === otherUserId);
        if (otherUser) {
          displayName = otherUser.name || otherUser.username;
          displayAvatar = otherUser.avatar;
        }
      }
      
      userChats.push({
        id: chatId,
        type: chat.type,
        name: displayName,
        avatar: displayAvatar,
        lastMessage: lastMessage,
        unread: 0,
        updatedAt: lastMessage ? lastMessage.createdAt : chat.createdAt
      });
    }
  }
  
  userChats.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(userChats);
});

// API получения сообщений чата
app.get('/api/messages/:chatId', (req, res) => {
  const chatMessages = messages[req.params.chatId] || [];
  res.json(chatMessages);
});

// API создания группы
app.post('/api/group', (req, res) => {
  const { name, participants, createdBy } = req.body;
  
  const chatId = generateId();
  chats[chatId] = {
    id: chatId,
    type: 'group',
    name: name,
    avatar: null,
    participants: [createdBy, ...participants],
    createdAt: new Date().toISOString(),
    createdBy: createdBy
  };
  
  messages[chatId] = [];
  saveChats(chats);
  saveMessages(messages);
  
  // Уведомляем всех участников
  for (const participantId of chats[chatId].participants) {
    const socketId = userOnline.get(participantId);
    if (socketId) {
      io.to(socketId).emit('chat_created', { chatId, chat: chats[chatId] });
    }
  }
  
  res.json({ success: true, chatId });
});

// API добавления участника в группу
app.post('/api/group/add', (req, res) => {
  const { chatId, userId, addedBy } = req.body;
  
  if (!chats[chatId] || chats[chatId].type !== 'group') {
    return res.status(400).json({ error: 'Chat not found' });
  }
  
  if (!chats[chatId].participants.includes(userId)) {
    chats[chatId].participants.push(userId);
    saveChats(chats);
    
    // Уведомляем нового участника
    const socketId = userOnline.get(userId);
    if (socketId) {
      io.to(socketId).emit('chat_created', { chatId, chat: chats[chatId] });
    }
    
    // Уведомляем всех участников
    for (const participantId of chats[chatId].participants) {
      const socketId = userOnline.get(participantId);
      if (socketId) {
        io.to(socketId).emit('member_added', { chatId, userId, addedBy });
      }
    }
  }
  
  res.json({ success: true });
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  let currentUserId = null;
  
  socket.on('login', (data) => {
    const { username, password } = data;
    const user = users[username];
    
    if (!user || !verifyPassword(password, user.password)) {
      socket.emit('login_error', { error: 'Неверное имя пользователя или пароль' });
      return;
    }
    
    currentUserId = user.id;
    userSessions.set(socket.id, currentUserId);
    userOnline.set(currentUserId, socket.id);
    
    // Обновляем статус пользователя
    user.online = true;
    user.lastSeen = new Date().toISOString();
    saveUsers(users);
    
    // Отправляем информацию о пользователе
    socket.emit('login_success', {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        bio: user.bio
      }
    });
    
    // Уведомляем всех о входе пользователя
    io.emit('user_status', { userId: user.id, username: user.username, online: true, lastSeen: user.lastSeen });
    
    // Отправляем список всех пользователей
    const allUsers = Object.values(users).map(u => ({
      id: u.id,
      username: u.username,
      name: u.name,
      avatar: u.avatar,
      online: u.online,
      lastSeen: u.lastSeen
    }));
    socket.emit('users_list', allUsers);
    
    // Отправляем список чатов
    const userChats = [];
    for (const [chatId, chat] of Object.entries(chats)) {
      if (chat.participants.includes(currentUserId)) {
        const lastMessage = messages[chatId] && messages[chatId].length > 0 
          ? messages[chatId][messages[chatId].length - 1] 
          : null;
        
        let displayName = chat.name;
        let displayAvatar = chat.avatar;
        
        if (chat.type === 'private') {
          const otherUserId = chat.participants.find(p => p !== currentUserId);
          const otherUser = Object.values(users).find(u => u.id === otherUserId);
          if (otherUser) {
            displayName = otherUser.name || otherUser.username;
            displayAvatar = otherUser.avatar;
          }
        }
        
        userChats.push({
          id: chatId,
          type: chat.type,
          name: displayName,
          avatar: displayAvatar,
          lastMessage: lastMessage,
          participants: chat.participants
        });
      }
    }
    socket.emit('chats_list', userChats);
  });
  
  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { chatId, text, files, replyTo } = data;
    const userId = currentUserId;
    const user = Object.values(users).find(u => u.id === userId);
    
    if (!user) return;
    
    const message = {
      id: generateId(),
      chatId: chatId,
      from: userId,
      fromName: user.name || user.username,
      text: text || '',
      files: files || [],
      replyTo: replyTo || null,
      createdAt: new Date().toISOString(),
      read: []
    };
    
    if (!messages[chatId]) messages[chatId] = [];
    messages[chatId].push(message);
    saveMessages(messages);
    
    // Отправляем сообщение всем участникам чата
    const chat = chats[chatId];
    if (chat) {
      for (const participantId of chat.participants) {
        const socketId = userOnline.get(participantId);
        if (socketId) {
          io.to(socketId).emit('new_message', message);
          io.to(socketId).emit('chat_update', { chatId, lastMessage: message });
        }
      }
    }
  });
  
  // Печатает...
  socket.on('typing', (data) => {
    const { chatId, isTyping } = data;
    const userId = currentUserId;
    const user = Object.values(users).find(u => u.id === userId);
    
    if (!user) return;
    
    const chat = chats[chatId];
    if (chat) {
      for (const participantId of chat.participants) {
        if (participantId !== userId) {
          const socketId = userOnline.get(participantId);
          if (socketId) {
            io.to(socketId).emit('user_typing', { chatId, userId, username: user.username, isTyping });
          }
        }
      }
    }
  });
  
  // Прочитано сообщение
  socket.on('mark_read', (data) => {
    const { chatId, messageId } = data;
    const userId = currentUserId;
    
    const chatMessages = messages[chatId];
    if (chatMessages) {
      const message = chatMessages.find(m => m.id === messageId);
      if (message && !message.read.includes(userId)) {
        message.read.push(userId);
        saveMessages(messages);
        
        // Уведомляем отправителя
        const senderSocket = userOnline.get(message.from);
        if (senderSocket) {
          io.to(senderSocket).emit('message_read', { chatId, messageId, userId });
        }
      }
    }
  });
  
  // Создание личного чата
  socket.on('create_private_chat', (data) => {
    const { targetUserId } = data;
    const userId = currentUserId;
    
    // Проверяем, существует ли уже чат
    let existingChat = null;
    for (const [chatId, chat] of Object.entries(chats)) {
      if (chat.type === 'private' && 
          chat.participants.includes(userId) && 
          chat.participants.includes(targetUserId)) {
        existingChat = chat;
        break;
      }
    }
    
    if (existingChat) {
      socket.emit('chat_created', { chatId: existingChat.id, chat: existingChat });
      return;
    }
    
    const chatId = generateId();
    chats[chatId] = {
      id: chatId,
      type: 'private',
      name: null,
      avatar: null,
      participants: [userId, targetUserId],
      createdAt: new Date().toISOString(),
      createdBy: userId
    };
    
    messages[chatId] = [];
    saveChats(chats);
    saveMessages(messages);
    
    // Уведомляем обоих участников
    const targetSocket = userOnline.get(targetUserId);
    if (targetSocket) {
      io.to(targetSocket).emit('chat_created', { chatId, chat: chats[chatId] });
    }
    socket.emit('chat_created', { chatId, chat: chats[chatId] });
  });
  
  // Обновление профиля
  socket.on('update_profile', (data) => {
    const { name, bio, avatar } = data;
    const user = Object.values(users).find(u => u.id === currentUserId);
    
    if (user) {
      if (name) user.name = name;
      if (bio !== undefined) user.bio = bio;
      if (avatar !== undefined) user.avatar = avatar;
      saveUsers(users);
      
      socket.emit('profile_updated', { name: user.name, bio: user.bio, avatar: user.avatar });
      
      // Уведомляем всех о обновлении
      io.emit('user_updated', { userId: user.id, username: user.username, name: user.name, avatar: user.avatar });
    }
  });
  
  socket.on('disconnect', () => {
    const userId = currentUserId;
    if (userId) {
      const user = Object.values(users).find(u => u.id === userId);
      if (user) {
        user.online = false;
        user.lastSeen = new Date().toISOString();
        saveUsers(users);
        
        io.emit('user_status', { userId: user.id, username: user.username, online: false, lastSeen: user.lastSeen });
      }
      
      userSessions.delete(socket.id);
      userOnline.delete(userId);
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
