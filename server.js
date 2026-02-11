const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // SIMPLE MATCHMAKING
    // If someone is waiting, pair them up. If not, make this user wait.
    if (waitingPlayer) {
        // Match found!
        const roomID = waitingPlayer.id + '#' + socket.id;
        const p1 = waitingPlayer;
        const p2 = socket;

        p1.join(roomID);
        p2.join(roomID);

        // Assign Roles
        p1.emit('init', { player: 1, room: roomID });
        p2.emit('init', { player: 2, room: roomID });

        io.to(roomID).emit('status', 'OPPONENT FOUND! GAME STARTING...');
        
        waitingPlayer = null;
    } else {
        waitingPlayer = socket;
        socket.emit('status', 'WAITING FOR OPPONENT...');
    }

    // RELAY GAME ACTIONS
    // When a player performs an action, they send the result to the server.
    // The server forwards it to the OTHER player in the room.
    socket.on('gameAction', (data) => {
        // data contains: { room, type (e.g., 'dice'), payload (e.g., roll result) }
        socket.to(data.room).emit('remoteAction', data);
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
        // Ideally, notify the other player in the room that their opponent left
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
