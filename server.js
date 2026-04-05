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

// ========== БАЗА ДАННЫХ ==========
let users = new Map(); // socketId -> { username, color, bio, avatar }
let userSockets = new Map(); // username -> socketId
let userData = new Map(); // username -> { bio, color, avatar, registeredAt }
let offlineMessages = new Map(); // username -> [сообщения]
let chats = new Map(); // chatId -> { type, name, participants, messages, createdAt, avatar }

// Загрузка данных
function loadData() {
  try {
    if (fs.existsSync('data.json')) {
      const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
      if (data.chats) chats = new Map(Object.entries(data.chats));
      if (data.offlineMessages) offlineMessages = new Map(Object.entries(data.offlineMessages));
      if (data.userData) userData = new Map(Object.entries(data.userData));
      console.log('Данные загружены');
    }
  } catch(e) { console.log('Нет сохранённых данных'); }
}

function saveData() {
  const data = {
    chats: Object.fromEntries(chats),
    offlineMessages: Object.fromEntries(offlineMessages),
    userData: Object.fromEntries(userData)
  };
  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
}

// Генерация ID чата
function generateChatId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Создание личного чата (автоматически)
function getOrCreatePrivateChat(user1, user2) {
  const chatKey = [user1, user2].sort().join('_');
  if (!chats.has(chatKey)) {
    chats.set(chatKey, {
      id: chatKey,
      type: 'private',
      name: null,
      participants: [user1, user2],
      messages: [],
      createdAt: new Date().toISOString(),
      avatar: null
    });
    saveData();
  }
  return chats.get(chatKey);
}

// Создание группового чата
function createGroupChat(name, creator, participants) {
  const chatId = generateChatId();
  const uniqueParticipants = [...new Set([creator, ...participants])];
  chats.set(chatId, {
    id: chatId,
    type: 'group',
    name: name,
    participants: uniqueParticipants,
    messages: [],
    createdAt: new Date().toISOString(),
    createdBy: creator,
    avatar: null
  });
  saveData();
  return chats.get(chatId);
}

