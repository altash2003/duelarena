const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATA ---
const DATA_FILE = 'users.json';
let users = {}; 
if (fs.existsSync(DATA_FILE)) { try { users = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) { users = {}; } }
function saveUsers() { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }

// --- GAME STATE ---
let gameState = {
    seats: { 1: null, 2: null },
    settings: { 
        game: 'dice', 
        targetScore: 1, // 1 = Sudden Death, 2 = Best of 3, etc.
        wager: 0 
    },
    scores: { 1: 0, 2: 0 },
    turn: 1,
    matchActive: false, // LOCKS THE SEATS
    
    // Sub-game states
    rps: { 1: null, 2: null },
    ttt: Array(9).fill(null),
    hlCurrent: 7
};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', (socket) => {
    let currentUser = null;

    // --- AUTH ---
    socket.on('auth', ({ username, password }) => {
        if (!users[username]) { users[username] = { password, balance: 1000 }; saveUsers(); }
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('auth_success', { username, balance: users[username].balance });
            socket.emit('state_update', gameState);
        } else {
            socket.emit('auth_fail', 'WRONG PASSWORD');
        }
    });

    // --- SEATS & PROPOSAL ---
    socket.on('request_seat', (seatNum) => {
        if (!currentUser) return;
        if (gameState.seats[seatNum]) return; // Occupied

        // Seat Logic
        gameState.seats[seatNum] = currentUser;
        
        // If P1 sits and P2 is empty, P1 is HOST. Reset state.
        if (seatNum === 1 && !gameState.seats[2]) {
            gameState.matchActive = false;
            gameState.scores = { 1: 0, 2: 0 };
            gameState.turn = 1;
            io.emit('chat_msg', { user: 'SYSTEM', text: `${currentUser} is setting up the match...`, color: '#feca57' });
        }
        
        // If P2 sits, match is ready to start (if settings exist)
        if (gameState.seats[1] && gameState.seats[2]) {
            io.emit('chat_msg', { user: 'SYSTEM', text: `MATCH STARTED! ${gameState.settings.game.toUpperCase()} - FIRST TO ${gameState.settings.targetScore}`, color: '#2ecc71' });
            gameState.matchActive = true; // LOCK SEATS
        }

        io.emit('update_state', gameState);
    });

    // HOST SETTINGS
    socket.on('update_settings', (settings) => {
        // Only P1 can set terms
        if (gameState.seats[1] !== currentUser) return;
        if (gameState.matchActive) return; // Can't change during game

        gameState.settings = settings;
        // Reset sub-games
        gameState.ttt = Array(9).fill(null);
        gameState.hlCurrent = 7;
        
        io.emit('update_state', gameState);
    });

    socket.on('leave_seat', () => {
        if (!currentUser) return;
        
        // LOCK: Cannot leave if match is active
        if (gameState.matchActive) {
            socket.emit('error_msg', "YOU CANNOT LEAVE DURING A MATCH!");
            return;
        }

        if (gameState.seats[1] === currentUser) gameState.seats[1] = null;
        if (gameState.seats[2] === currentUser) gameState.seats[2] = null;
        
        // Reset game if someone leaves
        gameState.scores = { 1: 0, 2: 0 };
        io.emit('update_state', gameState);
    });

    // --- GAMEPLAY ENGINE ---
    socket.on('game_action', (data) => {
        if (!gameState.matchActive) return;
        if (gameState.seats[gameState.turn] !== currentUser) return; // Not your turn

        let win = false;
        let nextTurn = gameState.turn === 1 ? 2 : 1;
        let roundOver = false;

        // 1. DICE
        if (gameState.settings.game === 'dice') {
            const roll = [r6(), r6(), r6()];
            const total = roll.reduce((a,b)=>a+b,0);
            io.emit('anim_dice', { seat: gameState.turn, roll, total });
            
            // Logic: P1 rolls, then P2 rolls. Compare.
            if (!gameState.tempDice) {
                gameState.tempDice = total; // Store P1 roll
            } else {
                // P2 rolled. Compare.
                if (gameState.tempDice > total) { win = 1; } // P1 Wins
                else if (total > gameState.tempDice) { win = 2; } // P2 Wins
                else { win = 'draw'; }
                
                gameState.tempDice = null; // Reset
                roundOver = true;
            }
        }
        // 2. COIN (Guessing)
        else if (gameState.settings.game === 'coin') {
            const res = Math.random() < 0.5 ? 'H' : 'T';
            const success = (data.guess === res);
            io.emit('anim_coin', { seat: gameState.turn, result: res });
            
            if (success) { win = gameState.turn; roundOver = true; } // Correct guess = point
            // If wrong, just switch turn, no point
        }
        
        // --- HANDLE RESULTS ---
        setTimeout(() => {
            if (roundOver) {
                if (win === 'draw') {
                    io.emit('chat_msg', { user: 'REF', text: "DRAW! Play again.", color: '#aaa' });
                    // Turn goes back to P1 to start over logic or swap? Let's swap.
                } else if (win) {
                    gameState.scores[win]++;
                    io.emit('chat_msg', { user: 'REF', text: `POINT FOR PLAYER ${win}!`, color: '#2ecc71' });
                    checkMatchWin();
                }
            }
            
            gameState.turn = nextTurn;
            io.emit('update_state', gameState);
        }, 2000); // Wait for animation
    });

    function checkMatchWin() {
        const target = parseInt(gameState.settings.targetScore);
        let winner = null;

        if (gameState.scores[1] >= target) winner = 1;
        if (gameState.scores[2] >= target) winner = 2;

        if (winner) {
            gameState.matchActive = false; // UNLOCK SEATS
            io.emit('match_over', { winner, name: gameState.seats[winner] });
            
            // Handle Money
            const wager = parseInt(gameState.settings.wager);
            if (wager > 0) {
                const loser = winner === 1 ? 2 : 1;
                // Simplified database update
                if(users[gameState.seats[winner]]) users[gameState.seats[winner]].balance += wager;
                if(users[gameState.seats[loser]]) users[gameState.seats[loser]].balance -= wager;
                saveUsers();
            }
            
            // Reset scores for next setup
            gameState.scores = { 1: 0, 2: 0 };
        }
    }

    function r6() { return Math.ceil(Math.random() * 6); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running`));
