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

// --- 1. CRITICAL CONFIG CHECK ---
console.log("------------------------------------------------");
console.log("🚀 STARTING STICK N' DUEL SERVER");
console.log("------------------------------------------------");

if (!process.env.MONGO_URL) {
    console.error("❌ CRITICAL ERROR: MONGO_URL Environment Variable is MISSING!");
    console.error("👉 FIX: Go to Railway -> Service -> Variables -> Add MONGO_URL");
    // We do NOT exit process here to allow the logs to be read in Railway console
} else {
    console.log("✅ MONGO_URL found. Attempting connection...");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());

// --- 2. ROBUST DATABASE CONNECTION ---
const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/sticknduel', {
            serverSelectionTimeoutMS: 5000 // Fail fast if no connection
        });
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    } catch (err) {
        console.error("❌ MONGODB CONNECTION FAILED");
        console.error("Reason:", err.message);
        console.error("------------------------------------------------");
    }
};
connectDB();

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    role: { type: String, default: 'user' },
    banned: { type: Boolean, default: false },
    color: { type: String, default: '#00ffff' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database not connected. Tell Admin to check logs." });
    }

    if (!/^[A-Za-z0-9]{5,12}$/.test(username)) return res.status(400).json({ error: "Username: 5-12 chars, letters/numbers only." });
    if (password.length < 5 || password.length > 12) return res.status(400).json({ error: "Password: 5-12 chars." });

    try {
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username taken." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        
        const color = ["#00ffff", "#00ff00", "#ffff00", "#ff00ff", "#ff4444"][Math.floor(Math.random()*5)];
        
        await new User({ 
            username, 
            password: hashedPassword, 
            role: isFirst ? 'admin' : 'user',
            color 
        }).save();
        
        res.status(201).json({ message: "Success" });
    } catch (err) { 
        console.error("Register Error:", err);
        res.status(500).json({ error: "Server Error" }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({ error: "Database disconnected." });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });
        if (user.banned) return res.status(403).json({ error: "BANNED" });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: "Invalid password" });

        const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
        
        res.cookie('token', token, { httpOnly: true }).json({ 
            user: { username: user.username, role: user.role, balance: user.balance }
        });
    } catch (err) { res.status(500).json({ error: "Login Error" }); }
});

// --- ADMIN API ---
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ balance: -1 });
        res.json(users);
    } catch(e) { res.status(500).json([]); }
});

app.post('/api/admin/transaction', async (req, res) => {
    const { userId, type, amount } = req.body;
    const val = parseInt(amount);
    try {
        if(type === 'DEPOSIT') await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
        if(type === 'WITHDRAW') await User.findByIdAndUpdate(userId, { $inc: { balance: -val } });
        
        // Update Live Socket
        const socketId = Object.keys(players).find(id => players[id].dbId === userId);
        if(socketId) {
            const u = await User.findById(userId);
            players[socketId].balance = u.balance;
            io.to(socketId).emit('state_update', { players, duel });
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Failed" }); }
});

app.post('/api/admin/ban', async (req, res) => {
    const { userId, status } = req.body;
    await User.findByIdAndUpdate(userId, { banned: status });
    res.json({ success: true });
});

// --- GAME LOGIC ---
let players = {};
let duel = {
    seatLeft: null, seatRight: null,
    gameType: 'coin', matchMode: 'bo3',
    betAmount: 0, status: 'open',
    leftLocked: false, rightLocked: false,
    pot: 0, scores: { left: 0, right: 0 },
    actions: { left: null, right: null },
    spectatorBets: {}, winnerId: null, result: null
};

io.on('connection', (socket) => {
    // JOIN
    socket.on('join_game', async ({ username }) => {
        const dbUser = await User.findOne({ username });
        if(!dbUser) return;
        
        players[socket.id] = {
            id: socket.id,
            dbId: dbUser._id.toString(),
            username: dbUser.username,
            balance: dbUser.balance,
            color: dbUser.color,
            avatar: `https://api.dicebear.com/7.x/pixel-art/svg?seed=${dbUser.username}`
        };
        broadcast();
    });

    // GAME ACTIONS
    socket.on('take_seat', (side) => {
        if(side==='left' && !duel.seatLeft) duel.seatLeft = socket.id;
        if(side==='right' && !duel.seatRight) duel.seatRight = socket.id;
        resetLocks(); broadcast();
    });

    socket.on('leave_seat', () => {
        if(duel.seatLeft===socket.id) duel.seatLeft = null;
        if(duel.seatRight===socket.id) duel.seatRight = null;
        resetGame(); broadcast();
    });

    socket.on('update_settings', (data) => {
        if(socket.id !== duel.seatLeft && socket.id !== duel.seatRight) return;
        if(data.bet) duel.betAmount = parseInt(data.bet);
        if(data.game) duel.gameType = data.game;
        if(data.mode) duel.matchMode = data.mode;
        resetLocks(); broadcast();
    });

    socket.on('lock_in', async () => {
        const p = players[socket.id];
        if(!p) return;
        const u = await User.findById(p.dbId);
        if(u.balance < duel.betAmount) return; 

        if(duel.seatLeft===socket.id) duel.leftLocked = !duel.leftLocked;
        if(duel.seatRight===socket.id) duel.rightLocked = !duel.rightLocked;
        broadcast();

        if(duel.leftLocked && duel.rightLocked && duel.seatLeft && duel.seatRight) startMatch();
    });

    socket.on('perform_action', () => {
        if(duel.status !== 'interactive') return;
        if(socket.id === duel.seatLeft) duel.actions.left = true;
        if(socket.id === duel.seatRight) duel.actions.right = true;
        broadcast();
        if(duel.actions.left && duel.actions.right) resolveRound();
    });

    socket.on('place_spectator_bet', async (data) => {
        const p = players[socket.id];
        if(p && p.balance >= data.amount && duel.status === 'open') {
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: -data.amount } });
            p.balance -= data.amount;
            duel.spectatorBets[socket.id] = { side: data.side, amount: parseInt(data.amount) };
            broadcast();
        }
    });

    socket.on('send_chat', (text) => {
        const p = players[socket.id];
        if(p) io.emit('chat_message', { name: p.username, text, color: p.color });
    });

    socket.on('disconnect', () => {
        if(duel.seatLeft===socket.id || duel.seatRight===socket.id) resetGame();
        delete players[socket.id];
        broadcast();
    });
});

