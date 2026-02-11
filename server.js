require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require("socket.io");
const path = require('path');
const cors = require('cors');

// --- CONFIG ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

// --- DEBUGGING LOGS ---
console.log("🚀 Server starting...");
console.log("Checking MONGO_URL:", process.env.MONGO_URL ? "✅ FOUND" : "❌ MISSING (App will crash)");

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel')
    .then(() => console.log('✅ Connected to MongoDB Successfully'))
    .catch(err => {
        console.error('❌ FATAL MONGODB ERROR:', err.message);
        // Do not exit process, keep alive to show logs
    });

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true, 
        unique: true, 
        match: /^[A-Za-z0-9]+$/ 
    },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    role: { type: String, default: 'user' }, 
    banned: { type: Boolean, default: false },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    type: String, 
    amount: Number,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// --- AUTH ROUTES (With Debugging) ---
app.post('/api/register', async (req, res) => {
    console.log("📝 Register Request:", req.body.username);
    
    const { username, password } = req.body;
    
    if (!/^[A-Za-z0-9]{5,12}$/.test(username)) {
        console.log("❌ Validation Fail: Username format");
        return res.status(400).json({ error: "Username: 5-12 chars, letters/numbers only." });
    }
    if (password.length < 5 || password.length > 12) {
        console.log("❌ Validation Fail: Password length");
        return res.status(400).json({ error: "Password: 5-12 chars." });
    }

    try {
        const existing = await User.findOne({ username });
        if (existing) {
            console.log("❌ User exists");
            return res.status(400).json({ error: "Username taken." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        
        const newUser = new User({ 
            username, 
            password: hashedPassword, 
            role: isFirst ? 'admin' : 'user' 
        });
        await newUser.save();
        
        console.log("✅ User Created:", username);
        res.status(201).json({ message: "Registered successfully" });
    } catch (err) { 
        console.error("❌ REGISTER SERVER ERROR:", err); // CHECK RAILWAY LOGS FOR THIS
        res.status(500).json({ error: "Database Connection Error. Check Server Logs." }); 
    }
});

app.post('/api/login', async (req, res) => {
    console.log("🔑 Login Request:", req.body.username);
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });
        if (user.banned) return res.status(403).json({ error: "Account Banned" });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: "Invalid password" });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'devsecret');
        
        console.log("✅ Login Success:", username);
        res.cookie('token', token, { httpOnly: true }).json({ 
            message: "Logged in", 
            user: { username: user.username, role: user.role, balance: user.balance }
        });
    } catch (err) { 
        console.error("❌ LOGIN SERVER ERROR:", err);
        res.status(500).json({ error: "Login System Error" }); 
    }
});

app.post('/api/logout', (req, res) => res.clearCookie('token').json({ message: "Logged out" }));

// --- GAME STATE & SOCKETS ---
let players = {};
let duelState = {
    seatLeft: null, seatRight: null,
    gameType: 'coin', matchMode: 'bo3',
    betAmount: 0, status: 'open',
    leftLocked: false, rightLocked: false,
    pot: 0, scores: { left: 0, right: 0 },
    actions: { left: null, right: null },
    spectatorBets: {}
};
const NEON_COLORS = ["#ff00ff", "#00ffff", "#00ff00", "#ffff00", "#ff3333"];

