const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. DATA STORAGE ---
const DATA_FILE = 'users.json';
let users = {}; 
if (fs.existsSync(DATA_FILE)) { try { users = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) { users = {}; } }
function saveUsers() { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }

// --- 2. GAME STATE ---
let gameState = {
    seats: { 1: null, 2: null }, // Stores Username
    sockets: { 1: null, 2: null }, // Stores Socket IDs for signaling
    hostSeat: null, // Which seat sat first?
    
    settings: { game: 'dice', targetScore: 1, wager: 0 },
    scores: { 1: 0, 2: 0 },
    turn: 1,
    
    matchActive: false, // Game is playing
    negotiating: false, // Proposal phase active
    
    // Game Memory
    temp: { diceP1: null, rps: { 1: null, 2: null }, hlCurrent: 7, tttBoard: Array(9).fill(null) }
};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', (socket) => {
    let currentUser = null;

    // --- AUTH ---
    socket.on('auth', ({ username, password }) => {
        if (!users[username]) { users[username] = { password, balance: 1000 }; saveUsers(); }
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('auth_success', { username, balance: users[username].balance });
            socket.emit('state_update', gameState);
        } else socket.emit('auth_fail', 'WRONG PASSWORD');
    });

    // --- SEATS & NEGOTIATION ---
    socket.on('request_seat', (n) => {
        if (!currentUser || gameState.seats[n]) return;

        // 1. Assign Seat
        gameState.seats[n] = currentUser;
        gameState.sockets[n] = socket.id;

        // 2. Determine Host (First person to sit)
        const p1 = gameState.seats[1];
        const p2 = gameState.seats[2];

        if (!gameState.hostSeat) {
            gameState.hostSeat = n; // This person is the Host
        }

        // 3. Check if both present
        if (p1 && p2) {
            gameState.negotiating = true;
            // Notify Host to Propose
            io.to(gameState.sockets[gameState.hostSeat]).emit('prompt_proposal');
            // Notify Challenger to Wait
            const challengerSeat = gameState.hostSeat === 1 ? 2 : 1;
            io.to(gameState.sockets[challengerSeat]).emit('wait_for_proposal');
        }

        io.emit('state_update', gameState);
    });

    // --- PROPOSAL FLOW ---
    socket.on('propose_terms', (terms) => {
        // Only Host can propose
        if (gameState.sockets[gameState.hostSeat] !== socket.id) return;
        
        gameState.settings = terms;
        
        // Send terms to Challenger for review
        const challengerSeat = gameState.hostSeat === 1 ? 2 : 1;
        io.to(gameState.sockets[challengerSeat]).emit('review_terms', terms);
    });

    socket.on('respond_terms', (response) => {
        // response: true (accept) or false (decline)
        if (response) {
            // ACCEPTED
            gameState.negotiating = false;
            gameState.matchActive = true;
            gameState.scores = { 1: 0, 2: 0 };
            gameState.turn = 1; 
            gameState.temp = { diceP1: null, rps: { 1: null, 2: null }, hlCurrent: 7, tttBoard: Array(9).fill(null) };
            
            io.emit('chat_msg', { user: 'SYSTEM', text: `MATCH ACCEPTED! GAME: ${gameState.settings.game.toUpperCase()}`, color: '#2ecc71' });
            io.emit('state_update', gameState);
            
            // Trigger Voice Connection
            io.to(gameState.sockets[1]).emit('start_voice', { initiator: true });
            io.to(gameState.sockets[2]).emit('start_voice', { initiator: false });

        } else {
            // DECLINED -> Kick Challenger
            const challengerSeat = gameState.hostSeat === 1 ? 2 : 1;
            const challengerSocket = gameState.sockets[challengerSeat];
            
            gameState.seats[challengerSeat] = null;
            gameState.sockets[challengerSeat] = null;
            
            io.to(challengerSocket).emit('kicked_from_seat');
            io.emit('chat_msg', { user: 'SYSTEM', text: `TERMS DECLINED. SEAT OPEN.`, color: '#ff4757' });
            io.emit('state_update', gameState);
        }
    });

    // --- VOICE SIGNALING (WebRTC Relay) ---
    socket.on('voice_signal', (data) => {
        // Relay signal to the opponent
        const targetSeat = gameState.sockets[1] === socket.id ? 2 : 1;
        const targetSocket = gameState.sockets[targetSeat];
        if (targetSocket) {
            io.to(targetSocket).emit('voice_signal', data);
        }
    });

    // --- STANDARD GAME LOGIC (Unchanged from before) ---
    socket.on('game_action', (data) => {
        if (!gameState.matchActive) return;
        // ... (Include logic from previous step: Dice, Coin, etc.) ...
        // For brevity, I will include the core switch logic here
        
        let win = null; 
        let roundOver = false;
        const G = gameState.settings.game;

        if (G === 'dice') {
            const roll = [r6(), r6(), r6()];
            const total = roll.reduce((a,b)=>a+b,0);
            io.emit('anim_dice', { seat: gameState.turn, roll });
            if (!gameState.temp.diceP1) gameState.temp.diceP1 = total;
            else {
                if (gameState.temp.diceP1 > total) win = 1;
                else if (total > gameState.temp.diceP1) win = 2;
                else win = 'draw';
                gameState.temp.diceP1 = null; roundOver = true;
            }
        }
        else if (G === 'coin') {
            const res = Math.random() < 0.5 ? 'H' : 'T';
            io.emit('anim_coin', { result: res });
            if (data.guess === res) { win = gameState.turn; roundOver = true; } else roundOver = true;
        }
        // ... Add other games (HL, Roulette, RPS, TTT) here ...

        if (roundOver) {
            setTimeout(() => {
                if (win && win !== 'draw') {
                    gameState.scores[win]++;
                    checkMatchWin();
                }
                gameState.turn = gameState.turn === 1 ? 2 : 1;
                io.emit('state_update', gameState);
            }, 2000);
        }
    });

    function checkMatchWin() {
        const target = parseInt(gameState.settings.targetScore);
        if (gameState.scores[1] >= target || gameState.scores[2] >= target) {
            const winner = gameState.scores[1] >= target ? 1 : 2;
            gameState.matchActive = false;
            gameState.negotiating = false;
            gameState.hostSeat = null; // Reset host
            io.emit('match_over', { winner, name: gameState.seats[winner] });
            
            // Payout Logic
            const wager = parseInt(gameState.settings.wager);
            if(wager > 0) {
                const loser = winner === 1 ? 2 : 1;
                if(users[gameState.seats[winner]]) users[gameState.seats[winner]].balance += wager;
                if(users[gameState.seats[loser]]) users[gameState.seats[loser]].balance -= wager;
                saveUsers();
                // Update balances on clients
                if(gameState.sockets[1]) io.to(gameState.sockets[1]).emit('balance_update', users[gameState.seats[1]]?.balance || 0);
                if(gameState.sockets[2]) io.to(gameState.sockets[2]).emit('balance_update', users[gameState.seats[2]]?.balance || 0);
            }
            
            // Clean up
            gameState.scores = { 1: 0, 2: 0 };
            io.emit('state_update', gameState);
        }
    }

    socket.on('leave_seat', () => {
        if(gameState.matchActive) return; // Locked
        if(gameState.seats[1] === currentUser) { gameState.seats[1] = null; gameState.sockets[1] = null; }
        if(gameState.seats[2] === currentUser) { gameState.seats[2] = null; gameState.sockets[2] = null; }
        if(!gameState.seats[1] && !gameState.seats[2]) gameState.hostSeat = null; // Reset host if empty
        io.emit('state_update', gameState);
    });

    function r6() { return Math.ceil(Math.random() * 6); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running`));
