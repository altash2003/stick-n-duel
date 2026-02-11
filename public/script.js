const socket = io();
let isReg = false;
let myUser = "";

// --- AUTH SYSTEM ---
function toggleAuth() {
    isReg = !isReg;
    const btn = document.getElementById('login-btn');
    const toggle = document.getElementById('auth-toggle');
    const errorBox = document.getElementById('auth-error');
    
    // Reset UI
    errorBox.style.display = 'none';
    errorBox.innerText = "";
    document.getElementById('u-in').value = "";
    document.getElementById('p-in').value = "";

    if(isReg) {
        btn.innerText = "CREATE ACCOUNT";
        btn.style.background = "#00bfff";
        toggle.innerText = "« Back to Login";
    } else {
        btn.innerText = "LOGIN";
        btn.style.background = "#3366ff";
        toggle.innerText = "New? Create Account";
    }
}

async function auth() {
    const u = document.getElementById('u-in').value;
    const p = document.getElementById('p-in').value;
    const err = document.getElementById('auth-error');
    const btn = document.getElementById('login-btn');
    
    // 1. Client-Side Validation
    if(!u || !p) {
        showError("Please fill in all fields.");
        return;
    }
    if(!/^[A-Za-z0-9]{5,12}$/.test(u)) { 
        showError("Username: 5-12 chars, letters/numbers only."); 
        return; 
    }
    if(p.length < 5 || p.length > 12) { 
        showError("Password: 5-12 characters."); 
        return; 
    }

    // 2. Loading State
    btn.disabled = true;
    btn.innerText = "PROCESSING...";
    err.style.display = 'none';

    try {
        const endpoint = isReg ? '/api/register' : '/api/login';
        
        const res = await fetch(endpoint, {
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({username:u, password:p})
        });
        
        const data = await res.json();
        
        if(res.ok) {
            if(isReg) { 
                alert("Account created successfully! Please login."); 
                toggleAuth(); 
            } else {
                // SUCCESS LOGIN
                myUser = data.user.username;
                document.getElementById('auth-overlay').style.display = 'none';
                socket.emit('join_game', { username: myUser });
            }
        } else {
            showError(data.error || "Authentication failed");
        }
    } catch (e) {
        console.error(e);
        showError("Connection Error. Is the server running?");
    } finally {
        btn.disabled = false;
        btn.innerText = isReg ? "CREATE ACCOUNT" : "LOGIN";
    }
}

function showError(msg) {
    const err = document.getElementById('auth-error');
    err.style.display = 'block';
    err.innerText = msg;
}

// --- GAME LOGIC (Socket Events) ---

socket.on('state_update', ({players, duel}) => {
    // 1. UPDATE PLAYERS LIST
    const pList = document.getElementById('p-list');
    pList.innerHTML = Object.values(players).map(p => 
        `<div style="color:${p.color}; border-bottom:1px solid #333; padding:4px;">
            ${p.username} <span style="float:right; color:#ffd700">$${p.balance}</span>
        </div>`
    ).join('');

    // 2. UPDATE TOP BAR
    document.getElementById('sc-l').innerText = duel.scores.left;
    document.getElementById('sc-r').innerText = duel.scores.right;
    document.getElementById('pot').innerText = `POT: $${duel.pot}`;

    // 3. RENDER SEATS
    renderSeat('left', duel.seatLeft, duel.leftLocked, players, duel);
    renderSeat('right', duel.seatRight, duel.rightLocked, players, duel);

    // 4. MANAGE VISUALS
    const visuals = ['v-coin', 'v-dice', 'v-wheel', 'v-res'];
    visuals.forEach(v => document.getElementById(v).style.display = 'none');

    if(duel.status === 'rolling') {
        const activeVis = duel.gameType === 'coin' ? 'v-coin' : (duel.gameType === 'dice' ? 'v-dice' : 'v-wheel');
        document.getElementById(activeVis).style.display = 'block';
    } else if(duel.result) {
        const resBox = document.getElementById('v-res');
        resBox.style.display = 'block';
        if(duel.gameType === 'coin') {
            resBox.innerText = duel.result.outcome.toUpperCase();
        } else {
            const lSum = duel.result.left.reduce((a,b)=>a+b,0);
            const rSum = duel.result.right.reduce((a,b)=>a+b,0);
            resBox.innerText = `${lSum} - ${rSum}`;
        }
    }

    // 5. ACTION BUTTON LOGIC
    const amILeft = duel.seatLeft && players[duel.seatLeft]?.username === myUser;
    const amIRight = duel.seatRight && players[duel.seatRight]?.username === myUser;
    
    // Check if it is MY turn to act
    let myTurn = false;
    if (duel.status === 'interactive') {
        if (amILeft && !duel.actions.left) myTurn = true;
        if (amIRight && !duel.actions.right) myTurn = true;
    }

    const actBtn = document.getElementById('act-btn');
    if (myTurn) {
        actBtn.style.display = 'block';
        actBtn.innerText = duel.gameType === 'dice' ? "ROLL DICE!" : "SPIN!";
    } else {
        actBtn.style.display = 'none';
    }

    // 6. SPECTATOR BETTING (Hide if I am sitting)
    const isSeated = amILeft || amIRight;
    const canBet = (duel.status === 'open' || duel.status === 'locked') && !isSeated;
    document.getElementById('spec-bet').style.display = canBet ? 'flex' : 'none';
});