// Добавление участника в группу
function addParticipantToGroup(chatId, username) {
  const chat = chats.get(chatId);
  if (chat && chat.type === 'group' && !chat.participants.includes(username)) {
    chat.participants.push(username);
    saveData();
    return true;
  }
  return false;
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
    const { username, color, bio, avatar } = data;
    users.set(socket.id, { username, color, bio: bio || '', avatar: avatar || '' });
    userSockets.set(username, socket.id);
    
    if (!userData.has(username)) {
      userData.set(username, { bio: bio || '', color: color, avatar: avatar || '', registeredAt: new Date().toISOString() });
      saveData();
    }
    
    // Отправляем список всех пользователей
    const allUsers = Array.from(userData.keys());
    socket.emit('all_users', allUsers);
    
    // Отправляем список онлайн
    const onlineUsers = Array.from(users.values()).map(u => u.username);
    io.emit('online_users', onlineUsers);
    
    // Отправляем историю общих сообщений
    const publicChat = chats.get('public');
    if (publicChat) {
      socket.emit('history', publicChat.messages);
    } else {
      socket.emit('history', []);
    }
    
    // Отправляем список чатов пользователя
    const userChats = [];
    for (const [chatId, chat] of chats) {
      if (chat.participants.includes(username)) {
        userChats.push({
          id: chatId,
          type: chat.type,
          name: chat.type === 'group' ? chat.name : chat.participants.find(p => p !== username),
          participants: chat.participants,
          lastMessage: chat.messages[chat.messages.length - 1],
          createdAt: chat.createdAt,
          avatar: chat.avatar
        });
      }
    }
    socket.emit('chats_list', userChats);
    
    // Отправляем офлайн сообщения
    sendOfflineMessages(username, socket.id);
    
    // Уведомление о входе
    socket.broadcast.emit('user_joined', `${username} присоединился`);
  });

  // Отправка сообщения
  socket.on('message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const message = {
      id: Date.now(),
      from: user.username,
      chatId: data.chatId,
      text: data.text || '',
      files: data.files || [],
      time: data.time || new Date().toLocaleTimeString(),
      type: data.type || 'text'
    };
    
    const chat = chats.get(data.chatId);
    if (!chat) return;
    
    chat.messages.push(message);
    saveData();
    
    // Отправляем сообщение всем участникам чата
    chat.participants.forEach(participant => {
      const targetSocketId = userSockets.get(participant);
      if (targetSocketId) {
        io.to(targetSocketId).emit('new_message', { chatId: data.chatId, message: message });
      } else if (participant !== user.username) {
        // Сохраняем офлайн сообщение
        if (!offlineMessages.has(participant)) {
          offlineMessages.set(participant, []);
        }
        offlineMessages.get(participant).push({ chatId: data.chatId, message: message });
        saveData();
      }
    });
    
    // Обновляем список чатов у всех участников
    chat.participants.forEach(participant => {
      const targetSocketId = userSockets.get(participant);
      if (targetSocketId) {
        const updatedChats = [];
        for (const [chatId, ch] of chats) {
          if (ch.participants.includes(participant)) {
            updatedChats.push({
              id: chatId,
              type: ch.type,
              name: ch.type === 'group' ? ch.name : ch.participants.find(p => p !== participant),
              participants: ch.participants,
              lastMessage: ch.messages[ch.messages.length - 1],
              createdAt: ch.createdAt
            });
          }
        }
        io.to(targetSocketId).emit('chats_list', updatedChats);
      }
    });
  });

  // Получение истории чата
  socket.on('get_chat_history', (chatId) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const chat = chats.get(chatId);
    if (chat && chat.participants.includes(user.username)) {
      socket.emit('chat_history', { chatId: chatId, messages: chat.messages, chatInfo: chat });
    }
  });

  // Создание группового чата
  socket.on('create_group', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const { name, participants } = data;
    const chat = createGroupChat(name, user.username, participants);
    
    // Уведомляем всех участников
    chat.participants.forEach(participant => {
      const targetSocketId = userSockets.get(participant);
      if (targetSocketId) {
        const updatedChats = [];
        for (const [chatId, ch] of chats) {
          if (ch.participants.includes(participant)) {
            updatedChats.push({
              id: chatId,
              type: ch.type,
              name: ch.type === 'group' ? ch.name : ch.participants.find(p => p !== participant),
              participants: ch.participants,
              lastMessage: ch.messages[ch.messages.length - 1],
              createdAt: ch.createdAt
            });
          }
        }
        io.to(targetSocketId).emit('chats_list', updatedChats);
        io.to(targetSocketId).emit('group_created', { chatId: chat.id, name: chat.name });
      }
    });
    
    socket.emit('group_created', { chatId: chat.id, name: chat.name });
  });

  // Добавление участника в группу
  socket.on('add_to_group', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const { chatId, username } = data;
    const chat = chats.get(chatId);
    
    if (chat && chat.type === 'group' && chat.participants.includes(user.username)) {
      if (addParticipantToGroup(chatId, username)) {
        // Уведомляем нового участника
        const newUserSocket = userSockets.get(username);
        if (newUserSocket) {
          const updatedChats = [];
          for (const [chatId, ch] of chats) {
            if (ch.participants.includes(username)) {
              updatedChats.push({
                id: chatId,
                type: ch.type,
                name: ch.type === 'group' ? ch.name : ch.participants.find(p => p !== username),
                participants: ch.participants,
                lastMessage: ch.messages[ch.messages.length - 1],
                createdAt: ch.createdAt
              });
            }
          }
          io.to(newUserSocket).emit('chats_list', updatedChats);
          io.to(newUserSocket).emit('added_to_group', { chatId: chatId, groupName: chat.name });
        }
        
        // Уведомляем всех участников
        chat.participants.forEach(participant => {
          const targetSocketId = userSockets.get(participant);
          if (targetSocketId) {
            io.to(targetSocketId).emit('group_member_added', { chatId: chatId, username: username });
          }
        });
      }
    }
  });

  // Получение списка участников чата
  socket.on('get_chat_participants', (chatId) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const chat = chats.get(chatId);
    if (chat && chat.participants.includes(user.username)) {
      socket.emit('chat_participants', { chatId: chatId, participants: chat.participants });
    }
  });

  // Создание публичного чата (если нет)
  if (!chats.has('public')) {
    chats.set('public', {
      id: 'public',
      type: 'public',
      name: 'Общий чат',
      participants: [],
      messages: [],
      createdAt: new Date().toISOString()
    });
    saveData();
  }

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

// Создание публичного чата при старте
if (!chats.has('public')) {
  chats.set('public', {
    id: 'public',
    type: 'public',
    name: 'Общий чат',
    participants: [],
    messages: [],
    createdAt: new Date().toISOString()
  });
  saveData();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
