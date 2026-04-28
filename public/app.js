let ws, userId = localStorage.getItem('user_id');

document.getElementById('login-btn').onclick = async () => {
    const username = document.getElementById('username').value;
    const res = await fetch('/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username})
    });
    const data = await res.json();
    userId = data.user_id;
    localStorage.setItem('user_id', userId);
    document.getElementById('auth').style.display = 'none';
    document.getElementById('chat').style.display = 'flex';
    connect();
};

function connect() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({user_id: userId}));
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id) showMessage(msg);
    };
}

function showMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.from_id === userId ? 'message-own' : 'message-other'}`;
    let content = msg.text;
    if (msg.type === 'image') content = `<img src="${msg.file_url}" width="150">`;
    if (msg.type === 'file') content = `<a href="${msg.file_url}">📎 ${msg.text}</a>`;
    div.innerHTML = `<div class="name">${msg.from_name}</div>
                     <div class="bubble">${content}</div>
                     <div class="time">${new Date(msg.timestamp).toLocaleTimeString()}</div>`;
    document.getElementById('messages').appendChild(div);
    div.scrollIntoView();
}

document.getElementById('send').onclick = () => {
    const input = document.getElementById('text');
    if (!input.value.trim()) return;
    ws.send(JSON.stringify({from_id: userId, text: input.value, type: 'text'}));
    input.value = '';
};

document.getElementById('attach').onclick = () => document.getElementById('file').click();
document.getElementById('file').onchange = async (e) => {
    const fd = new FormData();
    fd.append('file', e.target.files[0]);
    const res = await fetch('/upload', {method: 'POST', body: fd});
    const data = await res.json();
    const type = e.target.files[0].type.startsWith('image/') ? 'image' : 'file';
    ws.send(JSON.stringify({from_id: userId, text: e.target.files[0].name, type, file_url: data.url}));
};

document.getElementById('notify').onclick = () => Notification.requestPermission();

document.getElementById('logout').onclick = () => {
    localStorage.removeItem('user_id');
    location.reload();
};

let pc, localStream, callActive = false;
document.getElementById('call').onclick = async () => {
    if (callActive) return;
    localStream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
    pc = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.ontrack = e => {
        let v = document.createElement('video');
        v.srcObject = e.streams[0];
        v.autoplay = true;
        document.getElementById('remote').innerHTML = '';
        document.getElementById('remote').appendChild(v);
    };
    let localV = document.createElement('video');
    localV.srcObject = localStream;
    localV.autoplay = true;
    localV.muted = true;
    document.getElementById('local').innerHTML = '';
    document.getElementById('local').appendChild(localV);
    document.getElementById('call-modal').style.display = 'block';
    callActive = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({type: 'offer', offer, from: userId}));
};

document.getElementById('end-call').onclick = () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (pc) pc.close();
    document.getElementById('call-modal').style.display = 'none';
    callActive = false;
};

if (userId) {
    document.getElementById('auth').style.display = 'none';
    document.getElementById('chat').style.display = 'flex';
    connect();
}
