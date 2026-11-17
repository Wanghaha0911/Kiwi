'use strict';
/* Kiwi · 猕猴桃-你的文件助手 — WebRTC (PeerJS) multi-device transfer.
   Landing page = host with a big QR; phones scan and land back on this page
   with a #join= payload in the URL hash and auto-connect.
   Pairing: TEMPORARY by default (page open = session alive; close = gone).
   Optional TRUST: host can pin its channel (localStorage), guests can pin a
   host (localStorage) and reconnect without scanning — both pages still
   need to be open at the same time; nothing is stored on any server.
   Pure helpers are exported for Node unit tests; the browser app only
   boots when document + Peer exist. */

// ---------- Pure helpers (Node-testable) ----------
var CHUNK_SIZE = 64 * 1024; // 64KB per DataChannel chunk
var PALETTE = ['#58a322', '#e67e22', '#2471a3', '#8e44ad', '#c0392b', '#148f77', '#b7950b', '#616a6b', '#ad1457', '#6c3483'];

function planChunks(size, chunkSize) {
  chunkSize = chunkSize || CHUNK_SIZE;
  var out = [];
  if (!size || size <= 0) return out;
  var n = Math.ceil(size / chunkSize);
  for (var i = 0; i < n; i++) {
    out.push({ index: i, start: i * chunkSize, end: Math.min(size, (i + 1) * chunkSize) });
  }
  return out;
}