// LOGIC HELPERS
function broadcast() { io.emit('state_update', { players, duel }); }
function resetLocks() { duel.leftLocked=false; duel.rightLocked=false; duel.status='open'; duel.scores={left:0,right:0}; }
function resetGame() { resetLocks(); duel.seatLeft=null; duel.seatRight=null; duel.pot=0; duel.result=null; duel.winnerId=null; }

async function startMatch() {
    duel.status = 'locked';
    duel.pot = duel.betAmount * 2;
    // Deduct
    const p1 = players[duel.seatLeft]; const p2 = players[duel.seatRight];
    await User.findByIdAndUpdate(p1.dbId, { $inc: { balance: -duel.betAmount } });
    await User.findByIdAndUpdate(p2.dbId, { $inc: { balance: -duel.betAmount } });
    p1.balance -= duel.betAmount; p2.balance -= duel.betAmount;
    
    broadcast();
    setTimeout(() => {
        duel.actions = {left:null, right:null};
        if(duel.gameType === 'coin') { duel.status='rolling'; resolveRound(); }
        else { duel.status='interactive'; broadcast(); }
    }, 2000);
}

function resolveRound() {
    duel.status = 'rolling';
    let winL = Math.random() < 0.5;
    let res = {};
    
    if(duel.gameType==='coin') res.outcome = winL ? 'heads' : 'tails';
    else {
        const r = () => Math.floor(Math.random()*6)+1;
        let l=[r(),r(),r()], ri=[r(),r(),r()];
        winL = l.reduce((a,b)=>a+b) > ri.reduce((a,b)=>a+b);
        res = { left: l, right: ri };
    }
    duel.result = res;
    broadcast();

    setTimeout(async () => {
        if(winL) duel.scores.left++; else duel.scores.right++;
        const target = duel.matchMode.includes('5') ? 3 : 2; // BO5=3wins, BO3=2wins
        
        let winnerId = null;
        if(duel.scores.left >= target) winnerId = duel.seatLeft;
        if(duel.scores.right >= target) winnerId = duel.seatRight;

        if(winnerId) {
            duel.status = 'finished';
            duel.winnerId = winnerId;
            const winner = players[winnerId];
            await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duel.pot } });
            winner.balance += duel.pot;
            
            // Payout Specs
            const winSide = winnerId === duel.seatLeft ? 'left' : 'right';
            for(let sid in duel.spectatorBets) {
                const bet = duel.spectatorBets[sid];
                if(bet.side === winSide && players[sid]) {
                    const winAmt = bet.amount * 2; // 1:1 odds
                    await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: winAmt } });
                    players[sid].balance += winAmt;
                }
            }
            broadcast();
            setTimeout(() => { resetGame(); broadcast(); }, 5000);
        } else {
            duel.status = 'round_end';
            duel.actions = {left:null, right:null};
            broadcast();
            setTimeout(() => {
                if(duel.gameType === 'coin') { duel.status='rolling'; resolveRound(); }
                else { duel.status='interactive'; broadcast(); }
            }, 3000);
        }
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`));
