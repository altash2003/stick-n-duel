const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- FIX: SERVE FILES FROM ROOT ---
// This tells the server to serve 'index.html' from the same folder as this script
app.use(express.static(__dirname)); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // MATCHMAKING
    if (waitingPlayer) {
        const roomID = waitingPlayer.id + '#' + socket.id;
        const p1 = waitingPlayer;
        const p2 = socket;

        p1.join(roomID);
        p2.join(roomID);

        p1.emit('init', { player: 1, room: roomID });
        p2.emit('init', { player: 2, room: roomID });

        io.to(roomID).emit('status', 'OPPONENT FOUND! GAME STARTING...');
        waitingPlayer = null;
    } else {
        waitingPlayer = socket;
        socket.emit('status', 'WAITING FOR OPPONENT...');
    }

    // GAME ACTIONS
    socket.on('gameAction', (data) => {
        socket.to(data.room).emit('remoteAction', data);
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
