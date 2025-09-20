const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Socket.io configuration
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sos-oyunu';
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB bağlantısı başarılı'))
.catch(err => console.error('MongoDB bağlantı hatası:', err));

// Schemas
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  surname: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now }
});

const gameSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  players: [{
    userId: String,
    name: String,
    socketId: String,
    score: { type: Number, default: 0 }
  }],
  board: [[String]],
  currentPlayer: { type: Number, default: 0 },
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, surname, email, password } = req.body;
    
    // Validation
    if (!name || !surname || !email || !password) {
      return res.status(400).json({ error: 'Tüm alanlar zorunludur' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır' });
    }
    
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Create user
    const user = new User({
      name,
      surname,
      email,
      password: hashedPassword
    });
    
    await user.save();
    
    res.json({
      message: 'Kayıt başarılı',
      user: {
        id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Kayıt hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre zorunludur' });
    }
    
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }
    
    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save();
    
    res.json({
      message: 'Giriş başarılı',
      user: {
        id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Giriş hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Utility functions
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createEmptyBoard(size = 8) {
  return Array(size).fill().map(() => Array(size).fill(''));
}

// Socket.io connection handling
const activeGames = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('Yeni kullanıcı bağlandı:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
    
    // Remove user from any active games
    const userId = userSockets.get(socket.id);
    if (userId) {
      for (const [roomId, game] of activeGames.entries()) {
        const playerIndex = game.players.findIndex(p => p.userId === userId);
        if (playerIndex !== -1) {
          socket.to(roomId).emit('player-left', { userId, playerName: game.players[playerIndex].name });
          activeGames.delete(roomId);
          break;
        }
      }
    }
    
    userSockets.delete(socket.id);
  });
  
  socket.on('user-authenticated', (data) => {
    userSockets.set(socket.id, data.userId);
    socket.emit('authentication-confirmed');
  });
  
  socket.on('create-room', async (data) => {
    try {
      const { userId, userName } = data;
      const roomId = generateRoomId();
      
      const newGame = {
        roomId,
        players: [{ userId, name: userName, socketId: socket.id, score: 0 }],
        board: createEmptyBoard(),
        currentPlayer: 0,
        status: 'waiting'
      };
      
      activeGames.set(roomId, newGame);
      socket.join(roomId);
      
      // Save to database
      const gameDoc = new Game({
        roomId,
        players: newGame.players,
        board: newGame.board,
        currentPlayer: newGame.currentPlayer,
        status: newGame.status
      });
      
      await gameDoc.save();
      
      socket.emit('room-created', { 
        roomId,
        message: 'Oda oluşturuldu. Oda ID\'nizi diğer oyuncuyla paylaşın.'
      });
      
      console.log(`Oda oluşturuldu: ${roomId}, Kullanıcı: ${userName}`);
    } catch (error) {
      console.error('Oda oluşturma hatası:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı' });
    }
  });
  
  socket.on('join-room', async (data) => {
    try {
      const { roomId, userId, userName } = data;
      
      // Check if room exists
      if (!activeGames.has(roomId)) {
        // Check database for room
        const gameDoc = await Game.findOne({ roomId });
        if (!gameDoc) {
          socket.emit('error', { message: 'Oda bulunamadı' });
          return;
        }
        
        // Restore game from database
        activeGames.set(roomId, {
          roomId: gameDoc.roomId,
          players: gameDoc.players,
          board: gameDoc.board,
          currentPlayer: gameDoc.currentPlayer,
          status: gameDoc.status
        });
      }
      
      const game = activeGames.get(roomId);
      
      if (game.status !== 'waiting') {
        socket.emit('error', { message: 'Oda dolu' });
        return;
      }
      
      if (game.players.length >= 2) {
        socket.emit('error', { message: 'Oda dolu' });
        return;
      }
      
      // Add player to game
      game.players.push({ userId, name: userName, socketId: socket.id, score: 0 });
      game.status = 'playing';
      
      socket.join(roomId);
      userSockets.set(socket.id, userId);
      
      // Update database
      await Game.updateOne(
        { roomId },
        { 
          players: game.players,
          status: game.status,
          updatedAt: new Date()
        }
      );
      
      // Notify all players
      io.to(roomId).emit('player-joined', {
        players: game.players,
        message: `${userName} odaya katıldı. Oyun başlıyor!`
      });
      
      io.to(roomId).emit('game-started', {
        board: game.board,
        currentPlayer: game.currentPlayer,
        scores: game.players.map(p => p.score)
      });
      
      console.log(`Kullanıcı odaya katıldı: ${roomId}, Kullanıcı: ${userName}`);
    } catch (error) {
      console.error('Odaya katılma hatası:', error);
      socket.emit('error', { message: 'Odaya katılamadı' });
    }
  });
  
  socket.on('make-move', async (data) => {
    try {
      const { roomId, row, col, letter, playerIndex } = data;
      
      if (!activeGames.has(roomId)) {
        socket.emit('error', { message: 'Oda bulunamadı' });
        return;
      }
      
      const game = activeGames.get(roomId);
      
      // Validate move
      if (game.currentPlayer !== playerIndex) {
        socket.emit('error', { message: 'Sıra sizde değil' });
        return;
      }
      
      if (game.board[row][col] !== '') {
        socket.emit('error', { message: 'Bu hücre zaten dolu' });
        return;
      }
      
      // Make move
      game.board[row][col] = letter;
      
      // Check for SOS
      const sosCount = checkForSOS(game.board, row, col, letter);
      if (sosCount > 0) {
        game.players[playerIndex].score += sosCount;
      } else {
        // Switch player if no SOS
        game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
      }
      
      // Update database
      await Game.updateOne(
        { roomId },
        { 
          board: game.board,
          players: game.players,
          currentPlayer: game.currentPlayer,
          updatedAt: new Date()
        }
      );
      
      // Send update to all players
      io.to(roomId).emit('move-made', {
        row,
        col,
        letter,
        playerIndex,
        scores: game.players.map(p => p.score),
        currentPlayer: game.currentPlayer,
        sosCount
      });
      
      // Check if board is full
      if (isBoardFull(game.board)) {
        game.status = 'finished';
        await Game.updateOne({ roomId }, { status: 'finished' });
        
        io.to(roomId).emit('game-over', {
          scores: game.players.map(p => p.score),
          winner: determineWinner(game.players)
        });
      }
    } catch (error) {
      console.error('Hamle hatası:', error);
      socket.emit('error', { message: 'Hamle yapılamadı' });
    }
  });
  
  socket.on('new-game', async (data) => {
    try {
      const { roomId } = data;
      
      if (!activeGames.has(roomId)) {
        socket.emit('error', { message: 'Oda bulunamadı' });
        return;
      }
      
      const game = activeGames.get(roomId);
      
      // Reset game
      game.board = createEmptyBoard();
      game.currentPlayer = 0;
      game.status = 'playing';
      game.players.forEach(player => player.score = 0);
      
      // Update database
      await Game.updateOne(
        { roomId },
        { 
          board: game.board,
          players: game.players,
          currentPlayer: game.currentPlayer,
          status: game.status,
          updatedAt: new Date()
        }
      );
      
      // Notify players
      io.to(roomId).emit('game-started', {
        board: game.board,
        currentPlayer: game.currentPlayer,
        scores: game.players.map(p => p.score)
      });
    } catch (error) {
      console.error('Yeni oyun hatası:', error);
      socket.emit('error', { message: 'Yeni oyun başlatılamadı' });
    }
  });
});

// Game logic functions
function checkForSOS(board, row, col, letter) {
  let count = 0;
  const size = board.length;
  
  if (letter === 'O') {
    // Check horizontal S-O-S
    if (col > 0 && col < size - 1 && board[row][col-1] === 'S' && board[row][col+1] === 'S') {
      count++;
    }
    
    // Check vertical S-O-S
    if (row > 0 && row < size - 1 && board[row-1][col] === 'S' && board[row+1][col] === 'S') {
      count++;
    }
    
    // Check diagonal S-O-S
    if (row > 0 && col > 0 && row < size - 1 && col < size - 1) {
      // Top-left to bottom-right
      if (board[row-1][col-1] === 'S' && board[row+1][col+1] === 'S') {
        count++;
      }
      
      // Top-right to bottom-left
      if (board[row-1][col+1] === 'S' && board[row+1][col-1] === 'S') {
        count++;
      }
    }
  } else if (letter === 'S') {
    // Check horizontal S-O-S (left)
    if (col >= 2 && board[row][col-1] === 'O' && board[row][col-2] === 'S') {
      count++;
    }
    
    // Check horizontal S-O-S (right)
    if (col <= size - 3 && board[row][col+1] === 'O' && board[row][col+2] === 'S') {
      count++;
    }
    
    // Check vertical S-O-S (up)
    if (row >= 2 && board[row-1][col] === 'O' && board[row-2][col] === 'S') {
      count++;
    }
    
    // Check vertical S-O-S (down)
    if (row <= size - 3 && board[row+1][col] === 'O' && board[row+2][col] === 'S') {
      count++;
    }
    
    // Check diagonal S-O-S (top-left to bottom-right)
    if (row >= 2 && col >= 2 && board[row-1][col-1] === 'O' && board[row-2][col-2] === 'S') {
      count++;
    }
    
    // Check diagonal S-O-S (bottom-right to top-left)
    if (row <= size - 3 && col <= size - 3 && board[row+1][col+1] === 'O' && board[row+2][col+2] === 'S') {
      count++;
    }
    
    // Check diagonal S-O-S (top-right to bottom-left)
    if (row >= 2 && col <= size - 3 && board[row-1][col+1] === 'O' && board[row-2][col+2] === 'S') {
      count++;
    }
    
    // Check diagonal S-O-S (bottom-left to top-right)
    if (row <= size - 3 && col >= 2 && board[row+1][col-1] === 'O' && board[row+2][col-2] === 'S') {
      count++;
    }
  }
  
  return count;
}

function isBoardFull(board) {
  for (let i = 0; i < board.length; i++) {
    for (let j = 0; j < board[i].length; j++) {
      if (board[i][j] === '') {
        return false;
      }
    }
  }
  return true;
}

function determineWinner(players) {
  if (players[0].score > players[1].score) return 0;
  if (players[1].score > players[0].score) return 1;
  return -1; // Tie
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor`);
  console.log(`http://localhost:${PORT} adresinden erişebilirsiniz`);
});