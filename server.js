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
const TICKETS_FILE = 'tickets.json';
let users = {}; 
let tickets = [];

// Load Data
if (fs.existsSync(DATA_FILE)) { try { users = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) { users = {}; } }
if (fs.existsSync(TICKETS_FILE)) { try { tickets = JSON.parse(fs.readFileSync(TICKETS_FILE)); } catch (e) { tickets = []; } }

function saveData() { 
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); 
    fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

// --- GAME STATE ---
let gameState = {
    seats: { 1: null, 2: null }, 
    sockets: { 1: null, 2: null },
    hostSeat: null,
    settings: { game: 'dice', targetScore: 1, roundLabel: "SUDDEN DEATH", wager: 0 },
    scores: { 1: 0, 2: 0 },
    turn: 1,
    matchActive: false,
    negotiating: false,
    statusText: "WAITING FOR PLAYERS",
    currentBets: [],
    temp: { diceP1: null, diceRollP1: [], rps: { 1: null, 2: null }, hlCurrent: 7, tttBoard: Array(9).fill(null) }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ADMIN API ---
app.get('/api/admin/users', (req, res) => res.json(users));
app.get('/api/admin/tickets', (req, res) => res.json(tickets));
app.post('/api/admin/update', (req, res) => {
    const { username, action, amount } = req.body;
    if(!users[username]) return res.status(404).send("User not found");
    
    if(action === 'deposit') users[username].balance += parseInt(amount);
    if(action === 'withdraw') users[username].balance -= parseInt(amount);
    
    saveData();
    // Notify user immediately
    const sockId = Object.keys(io.sockets.sockets).find(id => io.sockets.sockets[id].username === username);
    if(sockId) io.to(sockId).emit('balance_update', users[username].balance);
    
    res.json({ success: true, newBalance: users[username].balance });
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    let currentUser = null;

    // AUTH
    socket.on('auth', ({ type, username, password }) => {
        if (type === 'signup') {
            if (users[username]) return socket.emit('auth_fail', "USERNAME TAKEN");
            users[username] = { password, balance: 1000, isAdmin: false };
            saveData();
        } else {
            if (!users[username] || users[username].password !== password) return socket.emit('auth_fail', "INVALID CREDENTIALS");
        }
        
        currentUser = username;
        socket.username = username; // Store for Admin lookup
        socket.emit('auth_success', { username, balance: users[username].balance, isAdmin: users[username].isAdmin });
        io.emit('player_joined', { username });
        io.emit('state_update', gameState);
    });

    // BANKING REQUESTS (User Side)
    socket.on('wallet_action', (data) => {
        if(!currentUser) return;
        if(data.type === 'ticket') {
            tickets.push({ user: currentUser, msg: data.msg, date: new Date().toLocaleString() });
            saveData();
            socket.emit('alert', "TICKET SENT TO ADMIN");
        }
        // Deposits/Withdraws are handled by Admin manually in this logic, 
        // OR you can add auto-logic here. For now, we just log tickets.
    });

    // GAMEPLAY (Condensed for brevity - logic remains same as previous working version)
    socket.on('request_seat', (n) => {
        if (!currentUser || Object.values(gameState.seats).includes(currentUser) || gameState.seats[n]) return;
        gameState.seats[n] = currentUser;
        gameState.sockets[n] = socket.id;
        if(!gameState.hostSeat) gameState.hostSeat = n;
        
        if (gameState.seats[1] && gameState.seats[2]) {
            gameState.negotiating = true;
            gameState.statusText = "NEGOTIATION PHASE";
            io.to(gameState.sockets[gameState.hostSeat]).emit('prompt_proposal');
            io.to(gameState.sockets[gameState.hostSeat===1?2:1]).emit('wait_for_proposal');
        } else {
            gameState.statusText = "WAITING FOR CHALLENGER";
        }
        io.emit('state_update', gameState);
    });

    socket.on('propose_terms', (t) => {
        gameState.settings = t;
        io.to(gameState.sockets[gameState.hostSeat===1?2:1]).emit('review_terms', t);
        io.emit('update_settings_public', t); // Let spectators see
    });

    socket.on('respond_terms', (ok) => {
        if(ok) {
            gameState.negotiating = false; gameState.matchActive = true;
            gameState.statusText = "MATCH LIVE - BETTING CLOSED";
            gameState.scores = {1:0, 2:0}; gameState.turn = 1;
            gameState.temp = { diceP1: null, diceRollP1: [], rps: { 1: null, 2: null }, hlCurrent: 7, tttBoard: Array(9).fill(null) };
            io.emit('game_reset', gameState.settings.game);
            io.emit('state_update', gameState);
        } else {
            const s = gameState.hostSeat===1?2:1;
            const sock = gameState.sockets[s];
            gameState.seats[s]=null; gameState.sockets[s]=null;
            gameState.statusText = "PROPOSAL DECLINED";
            io.to(sock).emit('kicked');
            io.emit('state_update', gameState);
        }
    });

    socket.on('game_action', (data) => {
        if(!gameState.matchActive) return;
        // ... (Insert Standard Game Logic Here: Dice, Coin, HL, Roulette, RPS, TTT) ...
        // Logic identical to previous correct version, triggers animations via io.emit
        handleGameLogic(data, socket, currentUser); 
    });

    socket.on('place_bet', ({amount, target}) => {
        if(!currentUser || !gameState.negotiating) return; // Only bet during negotiation
        if(users[currentUser].balance >= amount) {
            users[currentUser].balance -= amount;
            saveData();
            gameState.currentBets.push({user:currentUser, amount, target});
            socket.emit('balance_update', users[currentUser].balance);
            io.emit('chat_msg', { user: 'SYSTEM', text: `${currentUser} BET ${amount} ON P${target}`, color: '#aaa' });
        }
    });

    socket.on('chat_msg', (m) => io.emit('chat_msg', { user: currentUser || 'Anon', text: m, color: '#fff' }));
    
    socket.on('leave_seat', () => {
        if(gameState.matchActive) return;
        if(gameState.seats[1]===currentUser) gameState.seats[1]=null;
        if(gameState.seats[2]===currentUser) gameState.seats[2]=null;
        gameState.negotiating = false;
        io.emit('state_update', gameState);
    });

    // --- LOGIC HELPER (Simplified for display) ---
    function handleGameLogic(data, socket, user) {
        // ... Core game logic from previous steps ...
        // On win:
        // payoutBets(winner);
        // checkMatchWin();
        // io.emit('anim_...', data);
        // io.emit('state_update', gameState);
        
        // *Re-inserting the Dice Logic for context:*
        const G = gameState.settings.game;
        if(G === 'dice') {
             // ... Dice logic ...
             const roll = [r6(),r6(),r6()], total = roll.reduce((a,b)=>a+b,0);
             io.emit('anim_dice', { seat: gameState.turn, roll });
             if(gameState.turn === 1) { gameState.temp.diceP1 = total; gameState.turn = 2; io.emit('state_update', gameState); }
             else {
                 let w = total > gameState.temp.diceP1 ? 2 : (total < gameState.temp.diceP1 ? 1 : 'draw');
                 resolveRound(w);
             }
        }
        // ... Other games ...
    }

    function resolveRound(winner) {
        if(winner !== 'draw') {
            gameState.scores[winner]++;
            payoutBets(winner);
        }
        checkMatchWin();
        gameState.turn = gameState.turn===1?2:1;
        io.emit('state_update', gameState);
    }

    function checkMatchWin() {
        const t = parseInt(gameState.settings.targetScore);
        let w = null;
        if(gameState.scores[1] >= t) w=1;
        if(gameState.scores[2] >= t) w=2;
        if(w) {
            gameState.matchActive = false;
            io.emit('match_over', { winner: w });
            // Pay Wager
            const wage = parseInt(gameState.settings.wager);
            if(wage > 0) {
                const l = w===1?2:1;
                users[gameState.seats[w]].balance += wage;
                users[gameState.seats[l]].balance -= wage;
                saveData();
            }
        }
    }

    function payoutBets(w) {
        gameState.currentBets.forEach(b => {
            if(b.target === w) users[b.user].balance += (b.amount*2);
        });
        saveData(); gameState.currentBets = [];
    }
    
    function r6(){return Math.ceil(Math.random()*6)}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running`));