function renderSeat(side, id, locked, players, duel) {
    const el = document.getElementById(`seat-${side}`);
    el.className = `seat ${id ? 'occupied' : ''} ${duel.winnerId === id ? 'winner' : ''}`;
    
    if(!id) {
        el.innerHTML = `<button class="pixel-btn" onclick="socket.emit('take_seat', '${side}')">SIT HERE</button>`;
    } else {
        const p = players[id];
        const isMe = p.username === myUser;
        
        let controls = '';
        if(isMe) {
            controls = `
            <div class="ctrl-panel" style="display:flex;">
                <input id="bet" class="pixel-input" placeholder="BET" onchange="upd()">
                <select id="game" class="pixel-input" onchange="upd()"><option value="coin">Coin</option><option value="dice">Dice</option><option value="wheel">Wheel</option></select>
                <button class="pixel-btn ${locked?'btn-green':''}" onclick="socket.emit('lock_in')">${locked?'LOCKED':'LOCK'}</button>
                <button class="pixel-btn" style="background:#cc0000;" onclick="socket.emit('leave_seat')">LEAVE</button>
            </div>`;
        } else {
            // View for others
            controls = `<div style="margin-top:auto; font-size:24px; color:${locked?'#00ff00':'#888'}">${locked ? 'READY' : 'WAITING'}</div>`;
        }

        el.innerHTML = `
            <img src="${p.avatar}" class="avatar" style="border-color:${p.color}">
            <div style="font-size:24px; color:${p.color}">${p.username}</div>
            <div style="color:#ffd700">$${p.balance}</div>
            ${controls}
        `;
        
        // Sync Inputs (only if me and not currently editing)
        if(isMe && duel.status === 'open') {
             if(document.activeElement.id !== 'bet') document.getElementById('bet').value = duel.betAmount;
             if(document.activeElement.id !== 'game') document.getElementById('game').value = duel.gameType;
        }
    }
}

function upd() {
    socket.emit('update_settings', {
        bet: document.getElementById('bet').value,
        game: document.getElementById('game').value
    });
}

function doAction() { socket.emit('perform_action'); }
function spec(side) {
    const amt = document.getElementById('sp-amt').value;
    if(amt>0) socket.emit('place_spectator_bet', {amount:amt, side});
}
function sendChat(e) {
    if(e.key === 'Enter') { 
        socket.emit('send_chat', e.target.value); 
        e.target.value = ''; 
    }
}

socket.on('chat_message', msg => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${msg.color}">${msg.name||'SYS'}:</span> ${msg.text}`;
    document.getElementById('chat-msgs').appendChild(d);
});
