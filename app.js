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

function detectPlatform(ua, maxTouchPoints) {
  ua = ua || '';
  if (/iPhone/i.test(ua)) return { platform: 'iPhone', icon: '📱' };
  if (/iPad/i.test(ua)) return { platform: 'iPad', icon: '📱' };
  if (/Macintosh|Mac OS/i.test(ua) && (maxTouchPoints || 0) > 1) return { platform: 'iPad', icon: '📱' }; // iPadOS pretends to be a Mac
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
  // ICE：STUN 负责打洞，TURN 负责中转。具体列表在 ice-config.js 里，也可以在 ice-test.html 里配置（存在本机）。
  // 注意：旧的 turn:openrelay.metered.ca + openrelayproject 公开账号已被官方下线，
  //       该域名现在解析到 192.0.2.1（测试用保留地址），等于根本没有中转。
  var DEFAULT_ICE = [
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.hitv.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];
  function iceServers() {
    try {
      if (typeof window.kiwiIceServers === 'function') {
        var list = window.kiwiIceServers();
        if (list && list.length) return list;
      }
    } catch (e) {}
    return DEFAULT_ICE;
  }
  var PEER_OPTS = {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
    config: { iceServers: iceServers() }
  };
  var signalDrops = 0; // 信令服务器连续断线次数

  // ----- persistent identity (survives everything; it is just "who am I") -----
  var deviceId = localStorage.getItem('kiwi_deviceId');
  if (!deviceId) { deviceId = 'dev-' + randomCode(10, 'abcdefghijklmnopqrstuvwxyz0123456789'); localStorage.setItem('kiwi_deviceId', deviceId); }
  var plat = detectPlatform(navigator.userAgent, navigator.maxTouchPoints || 0);
  var myName = localStorage.getItem('kiwi_deviceName') || (plat.platform + '-' + deviceId.slice(-4));
  var me = { deviceId: deviceId, name: myName, platform: plat.platform, icon: plat.icon, color: colorFromId(deviceId), peerId: null, avatarImg: null };
  try { var avPref = JSON.parse(localStorage.getItem('kiwi_avatar') || 'null'); if (avPref) { if (avPref.emoji) me.icon = avPref.emoji; if (avPref.color) me.color = avPref.color; me.avatarImg = avPref.img || null; } } catch (e) {}
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
  var recvTransfers = {};  // transferId -> incoming partial (survives conn drops, enables resume)
  var recvByPeer = {};     // peerId -> transferId currently streaming in on that conn
  var outTransfers = {};   // transferId -> outgoing file record (queued / sending / paused)
  var resumeWaiters = {};  // transferId -> resolve fn waiting for a file-resume-answer
  var outbox = [];         // undelivered texts [{msgId, text, ts, target, pendingFor, payload, el}]
  var sendQueues = {};     // peerId -> promise chain (one file at a time per conn)
  var autoProbe = null;    // {room, timer} while auto-reconnecting to a trusted host
  var guestAnnounced = false; // true once the status line has flipped to 已连接 for this join
  var guestStallTimer = null;
  var guestDialTries = 0; // automatic re-dials of the host during one join
  var hostReviveTries = 0; // automatic re-dials after the host connection drops mid-session
  var guestInfo = null;    // join payload of the room we are a guest in
  var lastOfflineRooms = {}; // room -> true, remembered so the trusted card keeps its 离线 badge across re-renders

  function setStatus(t) { $('connStatus').textContent = t; }
  function publicMe() { return { deviceId: me.deviceId, name: me.name, platform: me.platform, icon: me.icon, color: me.color, peerId: me.peerId, online: true, avatarImg: me.avatarImg || null }; }

  // ----- 中转（TURN）自检 -----
  // 手机流量基本都在运营商 CGNAT 后面，双方常常无法直连，只能靠 TURN 转发。
  // 先收集一次 ICE 候选，确认本机到底能不能拿到 relay 候选，连不上时才能给出准确提示。
  var relayState = { checked: false, hasRelay: false, turnCount: 0 };
  function probeRelay(cb) {
    cb = cb || function () {};
    var servers = PEER_OPTS.config.iceServers || [];
    relayState.turnCount = servers.filter(function (s) { return /^turns?:/i.test(String(s.urls)); }).length;
    if (relayState.checked) return cb(relayState);
    if (typeof window.RTCPeerConnection === 'undefined') { relayState.checked = true; return cb(relayState); }
    relayState.checked = true;
    var pc = null, finished = false;
    function finish(hasRelay) {
      if (finished) return;
      finished = true;
      relayState.hasRelay = !!hasRelay;
      try { if (pc) pc.close(); } catch (e) {}
      cb(relayState);
    }
    try {
      pc = new RTCPeerConnection({ iceServers: servers });
      pc.createDataChannel('kiwi-relay-probe');
      pc.onicecandidate = function (e) {
        if (!e.candidate) return finish(relayState.hasRelay);
        if (/(^|\s)typ relay(\s|$)/.test(' ' + e.candidate.candidate + ' ')) finish(true);
      };
      pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).catch(function () { finish(false); });
      setTimeout(function () { finish(relayState.hasRelay); }, 6000);
    } catch (e) { finish(false); }
  }
  // ----- 数据通道：WebRTC 直连优先，打洞失败自动切到「运营商中转」-----
  // Link 把 PeerJS 的 DataConnection 和 relay.js 的中转通道包成同一个对象，
  // app 其余逻辑只认 link.open / link.send / link.on / link.dataChannel / link.peerConnection，
  // 所以文字、文件分片、名单广播都不需要区分走的是哪条路。
  var links = {};
  var relayClient = null;
  var relayAlias = null;   // 主机额外监听「手动连接码」的中转频道（manual:ROOM）
  var relayStatus = 'off';   // off | connecting | up | unsupported
  var relayOnly = false;     // 信令服务器完全连不上时，整条会话只走中转
  var forceRelay = /[?&]relay=1(&|$)/.test(location.search); // 诊断用：?relay=1 强制走中转
  var routeLabel = '';
  var peerOpenTimer = null;

  function setRoute(kind) {
    routeLabel = kind === 'relay' ? '运营商中转' : '直连';
    if (!isHost && guestInfo && guestAnnounced) setStatus('已连接 ✔（' + routeLabel + '）');
  }

  function Link(peerId) {
    var self = this;
    this.peer = peerId;
    this.open = false;
    this.active = null;      // 'p2p' | 'relay'
    this.usedRelay = false;  // 一旦开始用中转就不再切回直连，避免文件分片乱序
    this.p2p = null;
    this.relayCh = null;
    this.bound = false;
    this.closedByUser = false;
    this.relayTimer = null;
    this.handlers = { open: [], data: [], close: [], error: [] };
    var dc = {};
    Object.defineProperty(dc, 'bufferedAmount', { get: function () {
      if (self.active === 'p2p' && self.p2p && self.p2p.dataChannel) return self.p2p.dataChannel.bufferedAmount || 0;
      return self.relayCh && !self.relayCh.closed ? self.relayCh.pendingBytes() : 0;
    } });
    this._dc = dc;
  }
  Link.prototype.on = function (ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); };
  Link.prototype.emit = function (ev, a) { var l = this.handlers[ev] || []; for (var i = 0; i < l.length; i++) { try { l[i](a); } catch (e) {} } };
  Object.defineProperty(Link.prototype, 'peerConnection', { get: function () { return this.p2p ? this.p2p.peerConnection : null; } });
  Object.defineProperty(Link.prototype, 'dataChannel', { get: function () { return this._dc; } });
  Object.defineProperty(Link.prototype, 'transport', { get: function () { return this.active; } });

  Link.prototype.attachP2P = function (dc) {
    var self = this;
    if (!dc || this.p2p === dc) return;
    this.p2p = dc;
    dc.on('open', function () { self.markUp('p2p'); });
    dc.on('data', function (d) { self.emit('data', d); });
    dc.on('close', function () { if (self.p2p === dc) { self.p2p = null; self.checkDown(); } });
    dc.on('error', function (e) { self.emit('error', e); });
    if (dc.open) this.markUp('p2p');
  };
  Link.prototype.attachRelay = function (ch) {
    var self = this;
    if (!ch || this.relayCh === ch) return;
    this.relayCh = ch;
    ch.on('open', function () { self.markUp('relay'); });
    ch.on('data', function (d) { self.emit('data', d); });
    ch.on('close', function () { if (self.relayCh === ch) { self.relayCh = null; self.checkDown(); } });
    ch.on('error', function () {});
    if (ch.open) this.markUp('relay');
  };
  Link.prototype.markUp = function (kind) {
    var was = this.open;
    if (!this.active) this.active = kind;
    else if (this.active === 'relay' && kind === 'p2p' && !this.usedRelay) this.active = 'p2p';
    this.open = true;
    if (!was) { setRoute(this.active); this.emit('open'); }
  };
  Link.prototype.checkDown = function () {
    if (this.p2p || (this.relayCh && !this.relayCh.closed)) return;
    if (!this.open) return;
    this.open = false;
    this.active = null;
    this.emit('close');
  };
  // 发送：已经在用中转就一直用中转（保证分片顺序），否则优先直连。
  Link.prototype.send = function (data) {
    if (this.active === 'relay' && this.relayCh && !this.relayCh.closed) { this.relayCh.send(data); return; }
    if (this.p2p && this.p2p.open) { this.p2p.send(data); return; }
    if (this.relayCh && !this.relayCh.closed) { this.usedRelay = true; this.relayCh.send(data); return; }
    throw new Error('通道已关闭');
  };
  Link.prototype.close = function () {
    this.closedByUser = true;
    clearTimeout(this.relayTimer);
    var p2p = this.p2p, ch = this.relayCh;
    this.p2p = null; this.relayCh = null;
    try { if (p2p) p2p.close(); } catch (e) {}
    try { if (ch) ch.close(); } catch (e) {}
    this.checkDown();
  };
  Link.prototype.startRelay = function (delay) {
    var self = this;
    if (this.relayCh && !this.relayCh.closed) return;
    clearTimeout(this.relayTimer);
    this.relayTimer = setTimeout(function () {
      if (self.closedByUser) return;
      if (self.open && self.active === 'p2p' && !forceRelay) return; // 直连已经好了，不用中转
      var r = ensureRelay();
      if (!r) { if (!self.closedByUser && (!self.open || forceRelay)) self.startRelay(1500); return; }
      if (!self.relayCh || self.relayCh.closed) self.attachRelay(r.channel(self.peer));
    }, delay == null ? 0 : delay);
  };

  function getLink(peerId) {
    var l = links[peerId];
    if (!l) { l = new Link(peerId); links[peerId] = l; }
    return l;
  }

  // ----- 中转客户端（公共 MQTT-over-WSS，AES-GCM 端到端加密，帧级确认 + 重传）-----
  function relaySelfId() {
    if (isHost && room) return hostPeerIdForRoom(room);
    if (me.peerId) return me.peerId;
    var v = sessionStorage.getItem('kiwi_relay_id');
    if (!v) { v = 'r-' + randomCode(12, 'abcdefghijklmnopqrstuvwxyz0123456789'); sessionStorage.setItem('kiwi_relay_id', v); }
    return v;
  }
  function makeRelayClient(sec, primary) {
    return new window.KiwiRelay({
      room: room, secret: sec, selfId: relaySelfId(),
      onStatus: function (s) { if (primary) relayStatus = s; },
      onPeer: function (peerId, ch) {
        var l = getLink(peerId);
        if (!l.bound) bindLink(l, {});
        l.attachRelay(ch);
      }
    });
  }
  function ensureRelay() {
    if (typeof window.KiwiRelay !== 'function' || !room || !secret) return null;
    var sid = relaySelfId();
    if (!relayClient || relayClient.selfId !== sid || relayClient.room !== room || relayClient.secret !== secret || relayClient.stopped) {
      if (relayClient) { try { relayClient.stop(); } catch (e) {} }
      relayClient = makeRelayClient(secret, true);
    }
    // 手动只输入房间码时，来宾用的是 manual:ROOM 派生密钥；主机必须额外订阅这条频道，
    // 否则信令服务器被运营商拦截时，手动连接码无法自动切到中转。
    if (isHost && secret.indexOf('manual:') !== 0) {
      var ms = 'manual:' + room;
      if (!relayAlias || relayAlias.selfId !== sid || relayAlias.room !== room || relayAlias.secret !== ms || relayAlias.stopped) {
        if (relayAlias) { try { relayAlias.stop(); } catch (e) {} }
        relayAlias = makeRelayClient(ms, false);
      }
    } else if (relayAlias) {
      try { relayAlias.stop(); } catch (e) {}
      relayAlias = null;
    }
    return relayClient;
  }
  function stopRelay() {
    if (relayClient) { try { relayClient.stop(); } catch (e) {} }
    if (relayAlias) { try { relayAlias.stop(); } catch (e) {} }
    relayClient = null;
    relayAlias = null;
    relayStatus = 'off';
  }

  // 统一拨号：先试 WebRTC 直连；delay 毫秒后直连还没握手成功就同时接上中转通道，谁先通就用谁。
  function dial(peerId, opts) {
    opts = opts || {};
    var l = getLink(peerId);
    l.closedByUser = false;
    if (!l.bound) bindLink(l, opts);
    conns[peerId] = l;
    if (!opts.noP2P && !relayOnly && !forceRelay && !l.open && !l.p2p && !/^r-/.test(peerId) && peer && !peer.destroyed) {
      try { l.attachP2P(peer.connect(peerId, { reliable: true })); } catch (e) {}
    }
    if (!opts.noRelay && !l.open) l.startRelay((forceRelay || opts.noP2P) ? 0 : (opts.relayDelay == null ? 2500 : opts.relayDelay));
    return l;
  }

  // 信令服务器（0.peerjs.com）被移动网络拦住时的兜底：整条会话只走中转，不再干等 PeerJS。
  function goRelayOnly() {
    if (relayOnly || isHost || me.peerId || !guestInfo || guestAnnounced) return;
    if (!ensureRelay()) return;
    relayOnly = true;
    clearTimeout(peerOpenTimer);
    me.peerId = relaySelfId();
    roster = {}; roster[deviceId] = publicMe();
    enterRoomUI(); renderSelf(); renderRoster();
    guestDialTries = 0;
    dialHost();
  }
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
  function avatarHtml(d, big) {
    var cls = 'avatar' + (big ? ' avatarBig' : '');
    if (d.avatarImg) return '<span class="' + cls + ' avatarImg"><img alt="" src="' + d.avatarImg + '"></span>';
    return '<span class="' + cls + '" style="background:' + (d.color || '#888') + '">' + (d.icon || '🔌') + '</span>';
  }
  function renderSelf() {
    $('selfAvatar').innerHTML = avatarHtml(me, true);
    $('selfNameText').innerHTML = '<b>' + escapeHtml(me.name) + '</b><span class="selfPlat">' + escapeHtml(me.platform) + ' · 本机</span>';
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
      var html = '<span class="dot' + (off ? '' : ' on') + '"></span>' + avatarHtml(d) + '<b>' + escapeHtml(d.name) + '</b><span>' + escapeHtml(d.platform) + '</span>';
      if (id === deviceId) html += '<span class="selfTag">本机</span>';
      if (off) html += '<span class="offTag">离线</span>';
      if (isHost && id !== deviceId) {
        var trusted = !!trustedGuests[id];
        if (trusted) html += '<span class="trustTag">已信任</span>';
        html += '<button class="ghost small" data-trust-guest="' + escapeHtml(id) + '">' + (trusted ? '取消信任' : '信任此设备') + '</button>';
      }
      li.innerHTML = html;
      list.appendChild(li);
      if (id !== deviceId) {
        var op = document.createElement('option'); op.value = id; op.textContent = d.name + '（' + d.platform + (off ? ' · 离线' : '') + '）'; sel.appendChild(op);
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
      map[id] = { deviceId: d.deviceId, name: d.name, platform: d.platform, icon: d.icon, color: d.color, avatarImg: d.avatarImg || null };
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
      note: function (t) { this.pct.textContent = t; },
      phase: function (label, frac) { var p = Math.max(0, Math.min(100, Math.floor(frac * 100))); this.bar.style.width = p + '%'; this.pct.textContent = label + '… ' + p + '%'; },
      setFrac: function (frac, done, total, suffix) { var p = Math.floor(frac * 100); this.bar.style.width = p + '%'; this.pct.textContent = p + '%（' + fmtSize(done) + ' / ' + fmtSize(total) + (suffix ? ' · ' + suffix : '') + '）'; },
      done: function (t) { this.pct.textContent = t || '完成'; var self = this; setTimeout(function () { self.box.remove(); }, 4000); } };
  }

  // ----- PeerJS plumbing（Link 统一封装 直连 / 运营商中转 两种通道）-----
  function bindLink(link, opts) {
    opts = opts || {};
    link.bound = true;
    conns[link.peer] = link;
    link.on('open', function () {
      if (!link.open) return;
      try {
        if (opts.registerOnOpen) { hostReviveTries = 0; link.send({ kind: 'register', secret: secret, device: publicMe() }); }
        else link.send({ kind: 'hello', device: publicMe() });
      } catch (e) {}
      reportPath(link);
    });
    link.on('data', function (data) { onData(link, data); });
    link.on('close', function () { onConnClose(link); });
    link.on('error', function () { /* surfaced via peer error */ });
    return link;
  }
  function onConnClose(conn) {
    var did = connDevice[conn.peer];
    delete conns[conn.peer];
    delete connDevice[conn.peer];
    // 同一设备可能已经用新会话重新注册（旧通道要 75 秒后才会超时断开），此时不能删掉新记录。
    var reRegistered = false;
    if (isHost && did) Object.keys(connDevice).forEach(function (pid) { if (connDevice[pid] === did && conns[pid]) reRegistered = true; });
    if (isHost && did && did !== deviceId && !reRegistered) {
      // Host roster: trusted guests stay listed (greyed/offline); temp guests vanish.
      if (getHostTrustedGuests()[did] && roster[did]) roster[did].online = false;
      else delete roster[did];
      hostBroadcastRoster();
      renderRoster();
    }
    if (!isHost && conn.peer === currentHostPeerId) {
      setStatus('对方已关闭页面，连接已断开');
    }
    var rtid = recvByPeer[conn.peer];
    if (rtid) {
      var rst = recvTransfers[rtid];
      if (rst) rst.ui.note('已暂停（已收到 ' + fmtSize(rst.received) + '），对方回来后自动续传');
      delete recvByPeer[conn.peer];
    }
    reviveSoon(conn.peer);
  }
  // After a connection opens, check which route won (direct vs relay) and label the guest status
  // with it — the fastest way to see whether a carrier-network connection went through the relay.
  function reportPath(conn) {
    try {
      if (conn && conn.transport === 'relay') {
        if (!isHost && conn.peer === currentHostPeerId && guestAnnounced) setStatus('已连接 ✔（运营商中转）');
        return;
      }
      var pc = conn.peerConnection;
      if (!pc || !pc.getStats) return;
      setTimeout(function () {
        if (!conn.open) return;
        pc.getStats().then(function (stats) {
          var pair = null; var locals = {};
          stats.forEach(function (r) {
            if (r.type === 'local-candidate') locals[r.id] = r;
            if (r.type === 'candidate-pair' && r.nominated && (r.state === 'succeeded' || r.state === 'in-progress')) pair = pair || r;
          });
          if (pair && locals[pair.localCandidateId]) {
            var t = locals[pair.localCandidateId].candidateType;
            if (!isHost && conn.peer === currentHostPeerId && guestAnnounced) setStatus('已连接 ✔（' + (t === 'relay' ? '中转' : '直连') + '）');
          }
        }).catch(function () {});
      }, 2500);
    } catch (e) {}
  }
  // When a connection drops mid-session, do not sit idle until the user backgrounds/foregrounds
  // the page: quietly re-dial the host (guest side) and re-drive whatever was paused or queued.
  function reviveSoon(closedPeerId) {
    setTimeout(function () {
      if (!peer || peer.destroyed) return;
      if (!isHost && guestInfo && closedPeerId === currentHostPeerId && hostReviveTries < 8 && !conns[currentHostPeerId]) {
        hostReviveTries++;
        try { dial(currentHostPeerId, { registerOnOpen: true }); } catch (e) {}
      }
      flushAllPending();
    }, 4000);
  }
  function ensureConn(peerId) {
    if (!peerId || peerId === me.peerId) return null;
    var l = conns[peerId];
    if (l) return l; // open or still connecting; senders await open via waitOpen
    return dial(peerId, { relayDelay: 3000 });
  }
  function waitOpen(conn) {
    return new Promise(function (res, rej) {
      if (conn.open) return res();
      var to = setTimeout(function () { rej(new Error('连接超时')); }, 20000);
      conn.on('open', function () { clearTimeout(to); res(); });
      conn.on('close', function () { clearTimeout(to); rej(new Error('连接已关闭')); });
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
        if (data.device) { connDevice[conn.peer] = data.device.deviceId; if (!roster[data.device.deviceId]) { roster[data.device.deviceId] = data.device; renderRoster(); } flushForDevice(data.device.deviceId); }
        break;
      case 'device-update':
        if (data.device) { roster[data.device.deviceId] = data.device; connDevice[conn.peer] = data.device.deviceId; renderRoster(); if (isHost) hostBroadcastRoster(); }
        break;
      case 'text': receiveText(conn, data); break;
      case 'ack': handleAck(data); break;
      case 'file-meta': receiveFileMeta(conn, data); break;
      case 'file-end': finishFile(conn, data); break;
      case 'file-cancel': cancelRecv(conn); break;
      case 'file-resume-query': onResumeQuery(conn, data); break;
      case 'file-resume-answer': { var w = resumeWaiters[data.transferId]; if (w) { delete resumeWaiters[data.transferId]; w(data.receivedChunks); } break; }
      case 'file-resume-begin': onResumeBegin(conn, data); break;
    }
  }

  // ----- Host: roster authority -----
  function hostHandleRegister(conn, data) {
    var okSecret = data.secret === secret || (typeof data.secret === 'string' && data.secret === 'manual:' + room);
    if (!okSecret) { try { conn.send({ kind: 'text', msgId: 'sys-' + Date.now(), text: '⚠️ 配对密钥不正确，未能加入。', from: publicMe(), ts: Date.now() }); } catch (e) {} return; }
    var d = data.device; if (!d || !d.deviceId) return;
    d.peerId = conn.peer;
    d.online = true;
    roster[d.deviceId] = d;
    connDevice[conn.peer] = d.deviceId;
    hostBroadcastRoster();
    renderRoster();
    flushForDevice(d.deviceId);
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
    else if (!isHost && guestInfo && !guestAnnounced) { guestAnnounced = true; guestDialTries = 0; setStatus('已连接 ✔' + (routeLabel ? '（' + routeLabel + '）' : '')); }
    if (!isHost && guestInfo) updateTrustBannerLabel();
    Object.keys(roster).forEach(function (id) { if (id !== deviceId && roster[id].online !== false) flushForDevice(id); });
  }

  // ----- Text, with an outbox: undelivered texts wait and auto-send when the peer returns -----
  function receiveText(conn, data) {
    try { conn.send({ kind: 'ack', msgId: data.msgId, deviceId: deviceId }); } catch (e) {}
    if (seen[data.msgId]) return; seen[data.msgId] = 1;
    addMsg({ text: data.text, from: data.from, ts: data.ts, mine: data.from && data.from.deviceId === deviceId });
  }
  function saveOutbox() {
    try { localStorage.setItem('kiwi_outbox', JSON.stringify(outbox.map(function (it) { return { msgId: it.msgId, text: it.text, ts: it.ts, target: it.target, pendingFor: Object.keys(it.pendingFor) }; }))); } catch (e) {}
  }
  function renderOutboxTag(item) {
    if (!item.el) return;
    var tag = item.el.querySelector('.pendTag');
    if (!Object.keys(item.pendingFor).length) {
      if (tag) { tag.textContent = '已送达 ✔'; tag.classList.add('done'); setTimeout(function () { if (tag.parentNode) tag.remove(); }, 3000); }
      return;
    }
    if (!tag) { tag = document.createElement('div'); tag.className = 'pendTag'; item.el.appendChild(tag); }
    tag.classList.remove('done');
    tag.textContent = '⏳ 未送达，对方上线后自动发送';
  }
  function settleOutboxItem(item) {
    renderOutboxTag(item);
    if (!Object.keys(item.pendingFor).length) {
      outbox = outbox.filter(function (x) { return x !== item; });
      saveOutbox();
    }
  }
  function handleAck(data) {
    if (!data || !data.msgId || !data.deviceId) return;
    outbox.slice().forEach(function (item) {
      if (item.msgId === data.msgId && item.pendingFor[data.deviceId]) { delete item.pendingFor[data.deviceId]; settleOutboxItem(item); }
    });
  }
  function isDeviceConnOpen(id) {
    var d = roster[id]; if (!d || !d.peerId) return false;
    var c = conns[d.peerId]; return !!(c && c.open);
  }
  async function tryDeliverText(item, id) {
    if (!item.pendingFor[id]) return;
    var d = roster[id]; if (!d || d.online === false || !d.peerId) return;
    var conn = ensureConn(d.peerId); if (!conn) return;
    try {
      await waitOpen(conn);
      if (!item.pendingFor[id]) return;
      conn.send(item.payload);
      // Fallback: if no ack returns but the connection is clearly alive (peer on an older page version), count it delivered.
      setTimeout(function () { if (item.pendingFor[id] && isDeviceConnOpen(id)) { delete item.pendingFor[id]; settleOutboxItem(item); } }, 9000);
    } catch (e) { /* stays pending; retried when the device next appears */ }
  }
  function flushForDevice(id) {
    if (!id || id === deviceId) return;
    outbox.slice().forEach(function (item) { tryDeliverText(item, id); });
    Object.keys(outTransfers).forEach(function (tid) { var rec = outTransfers[tid]; if (rec.targetDeviceId === id && (rec.state === 'queued' || rec.state === 'paused')) driveOutTransfer(rec); });
  }
  function flushAllPending() { Object.keys(roster).forEach(function (id) { if (roster[id].online !== false) flushForDevice(id); }); }
  function restoreOutbox() {
    loadJSON('kiwi_outbox', []).forEach(function (s) {
      if (!s || !s.msgId || seen[s.msgId]) return;
      seen[s.msgId] = 1;
      var item = { msgId: s.msgId, text: s.text, ts: s.ts, target: s.target, pendingFor: {}, payload: { kind: 'text', msgId: s.msgId, text: s.text, from: publicMe(), ts: s.ts }, el: null };
      (s.pendingFor || []).forEach(function (id) { item.pendingFor[id] = true; });
      if (!Object.keys(item.pendingFor).length) return;
      item.el = addMsg({ text: s.text, from: me, ts: s.ts, mine: true });
      outbox.push(item);
      renderOutboxTag(item);
    });
  }
  async function sendText() {
    var text = $('textInput').value.trim();
    if (!text) return;
    if (!room) { alert('页面还在准备连接，稍等一秒再发'); return; }
    var target = $('targetSel').value;
    var payload = { kind: 'text', msgId: 'm-' + Date.now() + '-' + randomCode(4, 'abcdefghijklmnopqrstuvwxyz0123456789'), text: text, from: publicMe(), ts: Date.now() };
    seen[payload.msgId] = 1;
    var wrap = addMsg({ text: text, from: me, ts: payload.ts, mine: true });
    $('textInput').value = '';
    var recipients = [];
    if (target === 'ALL') { Object.keys(roster).forEach(function (id) { if (id !== deviceId) recipients.push(id); }); }
    else recipients = [target];
    if (!recipients.length) { setStatus('还没有其他设备：对方打开页面加入过一次后，即使它离线，你也可以先发，文字会存着等它上线'); return; }
    var item = { msgId: payload.msgId, text: text, ts: payload.ts, target: target, pendingFor: {}, payload: payload, el: wrap };
    recipients.forEach(function (id) { item.pendingFor[id] = true; });
    outbox.push(item); saveOutbox(); renderOutboxTag(item);
    recipients.forEach(function (id) { tryDeliverText(item, id); });
  }

  // ----- Files: chunked send with backpressure + resume (no size/type limits) -----
  function driveOutTransfer(rec) {
    if (rec.state === 'sending' || rec.state === 'done') return;
    var d = roster[rec.targetDeviceId];
    if (!d || d.online === false || !d.peerId) { rec.state = 'queued'; rec.ui.note('等待对方上线后自动发送'); return; }
    var conn = ensureConn(d.peerId);
    if (!conn) { rec.state = 'queued'; rec.ui.note('等待对方上线后自动发送'); return; }
    rec.state = 'sending';
    rec.driveId = (rec.driveId || 0) + 1;
    var myDrive = rec.driveId;
    var run = function () { return streamOutTransfer(rec, conn, myDrive); };
    var prev = sendQueues[conn.peer] || Promise.resolve();
    sendQueues[conn.peer] = prev.then(run, run);
  }
  function queryResume(rec, conn) {
    return new Promise(function (res) {
      var to = setTimeout(function () { delete resumeWaiters[rec.transferId]; res(-1); }, 6000);
      resumeWaiters[rec.transferId] = function (n) { clearTimeout(to); res(n); };
      try { conn.send({ kind: 'file-resume-query', transferId: rec.transferId, name: rec.file.name, size: rec.file.size }); }
      catch (e) { clearTimeout(to); delete resumeWaiters[rec.transferId]; res(-1); }
    });
  }
  function sendMeta(rec, conn) {
    conn.send({ kind: 'file-meta', transferId: rec.transferId, name: rec.file.name, size: rec.file.size, mime: rec.file.type || 'application/octet-stream', from: publicMe(), ts: Date.now() });
  }
  function fmtSpeed(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s';
    return Math.floor(bps) + ' B/s';
  }
  // One unified progress bar per file: 0-50% = preparing the file (reading it from the device),
  // 50-100% = actually sending, with a live speed readout.
  async function streamOutTransfer(rec, conn, myDrive) {
    var prepTimer = null;
    function stopPrep() { if (prepTimer) { clearInterval(prepTimer); prepTimer = null; } }
    function uiProgress() {
      var frac = rec.file.size ? (0.5 + 0.5 * (rec.sentBytes / rec.file.size)) : 1;
      rec.ui.setFrac(frac, rec.sentBytes, rec.file.size, rec._spd ? fmtSpeed(rec._spd) : '');
    }
    try {
      await waitOpen(conn);
      if (!conn.open || rec.driveId !== myDrive) return; // superseded by a newer drive, or the conn died instantly
      updateWakeLock();
      if (rec.nextIndex === 0) {
        var f = 0;
        rec.ui.phase('正在准备文件', 0);
        prepTimer = setInterval(function () { f += (0.92 - f) * 0.07; rec.ui.phase('正在准备文件', f * 0.5); }, 180);
        sendMeta(rec, conn);
      } else {
        var startAt = await queryResume(rec, conn);
        if (rec.driveId !== myDrive) return;
        if (startAt < 0 || startAt > rec.plan.length) {
          // The receiver kept nothing (e.g. its page reloaded): restart from scratch under a fresh id.
          delete outTransfers[rec.transferId];
          rec.transferId = 't-' + Date.now() + '-' + randomCode(5, 'abcdefghijklmnopqrstuvwxyz0123456789');
          outTransfers[rec.transferId] = rec;
          rec.nextIndex = 0; rec.sentBytes = 0;
          sendMeta(rec, conn);
        } else {
          rec.nextIndex = startAt;
          rec.sentBytes = 0;
          for (var k = 0; k < startAt; k++) rec.sentBytes += (rec.plan[k].end - rec.plan[k].start);
          conn.send({ kind: 'file-resume-begin', transferId: rec.transferId, fromChunk: startAt });
          rec.ui.note('已重新接上，从 ' + fmtSize(rec.sentBytes) + ' 处继续传');
        }
        uiProgress();
      }
      rec._win = [];
      var dc = conn.dataChannel;
      for (var i = rec.nextIndex; i < rec.plan.length; i++) {
        while (dc && dc.bufferedAmount > 4 * 1024 * 1024) { if (!conn.open) throw new Error('closed'); await new Promise(function (r) { setTimeout(r, 40); }); }
        if (!conn.open) throw new Error('closed');
        var buf = await rec.file.slice(rec.plan[i].start, rec.plan[i].end).arrayBuffer(); // one chunk at a time, never the whole file
        if (!conn.open) throw new Error('closed');
        conn.send(buf);
        stopPrep();
        rec.nextIndex = i + 1;
        rec.sentBytes += (rec.plan[i].end - rec.plan[i].start);
        var now = Date.now();
        rec._win.push({ t: now, b: rec.sentBytes });
        while (rec._win.length > 2 && now - rec._win[0].t > 3000) rec._win.shift();
        if (rec._win.length > 1) { var w0 = rec._win[0]; var dt = (now - w0.t) / 1000; if (dt > 0.3) rec._spd = (rec.sentBytes - w0.b) / dt; }
        if (i % 4 === 0 || i === rec.plan.length - 1) uiProgress();
      }
      while (dc && dc.bufferedAmount > 0) { if (!conn.open) throw new Error('closed'); await new Promise(function (r) { setTimeout(r, 40); }); }
      conn.send({ kind: 'file-end', transferId: rec.transferId });
      stopPrep();
      rec.state = 'done';
      rec.ui.set(rec.file.size, rec.file.size); rec.ui.done('已发送 ✔');
      delete outTransfers[rec.transferId];
    } catch (e) {
      stopPrep();
      if (rec.driveId === myDrive && rec.state !== 'done') { rec.state = 'paused'; rec.ui.note('已暂停（已传 ' + fmtSize(rec.sentBytes) + '），对方回来后自动续传'); }
    }
    updateWakeLock();
  }
  async function sendFiles(files) {
    if (!room) { alert('页面还在准备连接，稍等一秒再发'); return; }
    var target = $('targetSel').value;
    var recipients = [];
    if (target === 'ALL') { Object.keys(roster).forEach(function (id) { if (id !== deviceId) recipients.push(id); }); }
    else recipients = [target];
    if (!recipients.length) { alert('还没有其他设备。对方打开 Kiwi 页面加入过一次后，即使它暂时离线，你也可以在设备列表里先选它发送，文件会等它上线后自动发过去。'); return; }
    for (var k = 0; k < files.length; k++) {
      addMsg({ from: me, mine: true, ts: Date.now(), file: { name: files[k].name, size: files[k].size, isImage: (files[k].type || '').indexOf('image/') === 0, url: URL.createObjectURL(files[k]) } });
    }
    recipients.forEach(function (rid) {
      var label = (roster[rid] && roster[rid].name) || '设备';
      for (var f = 0; f < files.length; f++) {
        var file = files[f];
        var rec = { transferId: 't-' + Date.now() + '-' + randomCode(5, 'abcdefghijklmnopqrstuvwxyz0123456789'), file: file, targetDeviceId: rid, plan: planChunks(file.size, CHUNK_SIZE), nextIndex: 0, sentBytes: 0, state: 'queued', ui: null };
        rec.ui = progressEl(rec.transferId, '发送 ' + file.name + ' → ' + label);
        outTransfers[rec.transferId] = rec;
        driveOutTransfer(rec);
      }
    });
  }

  // ----- Files: receive (partials are kept per transfer, so a dropped transfer can resume) -----
  function receiveFileMeta(conn, data) {
    if (seen[data.transferId]) return; seen[data.transferId] = 1;
    var ui = progressEl(data.transferId, '接收 ' + data.name + ' ← ' + (data.from ? data.from.name : ''));
    recvTransfers[data.transferId] = { meta: data, chunks: [], received: 0, ui: ui, lastChunkAt: Date.now() };
    recvByPeer[conn.peer] = data.transferId;
    updateWakeLock();
  }
  async function handleChunk(conn, data) {
    var tid = recvByPeer[conn.peer]; if (!tid) return;
    var st = recvTransfers[tid]; if (!st) return;
    var u8;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (data instanceof Uint8Array) u8 = data;
    else if (typeof Blob !== 'undefined' && data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
    else return;
    st.chunks.push(u8); st.received += u8.length; st.lastChunkAt = Date.now();
    st.ui.set(st.received, st.meta.size);
  }
  function finishFile(conn, data) {
    var st = recvTransfers[data.transferId]; if (!st) return;
    delete recvTransfers[data.transferId];
    if (recvByPeer[conn.peer] === data.transferId) delete recvByPeer[conn.peer];
    var bytes = reassembleChunks(st.chunks);
    var blob = new Blob([bytes], { type: st.meta.mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    st.ui.done('已接收 ✔');
    addMsg({ from: st.meta.from, ts: st.meta.ts, mine: false, file: { name: st.meta.name, size: st.meta.size, isImage: (st.meta.mime || '').indexOf('image/') === 0, url: url } });
    updateWakeLock();
  }
  function cancelRecv(conn) {
    var tid = recvByPeer[conn.peer]; var st = tid && recvTransfers[tid];
    if (st) { st.ui.done('对方已取消'); delete recvTransfers[tid]; delete recvByPeer[conn.peer]; }
    updateWakeLock();
  }
  function onResumeQuery(conn, data) {
    var st = recvTransfers[data.transferId];
    var n = (st && st.meta.size === data.size && st.meta.name === data.name) ? st.chunks.length : -1;
    try { conn.send({ kind: 'file-resume-answer', transferId: data.transferId, receivedChunks: n }); } catch (e) {}
  }
  function onResumeBegin(conn, data) {
    var st = recvTransfers[data.transferId]; if (!st) return;
    recvByPeer[conn.peer] = data.transferId;
    st.lastChunkAt = Date.now();
    st.ui.note('对方正在续传（已收到 ' + fmtSize(st.received) + '，接着传）…');
    updateWakeLock();
  }

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
    guestAnnounced = false;
    isHost = false; guestInfo = info;
    room = info.room; secret = info.secret; currentHostPeerId = info.hostPeerId;
    startPeer(null, info.hostPeerId);
    if (opts.viaTrust) setStatus('正在重连信任设备（连接 ' + room + '）…');
    else setStatus('正在连接 ' + room + '…');
  }
  function dialHost() {
    setStatus('正在连接主机…');
    clearTimeout(guestStallTimer);
    guestStallTimer = setTimeout(onGuestStall, forceRelay ? 12000 : 15000);
    dial(currentHostPeerId, { registerOnOpen: true, noP2P: relayOnly });
  }
  // 拨号迟迟不成功，通常就是直连被运营商网络挡了：重拨两次，然后自动改走内置中转。
  function onGuestStall() {
    if (isHost || guestAnnounced || !guestInfo) return;
    if (!relayOnly && (!peer || peer.destroyed)) return;
    guestDialTries++;
    if (guestDialTries <= 2) {
      var old = conns[currentHostPeerId];
      if (old && !old.open) { try { old.close(); } catch (e) {} delete conns[currentHostPeerId]; }
      setStatus('正在连接主机…（第 ' + (guestDialTries + 1) + ' 次尝试）');
      dial(currentHostPeerId, { registerOnOpen: true, noP2P: relayOnly });
      clearTimeout(guestStallTimer);
      guestStallTimer = setTimeout(onGuestStall, 12000);
      return;
    }
    // 直连打洞失败（手机 4G/5G 的典型情况）：自动改走运营商中转，不需要用户配置任何东西。
    var r = ensureRelay();
    if (!r) {
      setStatus('连不上：浏览器不支持中转通道，请换新版 Chrome / Safari / Edge');
      return;
    }
    var ln = getLink(currentHostPeerId);
    if (!ln.bound) bindLink(ln, { registerOnOpen: true });
    conns[currentHostPeerId] = ln;
    if (!ln.relayCh || ln.relayCh.closed) ln.attachRelay(r.channel(currentHostPeerId));
    if (guestDialTries <= 8) {
      setStatus(relayStatus === 'up' ? '正在通过运营商中转连接…' : '直连打洞失败，正在建立中转通道…');
      clearTimeout(guestStallTimer);
      guestStallTimer = setTimeout(onGuestStall, 12000);
    } else {
      setStatus('连不上：确认对方页面开着、连接码一致（已尝试直连 + 中转）');
    }
  }
  function startPeer(fixedId, hostPeerId) {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    stopRelay();
    links = {}; conns = {}; connDevice = {};
    relayOnly = false;
    clearTimeout(peerOpenTimer);
    if (!isHost) { roster = {}; roster[deviceId] = publicMe(); }
    peer = fixedId ? new Peer(fixedId, PEER_OPTS) : new Peer(PEER_OPTS);
    peer.on('open', function (id) {
      signalDrops = 0;
      clearTimeout(peerOpenTimer);
      if (relayOnly) { ensureRelay(); return; } // 已经切到纯中转，身份用中转 id，别被 PeerJS 的 id 覆盖
      me.peerId = id;
      ensureRelay(); // 两端都尽早订阅中转频道，直连失败时能立刻接上
      if (roster[deviceId]) roster[deviceId].peerId = id; else roster[deviceId] = publicMe();
      enterRoomUI(); renderSelf(); renderRoster();
      if (isHost) setStatus(rememberChannel ? '已记住连接已打开，扫码过的信任设备可直接重连' : '临时连接已打开，等其他设备扫码加入');
      else {
        guestDialTries = 0;
        dialHost();
      }
    });
    peer.on('connection', function (conn) {
      var l = getLink(conn.peer);
      if (!l.bound) bindLink(l, {});
      l.attachP2P(conn);
    });
    if (!isHost) {
      // 手机流量下 0.peerjs.com 偶尔完全连不上：12 秒还没拿到信令 id 就直接走中转。
      peerOpenTimer = setTimeout(goRelayOnly, 12000);
    }
    peer.on('error', function (err) {
      var type = (err && err.type) || 'unknown';
      if (type === 'unavailable-id') {
        if (isHost) { alert('这个连接码已被占用（可能你在另一个标签页/窗口也打开了 Kiwi 并记住了同一连接）。请关掉多余的页面，或点「结束会话并换新二维码」。'); setStatus('连接码被占用：可能另一个页面正用同一连接当主机'); }
      } else if (type === 'peer-unavailable') {
        if (autoProbe) { autoProbeFail(); }
        else if (!isHost) setStatus('对方未打开页面，先让对方打开 Kiwi');
        else setStatus('有一台离线设备暂时联系不上');
      } else if (type === 'browser-incompatible') {
        setStatus('这个浏览器不支持 WebRTC，请换新版的 Chrome / Safari / Edge');
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'ssl-unavailable') {
        // 信令服务器连不上：移动网络拦截 0.peerjs.com 时常见 → 直接改走内置中转
        if (!isHost && !me.peerId) { goRelayOnly(); if (relayOnly) return; }
        setStatus('连不上信令服务器（0.peerjs.com 可能被网络拦截），正在自动重试…');
        setTimeout(function () { if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) {} } }, 2500);
      } else if (type === 'webrtc') {
        setStatus('WebRTC 初始化失败：' + ((err && err.message) || '未知原因'));
      } else {
        setStatus('连接问题：' + type + ((err && err.message) ? '（' + err.message + '）' : '') + '，刷新页面可重试');
      }
    });
    peer.on('disconnected', function () {
      signalDrops++;
      setStatus(signalDrops >= 3 ? '反复与信令服务器断开（0.peerjs.com 可能被网络拦截），正在重试…' : '与信令服务器断开，正在重连…');
      setTimeout(function () { try { peer.reconnect(); } catch (e) {} }, Math.min(1000 * signalDrops, 5000));
    });
  }
  function regenerate() {
    var keepRemember = rememberChannel;
    sessionStorage.removeItem('kiwi_temp_host');
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    seen = {}; recvTransfers = {}; recvByPeer = {}; sendQueues = {};
    Object.keys(resumeWaiters).forEach(function (k) { try { resumeWaiters[k](-1); } catch (e) {} }); resumeWaiters = {};
    Object.keys(outTransfers).forEach(function (k) { outTransfers[k].ui.done('已取消'); }); outTransfers = {};
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
    $('reconnectText').textContent = '正在重连「' + (h.hostLabel || h.room) + '」…';
  }
  function cancelAutoProbe() { if (autoProbe) { clearTimeout(autoProbe.timer); autoProbe = null; } $('reconnectBar').classList.add('hidden'); }
  function autoProbeSuccess() {
    guestAnnounced = true;
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
    closeDrawer();
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
  // ----- mobile drawer (sidebar collapses behind the hamburger under 700px) -----
  function closeDrawer() { document.body.classList.remove('drawerOpen'); }
  $('btnDrawer').onclick = function () { document.body.classList.toggle('drawerOpen'); };
  $('drawerBackdrop').onclick = closeDrawer;
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
      setStatus('已信任此设备');
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
  // ----- profile editor: pencil on the avatar -> change avatar + name -----
  var AVATAR_EMOJIS = ['💻', '📱', '🥝', '🍎', '🐱', '🐶', '🦊', '🐼', '🚀', '⭐', '🎧', '⌚'];
  var editSel = { emoji: null, color: null, img: null };
  function renderAvatarPreview() {
    $('avatarPreview').innerHTML = avatarHtml({ icon: editSel.emoji || me.icon, color: editSel.color || me.color, avatarImg: editSel.img }, true);
    Array.prototype.forEach.call($('emojiPicks').children, function (el, i) { el.classList.toggle('sel', !editSel.img && (editSel.emoji || me.icon) === AVATAR_EMOJIS[i]); });
    Array.prototype.forEach.call($('colorPicks').children, function (el, i) { el.classList.toggle('sel', !editSel.img && (editSel.color || me.color) === PALETTE[i]); });
  }
  function buildPicks() {
    $('emojiPicks').innerHTML = AVATAR_EMOJIS.map(function (e) { return '<button type="button" class="pickEmoji">' + e + '</button>'; }).join('');
    Array.prototype.forEach.call($('emojiPicks').children, function (el, i) { el.onclick = function () { editSel.emoji = AVATAR_EMOJIS[i]; editSel.img = null; renderAvatarPreview(); }; });
    $('colorPicks').innerHTML = PALETTE.map(function (c) { return '<button type="button" class="pickColor" style="background:' + c + '"></button>'; }).join('');
    Array.prototype.forEach.call($('colorPicks').children, function (el, i) { el.onclick = function () { editSel.color = PALETTE[i]; editSel.img = null; renderAvatarPreview(); }; });
  }
  $('btnEditProfile').onclick = function () {
    closeDrawer();
    editSel = { emoji: me.icon, color: me.color, img: me.avatarImg || null };
    $('devName').value = me.name;
    buildPicks(); renderAvatarPreview();
    $('profileModal').classList.remove('hidden');
  };
  $('btnCancelProfile').onclick = function () { $('profileModal').classList.add('hidden'); };
  $('profileModal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
  $('avatarFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas'); c.width = 96; c.height = 96;
      var s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
      URL.revokeObjectURL(url);
      try { editSel.img = c.toDataURL('image/jpeg', 0.85); } catch (e) { editSel.img = null; }
      renderAvatarPreview();
    };
    img.src = url;
  });
  $('btnSaveProfile').onclick = function () {
    var n = $('devName').value.trim(); if (n) { me.name = n; localStorage.setItem('kiwi_deviceName', n); }
    if (editSel.emoji) me.icon = editSel.emoji;
    if (editSel.color) me.color = editSel.color;
    me.avatarImg = editSel.img || null;
    try { localStorage.setItem('kiwi_avatar', JSON.stringify({ emoji: me.icon, color: me.color, img: me.avatarImg })); } catch (e) {}
    roster[deviceId] = publicMe(); renderSelf(); renderRoster();
    Object.keys(conns).forEach(function (pid) { var c = conns[pid]; if (c.open) { try { c.send({ kind: 'device-update', device: publicMe() }); } catch (e) {} } });
    if (isHost) hostBroadcastRoster();
    $('profileModal').classList.add('hidden');
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

  // ----- Wake lock: keep the screen on while a transfer is running (a sleeping screen freezes the page) -----
  var wakeLock = null;
  async function updateWakeLock() {
    var now = Date.now();
    var sending = Object.keys(outTransfers).some(function (k) { return outTransfers[k].state === 'sending'; });
    var receiving = Object.keys(recvTransfers).some(function (k) { return now - (recvTransfers[k].lastChunkAt || 0) < 60000; });
    try {
      if ((sending || receiving) && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); }
      } else if (wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }
  setInterval(updateWakeLock, 25000);

  // ----- Auto-reconnect when the page comes back to the foreground (e.g. after switching apps) -----
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    updateWakeLock();
    if (autoProbe) return; // the boot-time trusted-host probe is already on it
    if (peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
    setTimeout(function () {
      if (!peer || peer.destroyed) {
        if (!isHost && guestInfo) { joinRoom(guestInfo); setStatus('页面回到前台，已自动重新连接…'); }
        else if (isHost) { becomeHostFromStorage(); setStatus('页面回到前台，已自动恢复连接…'); }
        return;
      }
      if (!isHost && guestInfo && currentHostPeerId && !conns[currentHostPeerId]) {
        try { dial(currentHostPeerId, { registerOnOpen: true }); } catch (e) {}
      }
      flushAllPending();
    }, 900);
  });

  // ----- boot -----
  renderSelf(); renderRoster(); restoreOutbox();
  probeRelay(); // 后台自检中转能力，决定连不上时的提示语
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
