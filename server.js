const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

// Хранилище для файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// База данных в памяти (при перезапуске сервера данные сохраняются в файлы)
let users = new Map(); // socketId -> { username, color, bio }
let userSockets = new Map(); // username -> socketId
let offlineMessages = new Map(); // username -> [сообщения]
let chats = new Map(); // chatId -> { participants, messages, createdAt }

// Загрузка данных из файлов
function loadData() {
  try {
    if (fs.existsSync('data.json')) {
      const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
      if (data.chats) chats = new Map(Object.entries(data.chats));
      if (data.offlineMessages) offlineMessages = new Map(Object.entries(data.offlineMessages));
      console.log('Данные загружены');
    }
  } catch(e) { console.log('Нет сохранённых данных'); }
}

function saveData() {
  const data = {
    chats: Object.fromEntries(chats),
    offlineMessages: Object.fromEntries(offlineMessages)
  };
  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
}

// Создание или получение личного чата
function getOrCreatePrivateChat(user1, user2) {
  const chatKey = [user1, user2].sort().join('_');
  if (!chats.has(chatKey)) {
    chats.set(chatKey, {
      id: chatKey,
      participants: [user1, user2],
      messages: [],
      createdAt: new Date().toISOString()
    });
    saveData();
  }
  return chats.get(chatKey);
}

// Отправка офлайн сообщений
function sendOfflineMessages(username, socketId) {
  if (offlineMessages.has(username)) {
    const messages = offlineMessages.get(username);
    messages.forEach(msg => {
      io.to(socketId).emit('private_message', msg);
    });
    offlineMessages.delete(username);
    saveData();
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (data) => {
    const { username, color, bio } = data;
    users.set(socket.id, { username, color, bio: bio || '' });
    userSockets.set(username, socket.id);
    
    // Отправляем список всех пользователей (которые когда-либо заходили)
    const allUsers = Array.from(new Set([...Array.from(userSockets.keys()), ...Array.from(offlineMessages.keys())]));
    socket.emit('all_users', allUsers);
    
    // Отправляем список онлайн
    const onlineUsers = Array.from(users.values()).map(u => u.username);
    io.emit('online_users', onlineUsers);
    
    // Отправляем историю общих сообщений
    const publicMessages = [];
    for (const chat of chats.values()) {
      if (chat.participants.includes('all')) {
        publicMessages.push(...chat.messages);
      }
    }
    socket.emit('history', publicMessages);
    
    // Отправляем список чатов пользователя
    const userChats = [];
    for (const [chatId, chat] of chats) {
      if (chat.participants.includes(username) && !chat.participants.includes('all')) {
        const otherUser = chat.participants.find(p => p !== username);
        userChats.push({
          id: chatId,
          with: otherUser,
          lastMessage: chat.messages[chat.messages.length - 1],
          createdAt: chat.createdAt
        });
      }
    }
    socket.emit('chats_list', userChats);
    
    // Отправляем офлайн сообщения
    sendOfflineMessages(username, socket.id);
    
    // Уведомление о входе
    socket.broadcast.emit('user_joined', `${username} присоединился`);
    saveData();
  });

  // Отправка сообщения
  socket.on('message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const message = {
      id: Date.now(),
      from: user.username,
      to: data.to || 'all',
      text: data.text || '',
      files: data.files || [],
      time: data.time || new Date().toLocaleTimeString(),
      isPrivate: data.to && data.to !== 'all'
    };
    
    if (message.isPrivate && data.to) {
      // Личное сообщение
      const chat = getOrCreatePrivateChat(user.username, data.to);
      chat.messages.push(message);
      saveData();
      
      const targetSocketId = userSockets.get(data.to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('private_message', message);
        io.to(targetSocketId).emit('new_chat', { with: user.username });
      } else {
        // Пользователь офлайн - сохраняем сообщение
        if (!offlineMessages.has(data.to)) {
          offlineMessages.set(data.to, []);
        }
        offlineMessages.get(data.to).push(message);
        saveData();
      }
      socket.emit('private_message', message);
      socket.emit('new_chat', { with: data.to });
      
      // Обновляем список чатов у обоих
      const senderChats = [];
      const receiverChats = [];
      for (const [chatId, ch] of chats) {
        if (ch.participants.includes(user.username) && !ch.participants.includes('all')) {
          const otherUser = ch.participants.find(p => p !== user.username);
          senderChats.push({ id: chatId, with: otherUser, lastMessage: ch.messages[ch.messages.length - 1] });
        }
        if (ch.participants.includes(data.to) && !ch.participants.includes('all')) {
          const otherUser = ch.participants.find(p => p !== data.to);
          receiverChats.push({ id: chatId, with: otherUser, lastMessage: ch.messages[ch.messages.length - 1] });
        }
      }
      socket.emit('chats_list', senderChats);
      if (targetSocketId) {
        io.to(targetSocketId).emit('chats_list', receiverChats);
      }
    } else {
      // Общее сообщение
      let publicChat = chats.get('all');
      if (!publicChat) {
        publicChat = { id: 'all', participants: ['all'], messages: [], createdAt: new Date().toISOString() };
        chats.set('all', publicChat);
      }
      publicChat.messages.push(message);
      saveData();
      io.emit('message', message);
    }
  });

  // Получение истории личного чата
  socket.on('get_chat_history', (targetUser) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const chat = getOrCreatePrivateChat(user.username, targetUser);
    socket.emit('chat_history', { targetUser, messages: chat.messages });
  });

  // Создание нового чата
  socket.on('create_chat', (targetUser) => {
    const user = users.get(socket.id);
    if (!user || targetUser === user.username) return;
    
    const chat = getOrCreatePrivateChat(user.username, targetUser);
    socket.emit('chat_created', { with: targetUser });
    
    // Обновляем список чатов
    const userChats = [];
    for (const [chatId, ch] of chats) {
      if (ch.participants.includes(user.username) && !ch.participants.includes('all')) {
        const otherUser = ch.participants.find(p => p !== user.username);
        userChats.push({ id: chatId, with: otherUser, lastMessage: ch.messages[ch.messages.length - 1] });
      }
    }
    socket.emit('chats_list', userChats);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      userSockets.delete(user.username);
      users.delete(socket.id);
      
      const onlineUsers = Array.from(users.values()).map(u => u.username);
      io.emit('online_users', onlineUsers);
      io.emit('user_left', `${user.username} покинул чат`);
    }
  });
});

loadData();
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
