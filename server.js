 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server.js b/server.js
index 7d5c1d9ad061d75e82738c766c012104546a82ed..8ed1802f3a177124b5cd17454b6d68a2487f60ad 100644
--- a/server.js
+++ b/server.js
@@ -1,379 +1,401 @@
-require('dotenv').config();
-const express = require('express');
-const http = require('http');
-const mongoose = require('mongoose');
-const cookieParser = require('cookie-parser');
-const bcrypt = require('bcryptjs');
-const jwt = require('jsonwebtoken');
-const { Server } = require("socket.io");
-const path = require('path');
-const cors = require('cors');
-
-// --- CONFIG ---
-const app = express();
-const server = http.createServer(app);
-const io = new Server(server);
-
-app.use(express.json());
-app.use(cookieParser());
-app.use(express.static(path.join(__dirname, 'public')));
-app.use(cors());
-
-// --- MONGODB CONNECTION ---
-// If on Railway, this uses the MONGO_URL env var. Local fallback provided.
-mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel')
-    .then(() => console.log('✅ Connected to MongoDB'))
-    .catch(err => console.error('❌ MongoDB Error:', err));
-
-// --- SCHEMAS ---
-const userSchema = new mongoose.Schema({
-    username: { 
-        type: String, 
-        required: true, 
-        unique: true, 
-        match: /^[A-Za-z0-9]+$/ 
-    },
-    password: { type: String, required: true },
-    balance: { type: Number, default: 1000 },
-    role: { type: String, default: 'user' }, // 'user' or 'admin'
-    banned: { type: Boolean, default: false },
-    wins: { type: Number, default: 0 },
-    losses: { type: Number, default: 0 },
-    createdAt: { type: Date, default: Date.now }
-});
-
-const transactionSchema = new mongoose.Schema({
-    userId: mongoose.Schema.Types.ObjectId,
-    type: String, // 'DEPOSIT', 'WITHDRAW', 'BET_WIN', 'BET_LOSS'
-    amount: Number,
-    timestamp: { type: Date, default: Date.now }
-});
-
-const User = mongoose.model('User', userSchema);
-const Transaction = mongoose.model('Transaction', transactionSchema);
-
-// --- AUTH MIDDLEWARE ---
-const authenticateToken = (req, res, next) => {
-    const token = req.cookies.token;
-    if (!token) return res.status(401).json({ error: "Access denied" });
-    try {
-        const verified = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
-        req.user = verified;
-        next();
-    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
-};
-
-const adminAuth = async (req, res, next) => {
-    const token = req.cookies.token;
-    if (!token) return res.status(401).json({ error: "Access denied" });
-    try {
-        const verified = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
-        const user = await User.findById(verified._id);
-        if (user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
-        req.user = user;
-        next();
-    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
-};
-
-// --- AUTH ROUTES ---
-app.post('/api/register', async (req, res) => {
-    const { username, password } = req.body;
-    
-    // Strict Validation
-    if (!/^[A-Za-z0-9]{5,12}$/.test(username)) return res.status(400).json({ error: "Username must be 5-12 chars, letters/numbers only." });
-    if (password.length < 5 || password.length > 12) return res.status(400).json({ error: "Password must be 5-12 chars." });
-
-    try {
-        const existing = await User.findOne({ username });
-        if (existing) return res.status(400).json({ error: "Username taken." });
-
-        const hashedPassword = await bcrypt.hash(password, 10);
-        // First user is Admin
-        const isFirst = (await User.countDocuments({})) === 0;
-        
-        const newUser = new User({ 
-            username, 
-            password: hashedPassword, 
-            role: isFirst ? 'admin' : 'user' 
-        });
-        await newUser.save();
-        
-        res.status(201).json({ message: "Registered successfully" });
-    } catch (err) { res.status(500).json({ error: "Server error" }); }
-});
-
-app.post('/api/login', async (req, res) => {
-    const { username, password } = req.body;
-    try {
-        const user = await User.findOne({ username });
-        if (!user) return res.status(400).json({ error: "User not found" });
-        if (user.banned) return res.status(403).json({ error: "Account Banned" });
-
-        const validPass = await bcrypt.compare(password, user.password);
-        if (!validPass) return res.status(400).json({ error: "Invalid password" });
-
-        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'devsecret');
-        res.cookie('token', token, { httpOnly: true }).json({ 
-            message: "Logged in", 
-            user: { username: user.username, role: user.role, balance: user.balance }
-        });
-    } catch (err) { res.status(500).json({ error: "Server error" }); }
-});
-
-app.post('/api/logout', (req, res) => res.clearCookie('token').json({ message: "Logged out" }));
-
-// --- ADMIN API ROUTES ---
-app.get('/api/admin/users', adminAuth, async (req, res) => {
-    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
-    res.json(users);
-});
-
-// Top-up (Deposit) & Withdraw
-app.post('/api/admin/transaction', adminAuth, async (req, res) => {
-    const { userId, type, amount } = req.body; // type: 'DEPOSIT' or 'WITHDRAW'
-    const val = parseInt(amount);
-    
-    try {
-        if(type === 'DEPOSIT') {
-            await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
-        } else if (type === 'WITHDRAW') {
-            await User.findByIdAndUpdate(userId, { $inc: { balance: -val } });
-        }
-        
-        // Log Transaction
-        await new Transaction({ userId, type, amount: val }).save();
-        
-        // Live Update via Socket
-        const targetSocket = Object.keys(players).find(key => players[key].dbId === userId);
-        if(targetSocket) {
-            const updatedUser = await User.findById(userId);
-            players[targetSocket].balance = updatedUser.balance;
-            io.to(targetSocket).emit('state_update', { players, duel: duelState }); // Refresh their UI
-            io.to(targetSocket).emit('chat_message', { type: 'system', text: `Admin processed ${type}: $${val}`, color:'#ffd700' });
-        }
-        
-        res.json({ message: "Transaction successful" });
-    } catch (err) { res.status(500).json({ error: "Transaction failed" }); }
-});
-
-app.post('/api/admin/ban', adminAuth, async (req, res) => {
-    const { userId, ban } = req.body;
-    await User.findByIdAndUpdate(userId, { banned: ban });
-    // Kick if online
-    const targetSocket = Object.keys(players).find(key => players[key].dbId === userId);
-    if(targetSocket && ban) io.sockets.sockets.get(targetSocket)?.disconnect();
-    
-    res.json({ message: "User status updated" });
-});
-
-// --- GAME STATE ---
-let players = {};
-const NEON_COLORS = ["#ff00ff", "#00ffff", "#00ff00", "#ffff00", "#ff3333"];
-
-let duelState = {
-    seatLeft: null, seatRight: null,
-    gameType: 'coin', matchMode: 'bo3',
-    betAmount: 0, status: 'open',
-    leftLocked: false, rightLocked: false,
-    pot: 0, scores: { left: 0, right: 0 },
-    actions: { left: null, right: null },
-    spectatorBets: {}
-};
-
-io.on('connection', (socket) => {
-    
-    // Auth Handshake for Socket (simplified)
-    socket.on('join_game', async ({ username }) => {
-        const dbUser = await User.findOne({ username });
-        if(!dbUser) return;
-
-        const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
-        
-        players[socket.id] = {
-            id: socket.id,
-            dbId: dbUser._id.toString(),
-            username: dbUser.username,
-            balance: dbUser.balance,
-            color: color,
-            avatar: `https://api.dicebear.com/7.x/pixel-art/svg?seed=${dbUser.username}`
-        };
-        
-        io.emit('chat_message', { type: 'system', text: `${username} joined.`, color: '#fff' });
-        broadcastUpdate();
-    });
-
-    // Chat
-    socket.on('send_chat', (msg) => {
-        const p = players[socket.id];
-        if(p && msg.trim().length > 0) {
-            io.emit('chat_message', { type: 'user', name: p.username, text: msg, color: p.color });
-        }
-    });
-
-    // Seats
-    socket.on('take_seat', (side) => {
-        if (!players[socket.id]) return;
-        if (side === 'left' && !duelState.seatLeft) duelState.seatLeft = socket.id;
-        else if (side === 'right' && !duelState.seatRight) duelState.seatRight = socket.id;
-        resetLocks(); broadcastUpdate();
-    });
-
-    socket.on('leave_seat', () => {
-        if (duelState.seatLeft === socket.id) duelState.seatLeft = null;
-        if (duelState.seatRight === socket.id) duelState.seatRight = null;
-        resetGame(); broadcastUpdate();
-    });
-
-    // Settings Sync
-    socket.on('update_settings', (data) => {
-        if (!isSeated(socket.id) || duelState.status !== 'open') return;
-        if (data.bet) duelState.betAmount = parseInt(data.bet);
-        if (data.game) duelState.gameType = data.game;
-        if (data.mode) duelState.matchMode = data.mode;
-        resetLocks(); broadcastUpdate();
-    });
-
-    // Lock In & Start
-    socket.on('lock_in', async () => {
-        if (!isSeated(socket.id)) return;
-        const p = players[socket.id];
-        
-        // Check DB Balance
-        const user = await User.findById(p.dbId);
-        if (user.balance < duelState.betAmount) return; // Silent fail or emit error
-
-        if (duelState.seatLeft === socket.id) duelState.leftLocked = !duelState.leftLocked;
-        if (duelState.seatRight === socket.id) duelState.rightLocked = !duelState.rightLocked;
-        broadcastUpdate();
-
-        if (duelState.seatLeft && duelState.seatRight && duelState.leftLocked && duelState.rightLocked && duelState.betAmount > 0) {
-            startMatch();
-        }
-    });
-
-    // Spectator Betting
-    socket.on('place_spectator_bet', async (data) => {
-        if (isSeated(socket.id) || duelState.status !== 'open') return;
-        const p = players[socket.id];
-        const user = await User.findById(p.dbId);
-        
-        if (user.balance >= data.amount) {
-            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: -data.amount } });
-            p.balance -= data.amount;
-            duelState.spectatorBets[socket.id] = { side: data.side, amount: parseInt(data.amount) };
-            
-            io.to(socket.id).emit('chat_message', { type: 'system', text: `Bet placed on ${data.side}`, color: '#ffd700' });
-            broadcastUpdate();
-        }
-    });
-
-    // Action
-    socket.on('perform_action', () => {
-        if (duelState.status !== 'interactive') return;
-        if (socket.id === duelState.seatLeft) duelState.actions.left = true;
-        if (socket.id === duelState.seatRight) duelState.actions.right = true;
-        broadcastUpdate();
-
-        if (duelState.actions.left && duelState.actions.right) calculateRoundResult();
-    });
-
-    socket.on('disconnect', () => {
-        delete players[socket.id];
-        delete duelState.spectatorBets[socket.id];
-        if (duelState.seatLeft === socket.id || duelState.seatRight === socket.id) resetGame();
-        broadcastUpdate();
-    });
-});
-
-// --- GAME LOGIC HELPERS ---
-function isSeated(id) { return duelState.seatLeft === id || duelState.seatRight === id; }
-function resetLocks() { duelState.leftLocked = false; duelState.rightLocked = false; duelState.status = 'open'; duelState.scores = { left: 0, right: 0 }; duelState.actions = { left: null, right: null }; duelState.spectatorBets = {}; }
-function resetGame() { resetLocks(); duelState.pot = 0; duelState.result = null; duelState.winnerId = null; duelState.seatLeft = null; duelState.seatRight = null; }
-function broadcastUpdate() { io.emit('state_update', { players, duel: duelState }); }
-
-async function startMatch() {
-    duelState.status = 'locked';
-    duelState.pot = duelState.betAmount * 2;
-    
-    // DB Deduct
-    const p1 = players[duelState.seatLeft];
-    const p2 = players[duelState.seatRight];
-    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duelState.betAmount } });
-    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duelState.betAmount } });
-    p1.balance -= duelState.betAmount;
-    p2.balance -= duelState.betAmount;
-
-    broadcastUpdate();
-    setTimeout(startRound, 2000);
-}
-
-function startRound() {
-    duelState.actions = { left: null, right: null };
-    if (duelState.gameType === 'coin') { duelState.status = 'rolling'; calculateRoundResult(); }
-    else { duelState.status = 'interactive'; broadcastUpdate(); }
-}
-
-function calculateRoundResult() {
-    duelState.status = 'rolling';
-    let isLeftWinner = Math.random() < 0.5;
-    let result = {};
-
-    if (duelState.gameType === 'coin') result.outcome = isLeftWinner ? 'heads' : 'tails';
-    else if (duelState.gameType === 'dice') {
-        const r = () => Math.floor(Math.random()*6)+1;
-        let l=[r(),r(),r()], ri=[r(),r(),r()]; 
-        // Logic: Compare Sums
-        isLeftWinner = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
-        result = { left: l, right: ri };
-    } 
-    else { // Wheel
-        const s = () => Math.floor(Math.random()*9);
-        let l=[s(),s(),s()], ri=[s(),s(),s()];
-        isLeftWinner = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
-        result = { left: l, right: ri };
-    }
-    duelState.result = result;
-    broadcastUpdate();
-
-    setTimeout(async () => {
-        if (isLeftWinner) duelState.scores.left++; else duelState.scores.right++;
-        
-        let target = 2; // BO3 default
-        if (duelState.matchMode === 'bo5') target = 3;
-        if (duelState.matchMode === 'race3') target = 3;
-        if (duelState.matchMode === 'race5') target = 5;
-
-        let winnerId = null;
-        if (duelState.scores.left >= target) winnerId = duelState.seatLeft;
-        if (duelState.scores.right >= target) winnerId = duelState.seatRight;
-
-        if (winnerId) {
-            duelState.status = 'finished';
-            duelState.winnerId = winnerId;
-            const winner = players[winnerId];
-            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duelState.pot } });
-            winner.balance += duelState.pot;
-
-            // Payout Spectators (House logic: 1:1)
-            const winSide = winnerId === duelState.seatLeft ? 'left' : 'right';
-            for (const [sid, bet] of Object.entries(duelState.spectatorBets)) {
-                if (bet.side === winSide && players[sid]) {
-                    const winAmt = bet.amount * 2;
-                    await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: winAmt } });
-                    players[sid].balance += winAmt;
-                    io.to(sid).emit('chat_message', { type: 'system', text: `You won $${winAmt}`, color: '#ffd700' });
-                }
-            }
-            
-            broadcastUpdate();
-            setTimeout(() => { resetGame(); broadcastUpdate(); }, 6000);
-        } else {
-            duelState.status = 'round_end';
-            broadcastUpdate();
-            setTimeout(startRound, 3000);
-        }
-    }, 4000);
-}
-
-const PORT = process.env.PORT || 3000;
-server.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
+require('dotenv').config();
+const express = require('express');
+const http = require('http');
+const mongoose = require('mongoose');
+const cookieParser = require('cookie-parser');
+const bcrypt = require('bcryptjs');
+const jwt = require('jsonwebtoken');
+const { Server } = require("socket.io");
+const path = require('path');
+const cors = require('cors');
+
+// --- CONFIG ---
+const app = express();
+const server = http.createServer(app);
+const io = new Server(server);
+
+app.use(express.json());
+app.use(cookieParser());
+app.use(express.static(path.join(__dirname, 'public')));
+app.use(cors());
+
+// --- MONGODB CONNECTION ---
+// Accept both common env names used by hosting providers.
+const mongoUri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sticknduel';
+mongoose.set('bufferCommands', false);
+mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
+    .then(() => console.log('✅ Connected to MongoDB'))
+    .catch(err => {
+        console.error('❌ MongoDB Error:', err.message);
+        console.error('ℹ️  Set MONGO_URL (or MONGODB_URI) to a reachable MongoDB connection string.');
+    });
+
+// --- SCHEMAS ---
+const userSchema = new mongoose.Schema({
+    username: { 
+        type: String, 
+        required: true, 
+        unique: true, 
+        match: /^[A-Za-z0-9]+$/ 
+    },
+    password: { type: String, required: true },
+    balance: { type: Number, default: 1000 },
+    role: { type: String, default: 'user' }, // 'user' or 'admin'
+    banned: { type: Boolean, default: false },
+    wins: { type: Number, default: 0 },
+    losses: { type: Number, default: 0 },
+    createdAt: { type: Date, default: Date.now }
+});
+
+const transactionSchema = new mongoose.Schema({
+    userId: mongoose.Schema.Types.ObjectId,
+    type: String, // 'DEPOSIT', 'WITHDRAW', 'BET_WIN', 'BET_LOSS'
+    amount: Number,
+    timestamp: { type: Date, default: Date.now }
+});
+
+const User = mongoose.model('User', userSchema);
+const Transaction = mongoose.model('Transaction', transactionSchema);
+
+const isDatabaseUnavailableError = (err) => {
+    const msg = err?.message || '';
+    return err?.name === 'MongooseServerSelectionError' || /buffering timed out|before initial connection|econnrefused/i.test(msg);
+};
+
+// --- AUTH MIDDLEWARE ---
+const authenticateToken = (req, res, next) => {
+    const token = req.cookies.token;
+    if (!token) return res.status(401).json({ error: "Access denied" });
+    try {
+        const verified = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
+        req.user = verified;
+        next();
+    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
+};
+
+const adminAuth = async (req, res, next) => {
+    const token = req.cookies.token;
+    if (!token) return res.status(401).json({ error: "Access denied" });
+    try {
+        const verified = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
+        const user = await User.findById(verified._id);
+        if (user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
+        req.user = user;
+        next();
+    } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
+};
+
+// --- AUTH ROUTES ---
+app.post('/api/register', async (req, res) => {
+    const { username, password } = req.body;
+    
+    // Strict Validation
+    if (!/^[A-Za-z0-9]{5,12}$/.test(username)) return res.status(400).json({ error: "Username must be 5-12 chars, letters/numbers only." });
+    if (password.length < 5 || password.length > 12) return res.status(400).json({ error: "Password must be 5-12 chars." });
+
+    try {
+        const existing = await User.findOne({ username });
+        if (existing) return res.status(400).json({ error: "Username taken." });
+
+        const hashedPassword = await bcrypt.hash(password, 10);
+        // First user is Admin
+        const isFirst = (await User.countDocuments({})) === 0;
+        
+        const newUser = new User({ 
+            username, 
+            password: hashedPassword, 
+            role: isFirst ? 'admin' : 'user' 
+        });
+        await newUser.save();
+        
+        res.status(201).json({ message: "Registered successfully" });
+    } catch (err) {
+        console.error('Register error:', err.message);
+        if (isDatabaseUnavailableError(err)) {
+            return res.status(503).json({ error: "Database unavailable. Check MONGO_URL/MONGODB_URI." });
+        }
+        res.status(500).json({ error: "Server error" });
+    }
+});
+
+app.post('/api/login', async (req, res) => {
+    const { username, password } = req.body;
+    try {
+        const user = await User.findOne({ username });
+        if (!user) return res.status(400).json({ error: "User not found" });
+        if (user.banned) return res.status(403).json({ error: "Account Banned" });
+
+        const validPass = await bcrypt.compare(password, user.password);
+        if (!validPass) return res.status(400).json({ error: "Invalid password" });
+
+        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'devsecret');
+        res.cookie('token', token, { httpOnly: true }).json({ 
+            message: "Logged in", 
+            user: { username: user.username, role: user.role, balance: user.balance }
+        });
+    } catch (err) {
+        console.error('Login error:', err.message);
+        if (isDatabaseUnavailableError(err)) {
+            return res.status(503).json({ error: "Database unavailable. Check MONGO_URL/MONGODB_URI." });
+        }
+        res.status(500).json({ error: "Server error" });
+    }
+});
+
+app.post('/api/logout', (req, res) => res.clearCookie('token').json({ message: "Logged out" }));
+
+// --- ADMIN API ROUTES ---
+app.get('/api/admin/users', adminAuth, async (req, res) => {
+    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
+    res.json(users);
+});
+
+// Top-up (Deposit) & Withdraw
+app.post('/api/admin/transaction', adminAuth, async (req, res) => {
+    const { userId, type, amount } = req.body; // type: 'DEPOSIT' or 'WITHDRAW'
+    const val = parseInt(amount);
+    
+    try {
+        if(type === 'DEPOSIT') {
+            await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
+        } else if (type === 'WITHDRAW') {
+            await User.findByIdAndUpdate(userId, { $inc: { balance: -val } });
+        }
+        
+        // Log Transaction
+        await new Transaction({ userId, type, amount: val }).save();
+        
+        // Live Update via Socket
+        const targetSocket = Object.keys(players).find(key => players[key].dbId === userId);
+        if(targetSocket) {
+            const updatedUser = await User.findById(userId);
+            players[targetSocket].balance = updatedUser.balance;
+            io.to(targetSocket).emit('state_update', { players, duel: duelState }); // Refresh their UI
+            io.to(targetSocket).emit('chat_message', { type: 'system', text: `Admin processed ${type}: $${val}`, color:'#ffd700' });
+        }
+        
+        res.json({ message: "Transaction successful" });
+    } catch (err) { res.status(500).json({ error: "Transaction failed" }); }
+});
+
+app.post('/api/admin/ban', adminAuth, async (req, res) => {
+    const { userId, ban } = req.body;
+    await User.findByIdAndUpdate(userId, { banned: ban });
+    // Kick if online
+    const targetSocket = Object.keys(players).find(key => players[key].dbId === userId);
+    if(targetSocket && ban) io.sockets.sockets.get(targetSocket)?.disconnect();
+    
+    res.json({ message: "User status updated" });
+});
+
+// --- GAME STATE ---
+let players = {};
+const NEON_COLORS = ["#ff00ff", "#00ffff", "#00ff00", "#ffff00", "#ff3333"];
+
+let duelState = {
+    seatLeft: null, seatRight: null,
+    gameType: 'coin', matchMode: 'bo3',
+    betAmount: 0, status: 'open',
+    leftLocked: false, rightLocked: false,
+    pot: 0, scores: { left: 0, right: 0 },
+    actions: { left: null, right: null },
+    spectatorBets: {}
+};
+
+io.on('connection', (socket) => {
+    
+    // Auth Handshake for Socket (simplified)
+    socket.on('join_game', async ({ username }) => {
+        const dbUser = await User.findOne({ username });
+        if(!dbUser) return;
+
+        const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
+        
+        players[socket.id] = {
+            id: socket.id,
+            dbId: dbUser._id.toString(),
+            username: dbUser.username,
+            balance: dbUser.balance,
+            color: color,
+            avatar: `https://api.dicebear.com/7.x/pixel-art/svg?seed=${dbUser.username}`
+        };
+        
+        io.emit('chat_message', { type: 'system', text: `${username} joined.`, color: '#fff' });
+        broadcastUpdate();
+    });
+
+    // Chat
+    socket.on('send_chat', (msg) => {
+        const p = players[socket.id];
+        if(p && msg.trim().length > 0) {
+            io.emit('chat_message', { type: 'user', name: p.username, text: msg, color: p.color });
+        }
+    });
+
+    // Seats
+    socket.on('take_seat', (side) => {
+        if (!players[socket.id]) return;
+        if (side === 'left' && !duelState.seatLeft) duelState.seatLeft = socket.id;
+        else if (side === 'right' && !duelState.seatRight) duelState.seatRight = socket.id;
+        resetLocks(); broadcastUpdate();
+    });
+
+    socket.on('leave_seat', () => {
+        if (duelState.seatLeft === socket.id) duelState.seatLeft = null;
+        if (duelState.seatRight === socket.id) duelState.seatRight = null;
+        resetGame(); broadcastUpdate();
+    });
+
+    // Settings Sync
+    socket.on('update_settings', (data) => {
+        if (!isSeated(socket.id) || duelState.status !== 'open') return;
+        if (data.bet) duelState.betAmount = parseInt(data.bet);
+        if (data.game) duelState.gameType = data.game;
+        if (data.mode) duelState.matchMode = data.mode;
+        resetLocks(); broadcastUpdate();
+    });
+
+    // Lock In & Start
+    socket.on('lock_in', async () => {
+        if (!isSeated(socket.id)) return;
+        const p = players[socket.id];
+        
+        // Check DB Balance
+        const user = await User.findById(p.dbId);
+        if (user.balance < duelState.betAmount) return; // Silent fail or emit error
+
+        if (duelState.seatLeft === socket.id) duelState.leftLocked = !duelState.leftLocked;
+        if (duelState.seatRight === socket.id) duelState.rightLocked = !duelState.rightLocked;
+        broadcastUpdate();
+
+        if (duelState.seatLeft && duelState.seatRight && duelState.leftLocked && duelState.rightLocked && duelState.betAmount > 0) {
+            startMatch();
+        }
+    });
+
+    // Spectator Betting
+    socket.on('place_spectator_bet', async (data) => {
+        if (isSeated(socket.id) || duelState.status !== 'open') return;
+        const p = players[socket.id];
+        const user = await User.findById(p.dbId);
+        
+        if (user.balance >= data.amount) {
+            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: -data.amount } });
+            p.balance -= data.amount;
+            duelState.spectatorBets[socket.id] = { side: data.side, amount: parseInt(data.amount) };
+            
+            io.to(socket.id).emit('chat_message', { type: 'system', text: `Bet placed on ${data.side}`, color: '#ffd700' });
+            broadcastUpdate();
+        }
+    });
+
+    // Action
+    socket.on('perform_action', () => {
+        if (duelState.status !== 'interactive') return;
+        if (socket.id === duelState.seatLeft) duelState.actions.left = true;
+        if (socket.id === duelState.seatRight) duelState.actions.right = true;
+        broadcastUpdate();
+
+        if (duelState.actions.left && duelState.actions.right) calculateRoundResult();
+    });
+
+    socket.on('disconnect', () => {
+        delete players[socket.id];
+        delete duelState.spectatorBets[socket.id];
+        if (duelState.seatLeft === socket.id || duelState.seatRight === socket.id) resetGame();
+        broadcastUpdate();
+    });
+});
+
+// --- GAME LOGIC HELPERS ---
+function isSeated(id) { return duelState.seatLeft === id || duelState.seatRight === id; }
+function resetLocks() { duelState.leftLocked = false; duelState.rightLocked = false; duelState.status = 'open'; duelState.scores = { left: 0, right: 0 }; duelState.actions = { left: null, right: null }; duelState.spectatorBets = {}; }
+function resetGame() { resetLocks(); duelState.pot = 0; duelState.result = null; duelState.winnerId = null; duelState.seatLeft = null; duelState.seatRight = null; }
+function broadcastUpdate() { io.emit('state_update', { players, duel: duelState }); }
+
+async function startMatch() {
+    duelState.status = 'locked';
+    duelState.pot = duelState.betAmount * 2;
+    
+    // DB Deduct
+    const p1 = players[duelState.seatLeft];
+    const p2 = players[duelState.seatRight];
+    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duelState.betAmount } });
+    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duelState.betAmount } });
+    p1.balance -= duelState.betAmount;
+    p2.balance -= duelState.betAmount;
+
+    broadcastUpdate();
+    setTimeout(startRound, 2000);
+}
+
+function startRound() {
+    duelState.actions = { left: null, right: null };
+    if (duelState.gameType === 'coin') { duelState.status = 'rolling'; calculateRoundResult(); }
+    else { duelState.status = 'interactive'; broadcastUpdate(); }
+}
+
+function calculateRoundResult() {
+    duelState.status = 'rolling';
+    let isLeftWinner = Math.random() < 0.5;
+    let result = {};
+
+    if (duelState.gameType === 'coin') result.outcome = isLeftWinner ? 'heads' : 'tails';
+    else if (duelState.gameType === 'dice') {
+        const r = () => Math.floor(Math.random()*6)+1;
+        let l=[r(),r(),r()], ri=[r(),r(),r()]; 
+        // Logic: Compare Sums
+        isLeftWinner = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
+        result = { left: l, right: ri };
+    } 
+    else { // Wheel
+        const s = () => Math.floor(Math.random()*9);
+        let l=[s(),s(),s()], ri=[s(),s(),s()];
+        isLeftWinner = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
+        result = { left: l, right: ri };
+    }
+    duelState.result = result;
+    broadcastUpdate();
+
+    setTimeout(async () => {
+        if (isLeftWinner) duelState.scores.left++; else duelState.scores.right++;
+        
+        let target = 2; // BO3 default
+        if (duelState.matchMode === 'bo5') target = 3;
+        if (duelState.matchMode === 'race3') target = 3;
+        if (duelState.matchMode === 'race5') target = 5;
+
+        let winnerId = null;
+        if (duelState.scores.left >= target) winnerId = duelState.seatLeft;
+        if (duelState.scores.right >= target) winnerId = duelState.seatRight;
+
+        if (winnerId) {
+            duelState.status = 'finished';
+            duelState.winnerId = winnerId;
+            const winner = players[winnerId];
+            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duelState.pot } });
+            winner.balance += duelState.pot;
+
+            // Payout Spectators (House logic: 1:1)
+            const winSide = winnerId === duelState.seatLeft ? 'left' : 'right';
+            for (const [sid, bet] of Object.entries(duelState.spectatorBets)) {
+                if (bet.side === winSide && players[sid]) {
+                    const winAmt = bet.amount * 2;
+                    await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: winAmt } });
+                    players[sid].balance += winAmt;
+                    io.to(sid).emit('chat_message', { type: 'system', text: `You won $${winAmt}`, color: '#ffd700' });
+                }
+            }
+            
+            broadcastUpdate();
+            setTimeout(() => { resetGame(); broadcastUpdate(); }, 6000);
+        } else {
+            duelState.status = 'round_end';
+            broadcastUpdate();
+            setTimeout(startRound, 3000);
+        }
+    }, 4000);
+}
+
+const PORT = process.env.PORT || 3000;
+server.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
 
EOF
)
