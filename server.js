require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// DB CONNECTION
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error('❌ DB Error:', err.message));

// SCHEMAS
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, match: /^[A-Za-z0-9]{5,12}$/ },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    role: { type: String, default: 'user' },
    banned: { type: Boolean, default: false },
    color: { type: String, default: '#00ffff' }
});
const User = mongoose.model('User', userSchema);

// AUTH LOGIC
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        const color = ["#00ffff", "#00ff00", "#ffff00", "#ff00ff", "#ff4444"][Math.floor(Math.random()*5)];
        await new User({ username, password: hashedPassword, role: isFirst ? 'admin' : 'user', color }).save();
        res.status(201).json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Username taken or invalid" }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret');
    res.cookie('token', token, { httpOnly: true }).json({ user: { username: user.username, role: user.role, balance: user.balance } });
});

// ADMIN API
app.get('/api/admin/users', async (req, res) => {
    const users = await User.find({}).select('-password');
    res.json(users);
});
app.post('/api/admin/tx', async (req, res) => {
    const { userId, type, amount } = req.body;
    const val = type === 'add' ? parseInt(amount) : -parseInt(amount);
    await User.findByIdAndUpdate(userId, { $inc: { balance: val } });
    res.json({ success: true });
});

// GAME ENGINE
let players = {};
let duel = {
    l: null, r: null, status: 'open', pot: 0, bet: 0, game: 'coin', mode: 'bo3',
    lLock: false, rLock: false, score: { l: 0, r: 0 }, round: 0, actions: { l: false, r: false }, specBets: {}
};

io.on('connection', (socket) => {
    socket.on('join', async (name) => {
        const u = await User.findOne({ username: name });
        if(!u) return;
        players[socket.id] = { id: socket.id, dbId: u._id, name: u.username, balance: u.balance, color: u.color, role: u.role };
        broadcast();
    });

    socket.on('chat', (text) => {
        const p = players[socket.id];
        if(p) io.emit('msg', { name: p.name, color: p.color, text });
    });

    socket.on('seat', (side) => {
        if (duel.status !== 'open') return;
        if (side === 'l' && !duel.l) duel.l = socket.id;
        if (side === 'r' && !duel.r) duel.r = socket.id;
        resetLocks(); broadcast();
    });

    socket.on('update_duel', (data) => {
        if (socket.id !== duel.l && socket.id !== duel.r) return;
        duel.bet = parseInt(data.bet) || 0;
        duel.game = data.game;
        duel.mode = data.mode;
        resetLocks(); broadcast();
    });

    socket.on('lock', async () => {
        const p = players[socket.id];
        if (socket.id === duel.l) duel.lLock = !duel.lLock;
        if (socket.id === duel.r) duel.rLock = !duel.rLock;
        broadcast();
        if (duel.lLock && duel.rLock && duel.bet > 0) startMatch();
    });

    socket.on('act', () => {
        if (duel.status !== 'act') return;
        if (socket.id === duel.l) duel.actions.l = true;
        if (socket.id === duel.r) duel.actions.r = true;
        broadcast();
        if (duel.actions.l && duel.actions.r) resolveRound();
    });

    socket.on('spec_bet', async (data) => {
        const p = players[socket.id];
        if (p.balance >= data.amt && duel.status === 'open') {
            await User.findByIdAndUpdate(p.dbId, { $inc: { balance: -data.amt } });
            p.balance -= data.amt;
            duel.specBets[socket.id] = { side: data.side, amt: data.amt };
            broadcast();
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; broadcast(); });
});

function resetLocks() { duel.lLock = false; duel.rLock = false; duel.status = 'open'; duel.score = { l: 0, r: 0 }; duel.round = 0; }
function broadcast() { io.emit('state', { players, duel }); }

async function startMatch() {
    duel.status = 'locked';
    duel.pot = duel.bet * 2;
    await User.findByIdAndUpdate(players[duel.l].dbId, { $inc: { balance: -duel.bet } });
    await User.findByIdAndUpdate(players[duel.r].dbId, { $inc: { balance: -duel.bet } });
    players[duel.l].balance -= duel.bet;
    players[duel.r].balance -= duel.bet;
    broadcast();
    setTimeout(nextRound, 2000);
}

function nextRound() {
    duel.round++;
    duel.actions = { l: false, r: false };
    duel.status = duel.game === 'coin' ? 'rolling' : 'act';
    broadcast();
    if(duel.game === 'coin') setTimeout(resolveRound, 2000);
}

function resolveRound() {
    duel.status = 'rolling';
    let winL = Math.random() > 0.5;
    let res = {};
    if(duel.game === 'coin') res.val = winL ? 'HEADS' : 'TAILS';
    else {
        const r = () => Math.floor(Math.random()*6)+1;
        res.l = [r(), r(), r()]; res.r = [r(), r(), r()];
        winL = res.l.reduce((a,b)=>a+b) > res.r.reduce((a,b)=>a+b);
    }
    duel.res = res; broadcast();
    setTimeout(() => {
        if(winL) duel.score.l++; else duel.score.r++;
        const target = duel.mode.includes('3') ? (duel.mode.startsWith('bo') ? 2 : 3) : (duel.mode.startsWith('bo') ? 3 : 5);
        if(duel.score.l >= target || duel.score.r >= target) endMatch(duel.score.l >= target ? 'l' : 'r');
        else nextRound();
    }, 3000);
}

async function endMatch(side) {
    duel.status = 'win';
    const winner = players[duel[side]];
    await User.findByIdAndUpdate(winner.dbId, { $inc: { balance: duel.pot } });
    winner.balance += duel.pot;
    // Spec Payouts (House pays 1.9x)
    for(let sid in duel.specBets) {
        if(duel.specBets[sid].side === side && players[sid]) {
            const pay = Math.floor(duel.specBets[sid].amt * 1.9);
            await User.findByIdAndUpdate(players[sid].dbId, { $inc: { balance: pay } });
            players[sid].balance += pay;
        }
    }
    broadcast();
    setTimeout(() => { duel.l = null; duel.r = null; resetLocks(); broadcast(); }, 5000);
}

server.listen(process.env.PORT || 3000);
