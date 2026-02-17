const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// DATA STORAGE (Plain Text JSON)
const DATA_FILE = 'data.json';
let users = {}; // Stores { username: { password, balance, ip } }

// Load data on start
if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveUsers() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

// SERVE FILES
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 1. Player Panel (Index)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Admin Panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ADMIN API: Get all data
app.get('/api/admin/data', (req, res) => {
    res.json(users);
});

// REAL-TIME SOCKET CONNECTION
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    let currentUser = null;

    // --- LOGIN / SIGNUP ---
    socket.on('login', (data) => {
        const { username, password } = data;
        
        // SIGNUP (Create if doesn't exist)
        if (!users[username]) {
            users[username] = { password, balance: 1000, wins: 0, losses: 0 };
            saveUsers();
        }

        // LOGIN CHECK
        if (users[username].password === password) {
            currentUser = username;
            socket.join('lobby'); // Join global chat
            socket.emit('login_success', { username, balance: users[username].balance });
            
            // Announce to chat
            io.to('lobby').emit('chat_message', { 
                user: 'SYSTEM', 
                text: `${username} has joined the arena!`, 
                color: '#2ecc71' 
            });
            
            updatePlayerCount();
        } else {
            socket.emit('login_fail', "Incorrect Password");
        }
    });

    // --- CHAT ---
    socket.on('send_chat', (msg) => {
        if (!currentUser) return;
        // Broadcast to everyone in lobby
        io.to('lobby').emit('chat_message', { 
            user: currentUser, 
            text: msg, 
            color: '#fff' 
        });
    });

    // --- GAME LOGIC RELAY ---
    // When a player takes a seat
    socket.on('take_seat', (seatNum) => {
        if (!currentUser) return;
        io.emit('update_seat', { seat: seatNum, user: currentUser });
    });

    // When a player performs a game action (Roll Dice, etc.)
    socket.on('game_action', (data) => {
        // Broadcast the action to everyone so they see the animation
        io.emit('game_event', data);
        
        // Example: If Game Over, update stats (Simplified)
        if (data.type === 'game_over') {
            if (users[data.winner]) {
                users[data.winner].balance += 100; // Win bonus
                users[data.winner].wins += 1;
                saveUsers();
            }
        }
    });

    socket.on('disconnect', () => {
        updatePlayerCount();
    });

    function updatePlayerCount() {
        // Count sockets in 'lobby'
        const count = io.sockets.adapter.rooms.get('lobby')?.size || 0;
        io.emit('player_count', count);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});