io.on('connection', (socket) => {
    socket.on('join_game', async ({ username }) => {
        try {
            const dbUser = await User.findOne({ username });
            if(!dbUser) return;
            
            const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
            players[socket.id] = {
                id: socket.id,
                dbId: dbUser._id.toString(),
                username: dbUser.username,
                balance: dbUser.balance,
                color: color,
                avatar: `https://api.dicebear.com/7.x/pixel-art/svg?seed=${dbUser.username}`
            };
            
            io.emit('chat_message', { type: 'system', text: `${username} joined.`, color: '#fff' });
            broadcastUpdate();
        } catch(e) { console.error("Socket Join Error:", e); }
    });

    socket.on('send_chat', (msg) => {
        const p = players[socket.id];
        if(p && msg.trim().length > 0) {
            io.emit('chat_message', { type: 'user', name: p.username, text: msg, color: p.color });
        }
    });

    socket.on('take_seat', (side) => {
        if (!players[socket.id]) return;
        if (side === 'left' && !duelState.seatLeft) duelState.seatLeft = socket.id;
        else if (side === 'right' && !duelState.seatRight) duelState.seatRight = socket.id;
        resetLocks(); broadcastUpdate();
    });

    socket.on('leave_seat', () => {
        if (duelState.seatLeft === socket.id) duelState.seatLeft = null;
        if (duelState.seatRight === socket.id) duelState.seatRight = null;
        resetGame(); broadcastUpdate();
    });

    socket.on('update_settings', (data) => {
        if (!isSeated(socket.id) || duelState.status !== 'open') return;
        if (data.bet) duelState.betAmount = parseInt(data.bet);
        if (data.game) duelState.gameType = data.game;
        if (data.mode) duelState.matchMode = data.mode;
        resetLocks(); broadcastUpdate();
    });

    socket.on('lock_in', async () => {
        if (!isSeated(socket.id)) return;
        const p = players[socket.id];
        const user = await User.findById(p.dbId);
        
        if (user.balance < duelState.betAmount) {
            socket.emit('chat_message', { type: 'system', text: 'Insufficient Funds!', color: 'red' });
            return;
        }

        if (duelState.seatLeft === socket.id) duelState.leftLocked = !duelState.leftLocked;
        if (duelState.seatRight === socket.id) duelState.rightLocked = !duelState.rightLocked;
        broadcastUpdate();

        if (duelState.seatLeft && duelState.seatRight && duelState.leftLocked && duelState.rightLocked && duelState.betAmount > 0) {
            startMatch();
        }
    });

    socket.on('perform_action', () => {
        if (duelState.status !== 'interactive') return;
        if (socket.id === duelState.seatLeft) duelState.actions.left = true;
        if (socket.id === duelState.seatRight) duelState.actions.right = true;
        broadcastUpdate();
        if (duelState.actions.left && duelState.actions.right) calculateRoundResult();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (duelState.seatLeft === socket.id || duelState.seatRight === socket.id) resetGame();
        broadcastUpdate();
    });
});

// --- HELPERS ---
function isSeated(id) { return duelState.seatLeft === id || duelState.seatRight === id; }
function resetLocks() { duelState.leftLocked=false; duelState.rightLocked=false; duelState.status='open'; duelState.actions={left:null,right:null}; }
function resetGame() { resetLocks(); duelState.pot=0; duelState.result=null; duelState.winnerId=null; duelState.seatLeft=null; duelState.seatRight=null; duelState.scores={left:0,right:0}; }
function broadcastUpdate() { io.emit('state_update', { players, duel: duelState }); }

async function startMatch() {
    duelState.status = 'locked';
    duelState.pot = duelState.betAmount * 2;
    const p1 = players[duelState.seatLeft];
    const p2 = players[duelState.seatRight];
    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duelState.betAmount } });
    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duelState.betAmount } });
    p1.balance -= duelState.betAmount;
    p2.balance -= duelState.betAmount;
    broadcastUpdate();
    setTimeout(startRound, 2000);
}

function startRound() {
    duelState.actions = { left: null, right: null };
    if (duelState.gameType === 'coin') { duelState.status = 'rolling'; calculateRoundResult(); }
    else { duelState.status = 'interactive'; broadcastUpdate(); }
}

function calculateRoundResult() {
    duelState.status = 'rolling';
    let isLeftWinner = Math.random() < 0.5;
    let result = {};
    if (duelState.gameType === 'coin') result.outcome = isLeftWinner ? 'heads' : 'tails';
    else {
        // Dice or Wheel random logic
        const r = () => Math.floor(Math.random()*6)+1;
        let l=[r(),r(),r()], ri=[r(),r(),r()]; 
        isLeftWinner = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
        result = { left: l, right: ri };
    }
    duelState.result = result;
    broadcastUpdate();

    setTimeout(async () => {
        if (isLeftWinner) duelState.scores.left++; else duelState.scores.right++;
        let target = duelState.matchMode === 'bo5' ? 3 : 2;
        let winnerId = null;
        if (duelState.scores.left >= target) winnerId = duelState.seatLeft;
        if (duelState.scores.right >= target) winnerId = duelState.seatRight;

        if (winnerId) {
            duelState.status = 'finished';
            duelState.winnerId = winnerId;
            const winner = players[winnerId];
            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duelState.pot } });
            winner.balance += duelState.pot;
            broadcastUpdate();
            setTimeout(() => { resetGame(); broadcastUpdate(); }, 6000);
        } else {
            duelState.status = 'round_end';
            broadcastUpdate();
            setTimeout(startRound, 3000);
        }
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
