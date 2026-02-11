const socket = io();
let isReg = false;
let myUser = "";

// AUTH
function toggleAuth() {
    isReg = !isReg;
    document.getElementById('login-btn').innerText = isReg ? "REGISTER" : "LOGIN";
    document.getElementById('auth-toggle').innerText = isReg ? "Back to Login" : "New? Create Account";
}

async function auth() {
    const u = document.getElementById('u-in').value;
    const p = document.getElementById('p-in').value;
    const err = document.getElementById('auth-error');
    
    // Client Validation
    if(!/^[A-Za-z0-9]{5,12}$/.test(u)) { err.style.display='block'; err.innerText="User: 5-12 chars, letters/nums only"; return; }
    if(p.length<5 || p.length>12) { err.style.display='block'; err.innerText="Pass: 5-12 chars"; return; }

    const res = await fetch(isReg ? '/api/register' : '/api/login', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:u, password:p})
    });
    const data = await res.json();
    
    if(res.ok) {
        if(isReg) { alert("Registered! Login now."); toggleAuth(); }
        else {
            myUser = data.user.username;
            document.getElementById('auth-overlay').style.display = 'none';
            socket.emit('join_game', { username: myUser });
        }
    } else {
        err.style.display='block'; err.innerText = data.error;
    }
}

// GAME
socket.on('state_update', ({players, duel}) => {
    // List
    document.getElementById('p-list').innerHTML = Object.values(players).map(p => 
        `<div style="color:${p.color}; margin-bottom:5px;">${p.username} ($${p.balance})</div>`
    ).join('');

    // Info
    document.getElementById('sc-l').innerText = duel.scores.left;
    document.getElementById('sc-r').innerText = duel.scores.right;
    document.getElementById('pot').innerText = `POT: $${duel.pot}`;

    // Seats
    renderSeat('left', duel.seatLeft, duel.leftLocked, players, duel);
    renderSeat('right', duel.seatRight, duel.rightLocked, players, duel);

    // Visuals
    const vis = { coin: 'v-coin', dice: 'v-dice', wheel: 'v-wheel' };
    ['v-coin','v-dice','v-wheel','v-res'].forEach(id => document.getElementById(id).style.display = 'none');
    
    if(duel.status === 'rolling') {
        document.getElementById(vis[duel.gameType]).style.display = 'block';
    } else if(duel.result) {
        const r = document.getElementById('v-res');
        r.style.display = 'block';
        if(duel.gameType==='coin') r.innerText = duel.result.outcome.toUpperCase();
        else {
            const lSum = duel.result.left.reduce((a,b)=>a+b,0);
            const rSum = duel.result.right.reduce((a,b)=>a+b,0);
            r.innerText = `${duel.gameType==='wheel'?'SLOT ':''}${lSum} - ${rSum}`;
        }
    }

    // Action Btn
    const isMe = (duel.seatLeft && players[duel.seatLeft]?.username === myUser) || (duel.seatRight && players[duel.seatRight]?.username === myUser);
    const myTurn = duel.status === 'interactive' && isMe && 
        ((myUser === players[duel.seatLeft]?.username && !duel.actions.left) || (myUser === players[duel.seatRight]?.username && !duel.actions.right));
    
    document.getElementById('act-btn').style.display = myTurn ? 'block' : 'none';
    document.getElementById('act-btn').innerText = duel.gameType === 'dice' ? "ROLL!" : "SPIN!";

    // Spectator
    document.getElementById('spec-bet').style.display = (!isMe && (duel.status==='open'||duel.status==='locked')) ? 'flex' : 'none';
});

function renderSeat(side, id, locked, players, duel) {
    const el = document.getElementById(`seat-${side}`);
    el.className = `seat ${id?'occupied':''} ${duel.winnerId===id?'winner':''}`;
    
    if(!id) {
        el.innerHTML = `<button class="pixel-btn" onclick="socket.emit('take_seat','${side}')">SIT HERE</button>`;
    } else {
        const p = players[id];
        const me = p.username === myUser;
        let ctrls = '';
        
        if(me) {
            ctrls = `
            <div class="ctrl-panel">
                <input id="bet" class="pixel-input" placeholder="BET" onchange="upd()">
                <select id="game" class="pixel-input" onchange="upd()"><option value="coin">Coin</option><option value="dice">Dice</option><option value="wheel">Wheel</option></select>
                <select id="mode" class="pixel-input" onchange="upd()"><option value="bo3">Best of 3</option><option value="race3">Race to 3</option></select>
                <button class="pixel-btn ${locked?'btn-green':''}" onclick="socket.emit('lock_in')">${locked?'LOCKED':'LOCK'}</button>
                <button class="pixel-btn" style="background:red" onclick="socket.emit('leave_seat')">LEAVE</button>
            </div>`;
        }
        
        el.innerHTML = `
            <img src="${p.avatar}" class="avatar" style="border-color:${p.color}">
            <div style="font-size:24px; color:${p.color}">${p.username}</div>
            <div style="color:#ffd700">$${p.balance}</div>
            ${ctrls}
        `;
        
        if(me && duel.status === 'open') {
             // Only set values if focused out (basic sync)
             if(document.activeElement.id !== 'bet') document.getElementById('bet').value = duel.betAmount;
             if(document.activeElement.id !== 'game') document.getElementById('game').value = duel.gameType;
             if(document.activeElement.id !== 'mode') document.getElementById('mode').value = duel.matchMode;
        }
    }
}

function upd() {
    socket.emit('update_settings', {
        bet: document.getElementById('bet').value,
        game: document.getElementById('game').value,
        mode: document.getElementById('mode').value
    });
}
function doAction() { socket.emit('perform_action'); document.getElementById('act-btn').style.display='none'; }
function spec(side) {
    const amt = document.getElementById('sp-amt').value;
    if(amt>0) socket.emit('place_spectator_bet', {amount:amt, side});
}
function sendChat(e) {
    if(e.key==='Enter') { socket.emit('send_chat', e.target.value); e.target.value=''; }
}

socket.on('chat_message', msg => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${msg.color}">${msg.name||'SYS'}:</span> ${msg.text}`;
    document.getElementById('chat-msgs').appendChild(d);
});