function reassembleChunks(chunks) {
  var total = 0, i;
  for (i = 0; i < chunks.length; i++) total += chunks[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
  return out;
}

function hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function colorFromId(id) { return PALETTE[hashStr(String(id)) % PALETTE.length]; }

function detectPlatform(ua) {
  ua = ua || '';
  if (/iPhone/i.test(ua)) return { platform: 'iPhone', icon: '📱' };
  if (/iPad/i.test(ua)) return { platform: 'iPad', icon: '📱' };
  if (/Android/i.test(ua)) return { platform: 'Android', icon: '🤖' };
  if (/Windows/i.test(ua)) return { platform: 'Windows', icon: '💻' };
  if (/Macintosh|Mac OS/i.test(ua)) return { platform: 'Mac', icon: '💻' };
  if (/Linux/i.test(ua)) return { platform: 'Linux', icon: '💻' };
  return { platform: '未知设备', icon: '🔌' };
}

function randomCode(len, alphabet) {
  alphabet = alphabet || 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var s = '';
  var arr = new Uint32Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (var j = 0; j < len; j++) arr[j] = Math.floor(Math.random() * 4294967296);
  for (var i = 0; i < len; i++) s += alphabet[arr[i] % alphabet.length];
  return s;
}

function hostPeerIdForRoom(room) { return 'kiwi-' + String(room).toLowerCase(); }

function makeRoomPayload(room, secret) {
  return JSON.stringify({ v: 1, room: room, hostPeerId: hostPeerIdForRoom(room), secret: secret });
}

// --- Join payload carried in the page URL hash: #join=<base64url(JSON)> ---
// The JSON is ASCII-only (room code / peer id / secret are alphanumerics),
// so plain base64 is safe; base64url keeps the URL tidy.
function b64Encode(str) {
  var b64;
  if (typeof Buffer !== 'undefined') b64 = Buffer.from(str, 'utf8').toString('base64');
  else b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64Decode(s) {
  var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  return atob(b64);
}

function encodeJoinPayload(room, secret) {
  return b64Encode(JSON.stringify({ v: 1, room: String(room).toUpperCase(), hostPeerId: hostPeerIdForRoom(room), secret: secret }));
}

function decodeJoinPayload(s) {
  if (!s) return null;
  try {
    var o = JSON.parse(b64Decode(String(s).trim()));
    if (o && o.room) {
      var room = String(o.room).toUpperCase();
      return { room: room, secret: o.secret || '', hostPeerId: o.hostPeerId || hostPeerIdForRoom(room), viaQR: true };
    }
  } catch (e) { /* not a join payload */ }
  return null;
}

function buildJoinUrl(baseUrl, room, secret) {
  var base = String(baseUrl || '').split('#')[0];
  return base + '#join=' + encodeJoinPayload(room, secret);
}

function parseJoinFromHash(hash) {
  if (!hash) return null;
  var m = String(hash).match(/join=([A-Za-z0-9\-_+/=]+)/);
  if (!m) return null;
  return decodeJoinPayload(m[1]);
}

function parseRoomPayload(text) {
  if (!text) return null;
  text = String(text).trim();
  // A scanned Kiwi QR is now a full page URL carrying #join=...
  var fromHash = parseJoinFromHash(text);
  if (fromHash) return fromHash;
  try {
    var o = JSON.parse(text);
    if (o && o.room) return { room: String(o.room).toUpperCase(), secret: o.secret || '', hostPeerId: o.hostPeerId || hostPeerIdForRoom(o.room), viaQR: true };
  } catch (e) { /* not JSON: fall through to manual code */ }
  if (/^[A-Za-z0-9]{6,12}$/.test(text)) {
    var room = text.toUpperCase();
    return { room: room, secret: 'manual:' + room, hostPeerId: hostPeerIdForRoom(room), viaQR: false };
  }
  return null;
}

function findUrls(text) {
  return String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHUNK_SIZE, planChunks, reassembleChunks, colorFromId, detectPlatform, randomCode, hostPeerIdForRoom, makeRoomPayload, parseRoomPayload, findUrls, encodeJoinPayload, decodeJoinPayload, buildJoinUrl, parseJoinFromHash };
}

// ---------- Browser app ----------
if (typeof document !== 'undefined' && typeof Peer !== 'undefined') {
  boot();
}

function boot() {
  var $ = function (id) { return document.getElementById(id); };
  var PEER_OPTS = {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  };

  // ----- persistent identity (survives everything; it is just "who am I") -----
  var deviceId = localStorage.getItem('kiwi_deviceId');
  if (!deviceId) { deviceId = 'dev-' + randomCode(10, 'abcdefghijklmnopqrstuvwxyz0123456789'); localStorage.setItem('kiwi_deviceId', deviceId); }
  var plat = detectPlatform(navigator.userAgent);
  var myName = localStorage.getItem('kiwi_deviceName') || (plat.platform + '-' + deviceId.slice(-4));
  var me = { deviceId: deviceId, name: myName, platform: plat.platform, icon: plat.icon, color: colorFromId(deviceId), peerId: null };
  localStorage.removeItem('kiwi_room'); // legacy key from the app version; the web version does not resume rooms implicitly

  // ----- trust storage -----
  function loadJSON(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function getHostChannel() { return loadJSON('kiwi_host_channel', null); }        // {room, secret} when 记住此通道 is ON
  function setHostChannel(c) { if (c) localStorage.setItem('kiwi_host_channel', JSON.stringify(c)); else localStorage.removeItem('kiwi_host_channel'); }
  function getTrustedHosts() { return loadJSON('kiwi_trusted_hosts', []); }          // [{room, hostPeerId, secret, hostLabel, savedAt}]
  function saveTrustedHosts(l) { localStorage.setItem('kiwi_trusted_hosts', JSON.stringify(l)); }
  function upsertTrustedHost(info, label) {
    var list = getTrustedHosts().filter(function (h) { return h.room !== info.room; });
    list.unshift({ room: info.room, hostPeerId: info.hostPeerId, secret: info.secret, hostLabel: label || ('连接 ' + info.room), savedAt: Date.now() });
    saveTrustedHosts(list.slice(0, 8));
  }
  function removeTrustedHost(roomCode) { saveTrustedHosts(getTrustedHosts().filter(function (h) { return h.room !== roomCode; })); }
  function isTrustedHost(roomCode) { return getTrustedHosts().some(function (h) { return h.room === roomCode; }); }
  function getHostTrustedGuests() { return loadJSON('kiwi_host_trusted', {}); }      // deviceId -> device snapshot
  function saveHostTrustedGuests(m) { localStorage.setItem('kiwi_host_trusted', JSON.stringify(m)); }

  // ----- state -----
  var peer = null, isHost = false, room = null, secret = null, currentHostPeerId = null;
  var rememberChannel = false;
  var roster = {};         // deviceId -> device info (incl. peerId, online)
  var conns = {};          // peerId -> DataConnection
  var connDevice = {};     // peerId -> deviceId
  var seen = {};           // msgId/transferId dedup
  var recvState = {};      // peerId -> active incoming transfer
  var sendQueues = {};     // peerId -> promise chain (one file at a time per conn)
  var autoProbe = null;    // {room, timer} while auto-reconnecting to a trusted host
  var guestInfo = null;    // join payload of the room we are a guest in
  var lastOfflineRooms = {}; // room -> true, remembered so the trusted card keeps its 离线 badge across re-renders

  function setStatus(t) { $('connStatus').textContent = t; }
  function publicMe() { return { deviceId: me.deviceId, name: me.name, platform: me.platform, icon: me.icon, color: me.color, peerId: me.peerId, online: true }; }
  function joinUrl() { return buildJoinUrl(location.href, room, secret); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  // ----- UI: self + roster -----
  function renderSelf() {
    $('selfBadge').innerHTML = '<span class="avatar" style="background:' + me.color + '">' + me.icon + '</span> ' + escapeHtml(me.name) + '（' + me.platform + '）';
    if (document.activeElement !== $('devName')) $('devName').value = me.name;
  }
  function renderRoster() {
    var list = $('deviceList'); list.innerHTML = '';
    var ids = Object.keys(roster);
    var onlineCount = ids.filter(function (id) { return roster[id].online !== false; }).length;
    $('devCount').textContent = ids.length ? '（' + onlineCount + ' 台在线 / 共 ' + ids.length + ' 台）' : '';
    document.body.classList.toggle('hasPeers', onlineCount > 1); // desktop stage: QR hero until a peer is online, then the feed
    var sel = $('targetSel');
    var cur = sel.value;
    sel.innerHTML = '<option value="ALL">所有设备</option>';
    var trustedGuests = getHostTrustedGuests();
    ids.forEach(function (id) {
      var d = roster[id];
      var off = d.online === false;
      var li = document.createElement('li');
      if (off) li.className = 'offline';
      var html = '<span class="dot' + (off ? '' : ' on') + '"></span><span class="avatar" style="background:' + d.color + '">' + (d.icon || '🔌') + '</span><b>' + escapeHtml(d.name) + '</b><span>' + escapeHtml(d.platform) + '</span>';
      if (id === deviceId) html += '<span class="selfTag">本机</span>';
      if (off) html += '<span class="offTag">离线</span>';
      if (isHost && id !== deviceId) {
        var trusted = !!trustedGuests[id];
        if (trusted) html += '<span class="trustTag">已信任</span>';
        html += '<button class="ghost small" data-trust-guest="' + escapeHtml(id) + '">' + (trusted ? '取消信任' : '信任此设备') + '</button>';
      }
      li.innerHTML = html;
      list.appendChild(li);
      if (id !== deviceId && !off) {
        var op = document.createElement('option'); op.value = id; op.textContent = d.name + '（' + d.platform + '）'; sel.appendChild(op);
      }
    });
    if ([].some.call(sel.options, function (o) { return o.value === cur; })) sel.value = cur;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-trust-guest')) {
      toggleHostTrustGuest(t.getAttribute('data-trust-guest'));
    }
    if (t && t.classList && t.classList.contains('copyBtn')) {
      var u = t.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(u);
      t.textContent = '已复制';
    }
  });
  function toggleHostTrustGuest(id) {
    var map = getHostTrustedGuests();
    if (map[id]) {
      delete map[id];
      if (roster[id] && roster[id].online === false) delete roster[id]; // forgotten + offline: drop from roster entirely
    } else if (roster[id]) {
      var d = roster[id];
      map[id] = { deviceId: d.deviceId, name: d.name, platform: d.platform, icon: d.icon, color: d.color };
    }
    saveHostTrustedGuests(map);
    renderRoster();
    hostBroadcastRoster();
  }

  // ----- UI: trusted hosts card (guest side) -----
  function renderTrustedCard(offlineRooms) {
    var list = getTrustedHosts();
    var card = $('trustedCard');
    if (offlineRooms) lastOfflineRooms = offlineRooms;
    offlineRooms = lastOfflineRooms;
    if (!list.length) { card.classList.add('hidden'); return; }
    if (guestInfo) { card.classList.add('hidden'); return; } // while connected as guest, the join banner covers trust controls
    card.classList.remove('hidden');
    var ul = $('trustedList'); ul.innerHTML = '';
    list.forEach(function (h) {
      var li = document.createElement('li');
      var off = offlineRooms && offlineRooms[h.room];
      li.innerHTML = '<span class="avatar" style="background:' + colorFromId(h.room) + '">🥝</span><b>' + escapeHtml(h.hostLabel || ('连接 ' + h.room)) + '</b><span>通道 ' + escapeHtml(h.room) + '</span>' +
        (off ? '<span class="offTag">对方未打开页面</span>' : '') +
        '<button class="ghost small" data-reconnect="' + escapeHtml(h.room) + '">重连</button>' +
        '<button class="ghost small danger" data-forget="' + escapeHtml(h.room) + '">忘记此设备</button>';
      ul.appendChild(li);
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var rc = t.getAttribute('data-reconnect');
    if (rc) {
      var h = getTrustedHosts().filter(function (x) { return x.room === rc; })[0];
      if (h) { setStatus('正在重连 ' + (h.hostLabel || rc) + '…'); joinRoom({ room: h.room, secret: h.secret, hostPeerId: h.hostPeerId, viaQR: true }, { viaTrust: true }); }
    }
    var fg = t.getAttribute('data-forget');
    if (fg) { removeTrustedHost(fg); renderTrustedCard(); setStatus('已忘记该信任设备，下次连接需要重新扫码'); }
  });

  // ----- UI: messages -----
  function addMsg(opts) {
    var wrap = document.createElement('div');
    wrap.className = 'msg' + (opts.mine ? ' mine' : '');
    var from = opts.from || me;
    var meta = '<span class="chip" style="background:' + (from.color || '#888') + '">' + (from.icon || '') + ' ' + escapeHtml(from.name || '') + '</span><span>' + new Date(opts.ts || Date.now()).toLocaleTimeString() + '</span>';
    var body = '';
    if (opts.text != null) {
      body = '<div class="txt">' + linkify(opts.text) + '</div>';
    } else if (opts.file) {
      var f = opts.file;
      if (f.isImage && f.url) body += '<img class="preview" src="' + f.url + '">';
      body += '<div>📄 ' + escapeHtml(f.name) + '（' + fmtSize(f.size) + '）</div>';
      if (f.url) body += '<a class="dl" href="' + f.url + '" download="' + escapeHtml(f.name) + '">⬇ 下载 / 保存</a>';
      else body += '<div class="hint">接收中…</div>';
    }
    wrap.innerHTML = '<div class="meta">' + meta + '</div>' + body;
    $('messages').appendChild(wrap);
    $('messages').scrollTop = $('messages').scrollHeight;
    return wrap;
  }
  function linkify(text) {
    var esc = escapeHtml(text);
    return esc.replace(/https?:\/\/[^\s&lt;&gt;"']+/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a> <button data-copy="' + u + '" class="copyBtn small ghost">复制链接</button>';
    });
  }

  // ----- UI: transfer progress -----
  function progressEl(id, label) {
    var d = document.createElement('div');
    d.innerHTML = '<div>' + escapeHtml(label) + ' <span class="pct">0%</span></div><div class="progress"><i></i></div>';
    $('transfers').appendChild(d);
    return { box: d, bar: d.querySelector('.progress>i'), pct: d.querySelector('.pct'),
      set: function (done, total) { var p = total ? Math.floor(done * 100 / total) : 100; this.bar.style.width = p + '%'; this.pct.textContent = p + '%（' + fmtSize(done) + ' / ' + fmtSize(total) + '）'; },
      done: function (t) { this.pct.textContent = t || '完成'; var self = this; setTimeout(function () { self.box.remove(); }, 4000); } };
  }

  // ----- PeerJS plumbing -----
  function setupConn(conn, opts) {
    opts = opts || {};
    conns[conn.peer] = conn;
    conn.on('open', function () {
      if (opts.registerOnOpen) conn.send({ kind: 'register', secret: secret, device: publicMe() });
      else conn.send({ kind: 'hello', device: publicMe() });
    });
    conn.on('data', function (data) { onData(conn, data); });
    conn.on('close', function () { onConnClose(conn); });
    conn.on('error', function () { /* surfaced via peer error */ });
    return conn;
  }
  function onConnClose(conn) {
    var did = connDevice[conn.peer];
    delete conns[conn.peer];
    delete connDevice[conn.peer];
    if (isHost && did && did !== deviceId) {
      // Host roster: trusted guests stay listed (greyed/offline); temp guests vanish.
      if (getHostTrustedGuests()[did] && roster[did]) roster[did].online = false;
      else delete roster[did];
      hostBroadcastRoster();
      renderRoster();
    }
    if (!isHost && conn.peer === currentHostPeerId) {
      setStatus('对方已关闭页面，连接已断开。对方重新打开页面后，信任设备可直接重连，临时配对需重新扫码。');
    }
  }
  function ensureConn(peerId) {
    if (!peerId || peerId === me.peerId) return null;
    var c = conns[peerId];
    if (c) return c; // open or still connecting; senders await open via waitOpen
    c = peer.connect(peerId, { reliable: true });
    setupConn(c);
    return c;
  }
  function waitOpen(conn) {
    return new Promise(function (res, rej) {
      if (conn.open) return res();
      var to = setTimeout(function () { rej(new Error('连接超时')); }, 20000);
      conn.on('open', function () { clearTimeout(to); res(); });
    });
  }

  function onData(conn, data) {
    if (data instanceof ArrayBuffer || (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) || (typeof Blob !== 'undefined' && data instanceof Blob)) {
      handleChunk(conn, data); return;
    }
    if (!data || typeof data !== 'object' || !data.kind) return;
    switch (data.kind) {
      case 'register': if (isHost) hostHandleRegister(conn, data); break;
      case 'roster': applyRoster(data.devices); break;
      case 'hello':
        if (data.device) { connDevice[conn.peer] = data.device.deviceId; if (!roster[data.device.deviceId]) { roster[data.device.deviceId] = data.device; renderRoster(); } }
        break;
      case 'device-update':
        if (data.device) { roster[data.device.deviceId] = data.device; connDevice[conn.peer] = data.device.deviceId; renderRoster(); if (isHost) hostBroadcastRoster(); }
        break;
      case 'text': receiveText(data); break;
      case 'file-meta': receiveFileMeta(conn, data); break;
      case 'file-end': finishFile(conn, data); break;
      case 'file-cancel': cancelRecv(conn); break;
    }
  }

  // ----- Host: roster authority -----
  function hostHandleRegister(conn, data) {
    var okSecret = data.secret === secret || (typeof data.secret === 'string' && data.secret.indexOf('manual:') === 0);
    if (!okSecret) { try { conn.send({ kind: 'text', msgId: 'sys-' + Date.now(), text: '⚠️ 配对密钥不正确，未能加入。', from: publicMe(), ts: Date.now() }); } catch (e) {} return; }
    var d = data.device; if (!d || !d.deviceId) return;
    d.peerId = conn.peer;
    d.online = true;
    roster[d.deviceId] = d;
    connDevice[conn.peer] = d.deviceId;
    hostBroadcastRoster();
    renderRoster();
  }
  function hostBroadcastRoster() {
    if (!isHost) return;
    var devices = Object.keys(roster).map(function (k) { return roster[k]; });
    Object.keys(conns).forEach(function (pid) { var c = conns[pid]; if (c.open) { try { c.send({ kind: 'roster', devices: devices }); } catch (e) {} } });
  }
  function applyRoster(devices) {
    var next = {};
    (devices || []).forEach(function (d) { next[d.deviceId] = d; });
    if (!next[deviceId]) next[deviceId] = publicMe();
    roster = next;
    Object.keys(roster).forEach(function (id) { if (roster[id].peerId) connDevice[roster[id].peerId] = id; });
    renderRoster();
    // Mesh: proactively connect to other ONLINE members so direct sends are instant.
    Object.keys(roster).forEach(function (id) { if (id !== deviceId && roster[id].online !== false) ensureConn(roster[id].peerId); });
    // If we are a guest, the first roster means the auto-reconnect / join worked.
    if (!isHost && autoProbe) { autoProbeSuccess(); }
    if (!isHost && guestInfo) updateTrustBannerLabel();
  }

  // ----- Text -----
  function receiveText(data) {
    if (seen[data.msgId]) return; seen[data.msgId] = 1;
    addMsg({ text: data.text, from: data.from, ts: data.ts, mine: data.from && data.from.deviceId === deviceId });
  }
  function targetConns(target) {
    var out = [];
    if (target === 'ALL') {
      Object.keys(roster).forEach(function (id) { if (id !== deviceId && roster[id].online !== false) { var c = ensureConn(roster[id].peerId); if (c) out.push(c); } });
    } else if (roster[target] && roster[target].online !== false) {
      var c2 = ensureConn(roster[target].peerId); if (c2) out.push(c2);
    }
    return out;
  }
  async function sendText() {
    var text = $('textInput').value.trim();
    if (!text) return;
    if (!room) { alert('页面还在准备连接，稍等一秒再发'); return; }
    var payload = { kind: 'text', msgId: 'm-' + Date.now() + '-' + randomCode(4, 'abcdefghijklmnopqrstuvwxyz0123456789'), text: text, from: publicMe(), ts: Date.now() };
    seen[payload.msgId] = 1;
    addMsg({ text: text, from: me, ts: payload.ts, mine: true });
    $('textInput').value = '';
    var list = targetConns($('targetSel').value);
    if (!list.length) setStatus('暂时没有其他在线设备（对方需要打开页面并加入）');
    for (var i = 0; i < list.length; i++) { try { await waitOpen(list[i]); list[i].send(payload); } catch (e) { setStatus('有一台设备暂时连不上（需同时在线）'); } }
  }

  // ----- Files: chunked send with backpressure (no size/type limits) -----
  function sendFilesToConn(conn, file, targetLabel) {
    var run = async function () {
      await waitOpen(conn);
      var transferId = 't-' + Date.now() + '-' + randomCode(5, 'abcdefghijklmnopqrstuvwxyz0123456789');
      conn.send({ kind: 'file-meta', transferId: transferId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', from: publicMe(), ts: Date.now() });
      var ui = progressEl(transferId, '发送 ' + file.name + ' → ' + targetLabel);
      var plan = planChunks(file.size, CHUNK_SIZE);
      var sentBytes = 0;
      var dc = conn.dataChannel;
      for (var i = 0; i < plan.length; i++) {
        while (dc && dc.bufferedAmount > 4 * 1024 * 1024) { await new Promise(function (r) { setTimeout(r, 40); }); }
        var buf = await file.slice(plan[i].start, plan[i].end).arrayBuffer(); // one chunk at a time, never the whole file
        conn.send(buf);
        sentBytes += (plan[i].end - plan[i].start);
        if (i % 16 === 0 || i === plan.length - 1) ui.set(sentBytes, file.size);
      }
      while (dc && dc.bufferedAmount > 0) { await new Promise(function (r) { setTimeout(r, 40); }); }
      conn.send({ kind: 'file-end', transferId: transferId });
      ui.set(file.size, file.size); ui.done('已发送 ✔');
    };
    var prev = sendQueues[conn.peer] || Promise.resolve();
    sendQueues[conn.peer] = prev.then(run, run);
    return sendQueues[conn.peer];
  }
  async function sendFiles(files) {
    if (!room) { alert('页面还在准备连接，稍等一秒再发'); return; }
    var target = $('targetSel').value;
    var list = targetConns(target);
    if (!list.length) { alert('还没有其他在线设备，等对方打开 Kiwi 页面并加入后再发（需要同时在线）'); return; }
    for (var c = 0; c < list.length; c++) {
      var label = (connDevice[list[c].peer] && roster[connDevice[list[c].peer]] && roster[connDevice[list[c].peer]].name) || list[c].peer;
      for (var f = 0; f < files.length; f++) { sendFilesToConn(list[c], files[f], target === 'ALL' ? '所有设备' : label); }
    }
    for (var k = 0; k < files.length; k++) {
      addMsg({ from: me, mine: true, ts: Date.now(), file: { name: files[k].name, size: files[k].size, isImage: (files[k].type || '').indexOf('image/') === 0, url: URL.createObjectURL(files[k]) } });
    }
  }

  // ----- Files: receive -----
  function receiveFileMeta(conn, data) {
    if (seen[data.transferId]) return; seen[data.transferId] = 1;
    var ui = progressEl(data.transferId, '接收 ' + data.name + ' ← ' + (data.from ? data.from.name : ''));
    recvState[conn.peer] = { meta: data, chunks: [], received: 0, ui: ui };
  }
  async function handleChunk(conn, data) {
    var st = recvState[conn.peer]; if (!st) return;
    var u8;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (data instanceof Uint8Array) u8 = data;
    else if (typeof Blob !== 'undefined' && data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
    else return;
    st.chunks.push(u8); st.received += u8.length;
    st.ui.set(st.received, st.meta.size);
  }
  function finishFile(conn, data) {
    var st = recvState[conn.peer]; if (!st) return;
    delete recvState[conn.peer];
    var bytes = reassembleChunks(st.chunks);
    var blob = new Blob([bytes], { type: st.meta.mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    st.ui.done('已接收 ✔');
    addMsg({ from: st.meta.from, ts: st.meta.ts, mine: false, file: { name: st.meta.name, size: st.meta.size, isImage: (st.meta.mime || '').indexOf('image/') === 0, url: url } });
  }
  function cancelRecv(conn) { var st = recvState[conn.peer]; if (st) { st.ui.done('对方已取消'); delete recvState[conn.peer]; } }

  // ----- Session lifecycle -----
  function enterRoomUI() {
    if (isHost) {
      $('hostHero').classList.remove('hidden');
      $('joinBanner').classList.add('hidden');
      renderHero();
      renderTrustedCard();
    } else {
      $('hostHero').classList.add('hidden');
      $('trustedCard').classList.add('hidden');
      showJoinBanner();
    }
  }
  function renderHero() {
    if (!isHost || !room) return;
    var qr = qrcode(0, 'M'); qr.addData(joinUrl()); qr.make();
    $('heroQrBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 10, scalable: true });
    $('heroRoomCode').textContent = room;
    $('heroJoinUrl').textContent = joinUrl();
    $('heroSessionType').textContent = rememberChannel ? '已记住连接（信任）' : '临时会话（关页面即失效）';
    $('chkRememberChannel').checked = rememberChannel;
  }
  function becomeHost(channel, persisted) {
    isHost = true; guestInfo = null; currentHostPeerId = null;
    rememberChannel = !!persisted;
    if (channel && channel.room) { room = channel.room; secret = channel.secret; }
    else { room = randomCode(8); secret = randomCode(16, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'); }
    if (rememberChannel) setHostChannel({ room: room, secret: secret });
    sessionStorage.setItem('kiwi_temp_host', JSON.stringify({ room: room, secret: secret }));
    // Preload trusted guests as offline roster entries (they grey in when away).
    roster = {}; roster[deviceId] = publicMe();
    var tg = getHostTrustedGuests();
    Object.keys(tg).forEach(function (id) { var d = tg[id]; d.online = false; roster[id] = d; });
    startPeer(hostPeerIdForRoom(room), null);
  }
  function joinRoom(info, opts) {
    opts = opts || {};
    cancelAutoProbe();
    isHost = false; guestInfo = info;
    room = info.room; secret = info.secret; currentHostPeerId = info.hostPeerId;
    startPeer(null, info.hostPeerId);
    if (opts.viaTrust) setStatus('正在重连信任设备（连接 ' + room + '）…');
    else setStatus('正在连接 ' + room + '…');
  }
  function startPeer(fixedId, hostPeerId) {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    conns = {}; connDevice = {};
    if (!isHost) { roster = {}; roster[deviceId] = publicMe(); }
    peer = fixedId ? new Peer(fixedId, PEER_OPTS) : new Peer(PEER_OPTS);
    peer.on('open', function (id) {
      me.peerId = id;
      if (roster[deviceId]) roster[deviceId].peerId = id; else roster[deviceId] = publicMe();
      enterRoomUI(); renderSelf(); renderRoster();
      if (isHost) setStatus(rememberChannel ? '已记住连接已打开，扫码过的信任设备可直接重连' : '临时连接已打开，等其他设备扫码加入');
      else {
        setStatus('正在连接主机…');
        var c = peer.connect(hostPeerId, { reliable: true });
        setupConn(c, { registerOnOpen: true });
      }
    });
    peer.on('connection', function (conn) { setupConn(conn); });
    peer.on('error', function (err) {
      if (err.type === 'unavailable-id') {
        if (isHost) { alert('这个连接码已被占用（可能你在另一个标签页/窗口也打开了 Kiwi 并记住了同一连接）。请关掉多余的页面，或点「结束会话并换新二维码」。'); setStatus('连接码被占用：可能另一个页面正用同一连接当主机'); }
      } else if (err.type === 'peer-unavailable') {
        if (autoProbe) { autoProbeFail(); }
        else if (!isHost) setStatus('对方未打开页面：主机设备需要先打开 Kiwi 页面，这个连接才能连上。');
        else setStatus('有一台离线设备暂时联系不上');
      } else {
        setStatus('连接问题：' + err.type + '（检查网络后刷新页面重试）');
      }
    });
    peer.on('disconnected', function () { setStatus('与信令服务器断开，正在重连…'); try { peer.reconnect(); } catch (e) {} });
  }
  function regenerate() {
    var keepRemember = rememberChannel;
    sessionStorage.removeItem('kiwi_temp_host');
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    seen = {}; recvState = {}; sendQueues = {};
    becomeHost(null, keepRemember);
    setStatus('已结束旧会话，生成了新二维码。之前扫过旧码的临时设备需要重新扫码。');
  }
  function leaveToHome() {
    sessionStorage.setItem('kiwi_skip_autoprobe', '1'); // don't instantly re-join the room we just left
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) {}
    location.reload();
  }

  // ----- Guest trust banner -----
  function hostLabelForCurrentRoom() {
    if (!guestInfo) return '';
    var saved = getTrustedHosts().filter(function (h) { return h.room === guestInfo.room; })[0];
    var hostDev = null;
    Object.keys(roster).forEach(function (id) { if (roster[id].peerId === currentHostPeerId) hostDev = roster[id]; });
    if (hostDev && hostDev.name) return hostDev.name + '（连接 ' + guestInfo.room + '）';
    if (saved && saved.hostLabel) return saved.hostLabel;
    return '连接 ' + guestInfo.room;
  }
  function showJoinBanner() {
    $('joinBanner').classList.remove('hidden');
    $('joinBannerText').textContent = '正在连接到：' + hostLabelForCurrentRoom(); // applyRoster flips this to 你已连接到 once the host answers
    $('chkTrustHost').checked = guestInfo ? isTrustedHost(guestInfo.room) : false;
    $('btnForgetHost').classList.toggle('hidden', !(guestInfo && isTrustedHost(guestInfo.room)));
  }
  function updateTrustBannerLabel() {
    if (!guestInfo) return;
    $('joinBannerText').textContent = '你已连接到：' + hostLabelForCurrentRoom();
    if ($('chkTrustHost').checked) {
      // Keep the saved label fresh with the host's current device name.
      upsertTrustedHost(guestInfo, hostLabelForCurrentRoom());
    }
  }

  // ----- Auto-reconnect probe to the most recent trusted host -----
  function tryAutoReconnect() {
    var list = getTrustedHosts();
    if (!list.length) { becomeHostFromStorage(); return; }
    var h = list[0];
    // joinRoom() cancels any existing probe first, so arm the probe AFTER calling it
    // (peer events are async, so the probe is in place before any success/failure lands).
    joinRoom({ room: h.room, secret: h.secret, hostPeerId: h.hostPeerId, viaQR: true }, { viaTrust: true });
    autoProbe = { room: h.room, timer: setTimeout(autoProbeFail, 9000) };
    $('reconnectBar').classList.remove('hidden');
    $('reconnectText').textContent = '正在尝试自动重连已信任的设备「' + (h.hostLabel || h.room) + '」，连不上会自动打开你的二维码…';
  }
  function cancelAutoProbe() { if (autoProbe) { clearTimeout(autoProbe.timer); autoProbe = null; } $('reconnectBar').classList.add('hidden'); }
  function autoProbeSuccess() {
    cancelAutoProbe();
    setStatus('已自动重连到信任设备，不用扫码 ✔');
  }
  function autoProbeFail() {
    var failedRoom = autoProbe ? autoProbe.room : null;
    cancelAutoProbe();
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    guestInfo = null;
    becomeHostFromStorage();
    var off = {}; if (failedRoom) off[failedRoom] = true;
    renderTrustedCard(off);
    setStatus('信任设备未打开页面，已打开你自己的二维码；对方打开页面后点「重连」即可');
  }
  function becomeHostFromStorage() {
    var pinned = getHostChannel();
    if (pinned && pinned.room) { becomeHost(pinned, true); return; }
    var temp = null;
    try { temp = JSON.parse(sessionStorage.getItem('kiwi_temp_host') || 'null'); } catch (e) {}
    if (temp && temp.room) { becomeHost(temp, false); return; }
    becomeHost(null, false);
  }

  // ----- QR modal (invite more devices into the current room) -----
  function showQR() {
    if (!room) return;
    var qr = qrcode(0, 'M'); qr.addData(joinUrl()); qr.make();
    $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 12, scalable: true });
    $('qrRoomCode').textContent = room;
    $('qrModal').classList.remove('hidden');
  }

  // ----- In-page camera scan (secondary join path) -----
  var scanStream = null, scanRAF = null;
  function startScan() {
    $('scanModal').classList.remove('hidden');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('scanTip').textContent = '此设备/浏览器不支持摄像头扫码，请用手动输入连接码加入（主机需在线）。'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      scanStream = stream;
      var v = $('scanVideo'); v.srcObject = stream; v.play();
      $('scanTip').textContent = '对准另一台设备上的 Kiwi 二维码…';
      var canvas = $('scanCanvas'), ctx = canvas.getContext('2d');
      var tick = function () {
        if (!scanStream) return;
        if (v.readyState === v.HAVE_ENOUGH_DATA) {
          canvas.width = v.videoWidth; canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = jsQR(img.data, img.width, img.height);
          if (code) {
            var info = parseRoomPayload(code.data);
            if (info) { stopScan(); joinRoom(info); return; }
            $('scanTip').textContent = '识别到二维码，但不是 Kiwi 连接码，继续扫描…';
          }
        }
        scanRAF = requestAnimationFrame(tick);
      };
      tick();
    }).catch(function () { $('scanTip').textContent = '摄像头打开失败（需要 HTTPS 环境和摄像头权限）。可用手动输入连接码加入。'; });
  }
  function stopScan() {
    if (scanRAF) cancelAnimationFrame(scanRAF); scanRAF = null;
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    $('scanModal').classList.add('hidden');
  }

  // ----- wire UI -----
  $('btnAddDevice').onclick = showQR;
  $('btnCloseQR').onclick = function () { $('qrModal').classList.add('hidden'); };
  $('btnScan').onclick = startScan;
  $('btnCloseScan').onclick = stopScan;
  $('btnManual').onclick = function () {
    var info = parseRoomPayload($('manualCode').value);
    if (!info) { alert('连接码格式不对'); return; }
    if (confirm('加入别的设备会离开当前连接，确定加入 ' + info.room + ' 吗？')) joinRoom(info);
  };
  $('btnRoom').onclick = function () { $('messages').scrollTo({ top: 0, behavior: 'smooth' }); };
  $('btnRegen').onclick = function () { if (confirm('结束当前会话并换新二维码？之前扫过旧码的临时设备将需要重新扫码。')) regenerate(); };
  $('btnSkipReconnect').onclick = function () { if (autoProbe) autoProbeFail(); };
  $('btnCopyJoinUrl').onclick = function () {
    if (navigator.clipboard) navigator.clipboard.writeText(joinUrl());
    $('btnCopyJoinUrl').textContent = '已复制';
    setTimeout(function () { $('btnCopyJoinUrl').textContent = '复制链接'; }, 1500);
  };
  $('chkRememberChannel').onchange = function () {
    rememberChannel = this.checked;
    if (rememberChannel) {
      setHostChannel({ room: room, secret: secret });
      setStatus('已记住此连接：以后打开本页就是同一个二维码');
    } else {
      setHostChannel(null);
      setStatus('已改为临时连接：关掉页面后，下次打开会换新二维码');
    }
    renderHero();
  };
  $('chkTrustHost').onchange = function () {
    if (!guestInfo) return;
    if (this.checked) {
      upsertTrustedHost(guestInfo, hostLabelForCurrentRoom());
      $('btnForgetHost').classList.remove('hidden');
      setStatus('已信任此设备：以后打开本页可自动/一键重连，不用再扫码（对方页面需打开）');
    } else {
      removeTrustedHost(guestInfo.room);
      $('btnForgetHost').classList.add('hidden');
      setStatus('已取消信任：下次连接需要重新扫码');
    }
  };
  $('btnForgetHost').onclick = function () {
    if (!guestInfo) return;
    removeTrustedHost(guestInfo.room);
    $('chkTrustHost').checked = false;
    $('btnForgetHost').classList.add('hidden');
    setStatus('已忘记此设备，下次连接需要重新扫码');
  };
  $('btnSaveName').onclick = function () {
    var n = $('devName').value.trim(); if (!n) return;
    me.name = n; localStorage.setItem('kiwi_deviceName', n);
    roster[deviceId] = publicMe(); renderSelf(); renderRoster();
    Object.keys(conns).forEach(function (pid) { var c = conns[pid]; if (c.open) { try { c.send({ kind: 'device-update', device: publicMe() }); } catch (e) {} } });
    if (isHost) hostBroadcastRoster();
  };
  $('btnSend').onclick = sendText;
  $('textInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });
  $('fileInput').addEventListener('change', function () { if (this.files.length) sendFiles(this.files); this.value = ''; });

  // ----- drag & drop files onto the stage / input bar -----
  ['stage', 'inputBar'].forEach(function (id) {
    var el = $(id); if (!el) return;
    el.addEventListener('dragover', function (e) { e.preventDefault(); $('stage').classList.add('dragOver'); });
    el.addEventListener('dragleave', function () { $('stage').classList.remove('dragOver'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault(); $('stage').classList.remove('dragOver');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
    });
  });

  // ----- paste anything: files / images from clipboard (text paste stays native) -----
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) files.push(f); }
    }
    if (!files.length) return; // plain text: let the default paste into the field happen
    e.preventDefault();
    var renamed = files.map(function (f, idx) {
      if (f.name && f.name !== 'image.png' && f.name !== 'blob') return f;
      var ext = ((f.type || '').split('/')[1] || 'bin').replace('jpeg', 'jpg');
      var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; }
      var nm = '粘贴文件-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + (files.length > 1 ? '-' + (idx + 1) : '') + '.' + ext;
      try { return new File([f], nm, { type: f.type }); } catch (err) { return f; }
    });
    sendFiles(renamed);
  });

  // ----- boot -----
  renderSelf(); renderRoster();
  var hashInfo = parseJoinFromHash(location.hash);
  if (hashInfo) {
    // Arrived by scanning the QR (system camera opened this page URL).
    joinRoom(hashInfo);
    setStatus('通过扫码打开，正在连接 ' + hashInfo.room + '…');
  } else if (sessionStorage.getItem('kiwi_skip_autoprobe') === '1') {
    sessionStorage.removeItem('kiwi_skip_autoprobe');
    becomeHostFromStorage();
    renderTrustedCard();
  } else if (getTrustedHosts().length) {
    tryAutoReconnect();
  } else {
    becomeHostFromStorage();
  }
}
