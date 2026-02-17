const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATA STORAGE ---
const DATA_FILE = 'users.json';
let users = {};
if (fs.existsSync(DATA_FILE)) {
    try { users = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) { users = {}; }
}
function saveUsers() { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }

// --- GAME STATE ---
let gameState = {
    seats: { 1: null, 2: null }, // Username in seat
    gameType: 'dice',            // Current active game tab
    gameActive: false,           // Is a round currently playing? (Locks betting)
    
    // Game Specific Memory
    rps: { p1: null, p2: null },
    ttt: Array(9).fill(null),
    tttTurn: 'X', // X is always P1, O is P2
    hlCurrent: 7, // Starting card for High-Low
};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/admin/data', (req, res) => res.json(users));

io.on('connection', (socket) => {
    let currentUser = null;

    // --- AUTH ---
    socket.on('auth', ({ username, password }) => {
        if (!users[username]) {
            users[username] = { password, balance: 1000 };
            saveUsers();
        }
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('auth_success', { username, balance: users[username].balance });
            socket.emit('state_update', gameState); // Send full current state
            io.emit('chat_msg', { user: 'SYSTEM', text: `${username} JOINED`, color: '#feca57' });
        } else {
            socket.emit('auth_fail', 'WRONG PASSWORD');
        }
    });

    // --- SEATS ---
    socket.on('request_seat', (seatNum) => {
        if (!currentUser) return;
        // If seat empty, take it
        if (gameState.seats[seatNum] === null) {
            // Remove from other seats
            if (gameState.seats[1] === currentUser) gameState.seats[1] = null;
            if (gameState.seats[2] === currentUser) gameState.seats[2] = null;
            
            gameState.seats[seatNum] = currentUser;
            io.emit('update_seats', gameState.seats);
            io.emit('chat_msg', { user: 'SYSTEM', text: `${currentUser} TOOK SEAT ${seatNum}`, color: '#2ecc71' });
        }
    });

    socket.on('leave_seat', () => {
        if (!currentUser) return;
        if (gameState.seats[1] === currentUser) gameState.seats[1] = null;
        if (gameState.seats[2] === currentUser) gameState.seats[2] = null;
        io.emit('update_seats', gameState.seats);
    });

    // --- GAME LOGIC ---
    
    // 1. Change Game Tab
    socket.on('change_game', (game) => {
        if(Object.values(gameState.seats).includes(currentUser)) {
            gameState.gameType = game;
            // Reset sub-states
            gameState.ttt = Array(9).fill(null);
            gameState.rps = { p1: null, p2: null };
            io.emit('set_game', game);
        }
    });

    // 2. DICE ROLL
    socket.on('action_dice', (seat) => {
        gameState.gameActive = true;
        io.emit('lock_betting', true);
        
        // Server calculates result to prevent cheating
        const roll = [Math.ceil(Math.random()*6), Math.ceil(Math.random()*6), Math.ceil(Math.random()*6)];
        const total = roll.reduce((a,b)=>a+b,0);
        
        io.emit('anim_dice', { seat, roll, total });
        
        setTimeout(() => { 
            gameState.gameActive = false; 
            io.emit('lock_betting', false); 
        }, 2000);
    });

    // 3. COIN FLIP
    socket.on('action_coin', ({ seat, guess }) => {
        gameState.gameActive = true;
        io.emit('lock_betting', true);

        const isHeads = Math.random() < 0.5;
        const result = isHeads ? 'H' : 'T';
        const win = (guess === result);

        io.emit('anim_coin', { seat, result, win });
        
        setTimeout(() => { 
            gameState.gameActive = false; 
            io.emit('lock_betting', false); 
        }, 3000);
    });

    // 4. HIGH-LOW
    socket.on('action_hl', ({ seat, guess }) => {
        gameState.gameActive = true;
        io.emit('lock_betting', true);

        let next = Math.ceil(Math.random()*13);
        while(next === gameState.hlCurrent) next = Math.ceil(Math.random()*13); // No ties
        
        const win = (guess === 'high' && next > gameState.hlCurrent) || (guess === 'low' && next < gameState.hlCurrent);
        const old = gameState.hlCurrent;
        gameState.hlCurrent = next;

        io.emit('anim_hl', { seat, next, win });
        
        setTimeout(() => { 
            gameState.gameActive = false; 
            io.emit('lock_betting', false); 
        }, 2000);
    });

    // 5. ROULETTE
    socket.on('action_roulette', ({ seat, guess }) => {
        gameState.gameActive = true;
        io.emit('lock_betting', true);

        // 0-360 degrees. Let's map sectors. 
        // Simple logic: Random color Red/Black
        const isRed = Math.random() < 0.5;
        const result = isRed ? 'RED' : 'BLACK';
        const angle = 1080 + Math.random() * 360; // Spin animation value
        const win = (guess === result);

        io.emit('anim_roulette', { seat, result, angle, win });

        setTimeout(() => { 
            gameState.gameActive = false; 
            io.emit('lock_betting', false); 
        }, 3500);
    });

    // 6. RPS (Rock Paper Scissors)
    socket.on('action_rps', ({ seat, choice }) => {
        gameState.gameActive = true;
        io.emit('lock_betting', true);

        if(seat === 1) gameState.rps.p1 = choice;
        if(seat === 2) gameState.rps.p2 = choice;

        io.emit('rps_lock', seat); // Tell everyone this player picked (don't show what yet)

        // If both picked, reveal
        if(gameState.rps.p1 && gameState.rps.p2) {
            const p1 = gameState.rps.p1;
            const p2 = gameState.rps.p2;
            let winner = 0; // 0 draw, 1 p1, 2 p2

            if(p1 !== p2) {
                if((p1==='R'&&p2==='S') || (p1==='P'&&p2==='R') || (p1==='S'&&p2==='P')) winner = 1;
                else winner = 2;
            }

            io.emit('rps_reveal', { p1, p2, winner });
            
            // Reset
            gameState.rps = { p1: null, p2: null };
            setTimeout(() => { 
                gameState.gameActive = false; 
                io.emit('lock_betting', false); 
            }, 3000);
        }
    });

    // 7. TIC TAC TOE
    socket.on('action_ttt', ({ index, seat }) => {
        // Validation
        if(gameState.ttt[index] !== null) return; // Spot taken
        const symbol = seat === 1 ? 'X' : 'O';
        
        gameState.ttt[index] = symbol;
        io.emit('anim_ttt', { index, symbol, nextTurn: seat === 1 ? 2 : 1 });

        // Check Win (Simple)
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        let winner = null;
        wins.forEach(c => {
            if(gameState.ttt[c[0]] && gameState.ttt[c[0]] === gameState.ttt[c[1]] && gameState.ttt[c[0]] === gameState.ttt[c[2]]) {
                winner = gameState.ttt[c[0]] === 'X' ? 1 : 2;
            }
        });

        if(winner || !gameState.ttt.includes(null)) {
            io.emit('ttt_over', { winner });
            gameState.ttt = Array(9).fill(null); // Reset board
        }
    });

    // --- CHAT ---
    socket.on('chat_msg', (msg) => {
        if (currentUser) io.emit('chat_message', { user: currentUser, text: msg, color: '#fff' });
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            if (gameState.seats[1] === currentUser) gameState.seats[1] = null;
            if (gameState.seats[2] === currentUser) gameState.seats[2] = null;
            io.emit('update_seats', gameState.seats);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
