const socket = io();
let me = "";

async function auth(type) {
    const u = document.getElementById('u').value;
    const p = document.getElementById('p').value;
    const res = await fetch('/api/'+type, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:u, password:p}) });
    const data = await res.json();
    if(res.ok) { 
        if(type === 'login') { me = data.user.username; document.getElementById('auth').style.display='none'; socket.emit('join', me); }
        else alert('Registered!');
    } else document.getElementById('err').innerText = data.error;
}

document.getElementById('cin').onkeypress = (e) => {
    if(e.key === 'Enter') { socket.emit('chat', e.target.value); e.target.value = ''; }
};

socket.on('msg', m => {
    const d = document.createElement('div');
    d.innerHTML = `<span style="color:${m.color}">${m.name}:</span> <span style="color:#fff">${m.text}</span>`;
    const h = document.getElementById('history');
    h.appendChild(d); h.scrollTop = h.scrollHeight;
});

socket.on('state', ({players, duel}) => {
    document.getElementById('plist').innerHTML = Object.values(players).map(p => `<div class="p-bar">${p.name} ($${p.balance})</div>`).join('');
    document.getElementById('pot-ui').innerText = `POT: ${duel.pot} | ${duel.score.l} - ${duel.score.r}`;
    
    updateSeat('sl', 'l', duel, players);
    updateSeat('sr', 'r', duel, players);

    const isDuelist = players[socket.id] && (socket.id === duel.l || socket.id === duel.r);
    const actBtn = document.getElementById('act-btn');
    actBtn.style.display = (duel.status === 'act' && isDuelist && !duel.actions[socket.id === duel.l ? 'l' : 'r']) ? 'block' : 'none';
    
    if(duel.status === 'rolling') document.getElementById('visual').innerText = "ROLLING...";
    else if(duel.res) document.getElementById('visual').innerText = duel.res.val || `${duel.res.l.reduce((a,b)=>a+b)} v ${duel.res.r.reduce((a,b)=>a+b)}`;
});

function updateSeat(id, side, duel, players) {
    const el = document.getElementById(id);
    const p = players[duel[side]];
    if(!p) el.innerHTML = `<button onclick="socket.emit('seat', '${side}')">SIT</button>`;
    else {
        el.innerHTML = `<div style="color:${p.color}">${p.name}</div>$${p.balance}<div>${duel[side+'Lock']?'READY':'...'}</div>`;
        if(p.name === me && duel.status === 'open') {
            el.innerHTML += `<input id="b" value="${duel.bet}" onchange="upd()"><button onclick="socket.emit('lock')">LOCK</button>`;
        }
    }
}

function upd() { socket.emit('update_duel', { bet: document.getElementById('b').value, game: 'coin', mode: 'bo3' }); }
function spec(side) { socket.emit('spec_bet', { side, amt: document.getElementById('samt').value }); }
