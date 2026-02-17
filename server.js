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
    seats: { 1: null, 2: null }, 
    sockets: { 1: null, 2: null },
    hostSeat: null,
    
    settings: { game: 'dice', targetScore: 1, wager: 0 },
    scores: { 1: 0, 2: 0 },
    turn: 1,
    
    matchActive: false,
    negotiating: false,
    bettingLocked: false,
    currentBets: [],

    // Game Memory
    temp: { 
        diceP1: null, 
        diceRollP1: [], 
        rps: { 1: null, 2: null }, 
        hlCurrent: 7, 
        tttBoard: Array(9).fill(null) 
    }
};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', (socket) => {
    let currentUser = null;

    // --- AUTHENTICATION ---
    socket.on('auth', ({ username, password }) => {
        if (!users[username]) { users[username] = { password, balance: 1000 }; saveUsers(); }
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('auth_success', { username, balance: users[username].balance });
            socket.emit('state_update', gameState);
            io.emit('chat_msg', { user: 'SYSTEM', text: `${username} JOINED`, color: '#feca57' });
        } else socket.emit('auth_fail', 'WRONG PASSWORD');
    });

    // --- WALLET & TICKETS ---
    socket.on('wallet_action', (data) => {
        if(!currentUser) return;
        
        if(data.type === 'deposit') {
            const amt = parseInt(data.amount);
            if(amt > 0) {
                users[currentUser].balance += amt;
                saveUsers();
                socket.emit('balance_update', users[currentUser].balance);
                socket.emit('alert', `DEPOSITED ${amt} TC SUCCESS!`);
            }
        } 
        else if(data.type === 'withdraw') {
            const amt = parseInt(data.amount);
            if(amt > 0 && users[currentUser].balance >= amt) {
                users[currentUser].balance -= amt;
                saveUsers();
                socket.emit('balance_update', users[currentUser].balance);
                socket.emit('alert', `WITHDRAWAL OF ${amt} TC PROCESSED.`);
            } else {
                socket.emit('alert', "INSUFFICIENT FUNDS.");
            }
        }
        else if(data.type === 'ticket') {
            // In a real app, save to DB. Here we log it.
            console.log(`[TICKET] ${currentUser}: ${data.msg}`);
            socket.emit('alert', "SUPPORT TICKET SENT.");
        }
    });

    // --- CHAT ---
    socket.on('chat_msg', (msg) => {
        if(currentUser) io.emit('chat_msg', { user: currentUser, text: msg, color: '#fff' });
    });

    // --- SPECTATOR BETTING ---
    socket.on('place_bet', ({ amount, target }) => {
        if (!currentUser || !gameState.matchActive || gameState.bettingLocked) return;
        if (users[currentUser].balance < amount) return;

        users[currentUser].balance -= amount;
        saveUsers();
        gameState.currentBets.push({ user: currentUser, amount, target });
        
        socket.emit('balance_update', users[currentUser].balance);
        io.emit('chat_msg', { user: 'SYSTEM', text: `${currentUser} bet ${amount} on P${target}`, color: '#aaa' });
    });

    // --- SEATS ---
    socket.on('request_seat', (n) => {
        if (!currentUser) return;
        if (gameState.seats[1] === currentUser || gameState.seats[2] === currentUser) {
            socket.emit('alert', "YOU ARE ALREADY SEATED.");
            return;
        }
        if (gameState.seats[n]) return; 

        gameState.seats[n] = currentUser;
        gameState.sockets[n] = socket.id;

        if (!gameState.hostSeat) gameState.hostSeat = n;

        if (gameState.seats[1] && gameState.seats[2]) {
            gameState.negotiating = true;
            io.to(gameState.sockets[gameState.hostSeat]).emit('prompt_proposal');
            io.to(gameState.sockets[gameState.hostSeat === 1 ? 2 : 1]).emit('wait_for_proposal');
        }
        io.emit('state_update', gameState);
    });

    // --- NEGOTIATION ---
    socket.on('propose_terms', (terms) => {
        if (gameState.sockets[gameState.hostSeat] !== socket.id) return;
        gameState.settings = terms;
        io.to(gameState.sockets[gameState.hostSeat === 1 ? 2 : 1]).emit('review_terms', terms);
    });

    socket.on('respond_terms', (accepted) => {
        if (accepted) {
            gameState.negotiating = false;
            gameState.matchActive = true;
            gameState.scores = { 1: 0, 2: 0 };
            gameState.turn = 1;
            gameState.temp = { diceP1: null, diceRollP1: [], rps: { 1: null, 2: null }, hlCurrent: 7, tttBoard: Array(9).fill(null) };
            
            io.emit('chat_msg', { user: 'SYSTEM', text: `MATCH STARTED: ${gameState.settings.game.toUpperCase()}`, color: '#2ecc71' });
            io.emit('state_update', gameState);
            io.emit('game_reset', gameState.settings.game); 

            // Trigger Voice
            io.to(gameState.sockets[1]).emit('start_voice', { initiator: true });
            io.to(gameState.sockets[2]).emit('start_voice', { initiator: false });
        } else {
            const seat = gameState.hostSeat === 1 ? 2 : 1;
            const sock = gameState.sockets[seat];
            gameState.seats[seat] = null; gameState.sockets[seat] = null;
            if(sock) io.to(sock).emit('kicked');
            io.emit('state_update', gameState);
        }
    });

    // --- GAMEPLAY LOGIC ---
    socket.on('game_action', (data) => {
        if (!gameState.matchActive) return;
        
        const isRPS = gameState.settings.game === 'rps';
        if (!isRPS && gameState.seats[gameState.turn] !== currentUser) return;
        if (isRPS && !Object.values(gameState.seats).includes(currentUser)) return;

        gameState.bettingLocked = true;
        io.emit('state_update', gameState);

        let win = null; 
        let roundOver = false;
        let switchTurn = true;
        const G = gameState.settings.game;

        // 1. DICE
        if (G === 'dice') {
            const roll = [r6(), r6(), r6()];
            const total = roll.reduce((a,b)=>a+b,0);
            io.emit('anim_dice', { seat: gameState.turn, roll });
            
            if (gameState.turn === 1) {
                gameState.temp.diceP1 = total;
                gameState.temp.diceRollP1 = roll;
            } else {
                if (gameState.temp.diceP1 > total) win = 1;
                else if (total > gameState.temp.diceP1) win = 2;
                else win = 'draw';
                gameState.temp.diceP1 = null; roundOver = true;
            }
        }
        // 2. COIN
        else if (G === 'coin') {
            const res = Math.random() < 0.5 ? 'H' : 'T';
            io.emit('anim_coin', { result: res });
            if (data.guess === res) { win = gameState.turn; roundOver = true; } else roundOver = true;
        }
        // 3. HI-LO
        else if (G === 'hl') {
            let next = r13();
            while(next === gameState.temp.hlCurrent) next = r13();
            io.emit('anim_hl', { current: gameState.temp.hlCurrent, next });
            const isHigh = (data.guess === 'high' && next > gameState.temp.hlCurrent);
            const isLow = (data.guess === 'low' && next < gameState.temp.hlCurrent);
            gameState.temp.hlCurrent = next;
            if (isHigh || isLow) { win = gameState.turn; roundOver = true; } else roundOver = true;
        }
        // 4. ROULETTE
        else if (G === 'roulette') {
            const isRed = Math.random() < 0.5;
            const res = isRed ? 'RED' : 'BLACK';
            const angle = 1440 + Math.random() * 360; 
            io.emit('anim_roulette', { angle, result: res });
            if (data.guess === res) { win = gameState.turn; roundOver = true; } else roundOver = true;
        }
        // 5. RPS
        else if (G === 'rps') {
            const seat = gameState.seats[1] === currentUser ? 1 : 2;
            gameState.temp.rps[seat] = data.guess;
            io.emit('rps_lock', { seat });
            switchTurn = false;
            
            if (gameState.temp.rps[1] && gameState.temp.rps[2]) {
                const p1 = gameState.temp.rps[1];
                const p2 = gameState.temp.rps[2];
                io.emit('rps_reveal', { p1, p2 });
                if (p1 === p2) win = 'draw';
                else if ((p1=='R'&&p2=='S') || (p1=='P'&&p2=='R') || (p1=='S'&&p2=='P')) win = 1;
                else win = 2;
                gameState.temp.rps = { 1: null, 2: null };
                roundOver = true; switchTurn = true;
            }
        }
        // 6. TTT
        else if (G === 'ttt') {
            if (gameState.temp.tttBoard[data.index] !== null) return;
            const sym = gameState.turn === 1 ? 'X' : 'O';
            gameState.temp.tttBoard[data.index] = sym;
            io.emit('anim_ttt', { board: gameState.temp.tttBoard });
            if (checkTTTWin(sym)) { win = gameState.turn; roundOver = true; }
            else if (!gameState.temp.tttBoard.includes(null)) { win = 'draw'; roundOver = true; }
        }

        // RESULT HANDLING (Fast)
        if (roundOver || switchTurn) {
            const delay = (G === 'roulette') ? 3000 : 1000;
            
            setTimeout(() => {
                if (roundOver) {
                    if (win && win !== 'draw') {
                        gameState.scores[win]++;
                        io.emit('chat_msg', { user: 'REF', text: `POINT PLAYER ${win}`, color: '#2ecc71' });
                        payoutBets(win);
                    } else if (win === 'draw') {
                        io.emit('chat_msg', { user: 'REF', text: `DRAW`, color: '#aaa' });
                    }
                    if(G==='ttt') gameState.temp.tttBoard = Array(9).fill(null);
                    checkMatchWin();
                }
                gameState.bettingLocked = false;
                if(!gameState.matchActive) return;
                
                gameState.turn = gameState.turn === 1 ? 2 : 1;
                io.emit('state_update', gameState);
            }, delay);
        }
    });

    function payoutBets(winnerSeat) {
        gameState.currentBets.forEach(bet => {
            if (bet.target === winnerSeat) users[bet.user].balance += (bet.amount * 2);
        });
        saveUsers();
        gameState.currentBets = [];
    }

    function checkMatchWin() {
        const target = parseInt(gameState.settings.targetScore);
        let winner = null;
        if (gameState.scores[1] >= target) winner = 1;
        if (gameState.scores[2] >= target) winner = 2;

        if (winner) {
            gameState.matchActive = false;
            gameState.hostSeat = null; 
            io.emit('match_over', { winner, name: gameState.seats[winner] });
            
            const wager = parseInt(gameState.settings.wager);
            if (wager > 0) {
                const loser = winner === 1 ? 2 : 1;
                if(users[gameState.seats[winner]]) users[gameState.seats[winner]].balance += wager;
                if(users[gameState.seats[loser]]) users[gameState.seats[loser]].balance -= wager;
                saveUsers();
                if(gameState.sockets[1]) io.to(gameState.sockets[1]).emit('balance_update', users[gameState.seats[1]]?.balance);
                if(gameState.sockets[2]) io.to(gameState.sockets[2]).emit('balance_update', users[gameState.seats[2]]?.balance);
            }
            gameState.scores = { 1: 0, 2: 0 };
            gameState.temp.tttBoard = Array(9).fill(null);
            io.emit('state_update', gameState);
        }
    }
    
    // Voice
    socket.on('voice_signal', (data) => {
        const target = gameState.sockets[1] === socket.id ? 2 : 1;
        if(gameState.sockets[target]) io.to(gameState.sockets[target]).emit('voice_signal', data);
    });
    
    // Leave
    socket.on('leave_seat', () => {
        if(gameState.matchActive) { socket.emit('alert', "MATCH LOCKED"); return; }
        if(gameState.seats[1] === currentUser) { gameState.seats[1] = null; gameState.sockets[1] = null; }
        if(gameState.seats[2] === currentUser) { gameState.seats[2] = null; gameState.sockets[2] = null; }
        io.emit('state_update', gameState);
    });

    function r6() { return Math.ceil(Math.random() * 6); }
    function r13() { return Math.ceil(Math.random() * 13); }
    function checkTTTWin(s) {
        const b = gameState.temp.tttBoard;
        const w = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        return w.some(c => b[c[0]]===s && b[c[1]]===s && b[c[2]]===s);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running`));
