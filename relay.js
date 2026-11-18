/* Kiwi 运营商中转通道（relay.js）
 *
 * 为什么需要它：
 *   手机 4G/5G 大多在运营商 CGNAT 后面，双方打洞（STUN）经常失败；有的运营商还会
 *   直接丢弃非标端口上的 UDP。这时 WebRTC 怎么都连不上，只能让数据经服务器转发。
 *   公共免费 TURN（openrelay / peerjs 自带 / freestun / anyfirewall）现在已全部下线或
 *   需要账号，所以 Kiwi 自带一条“应用层中转通道”：走公共 MQTT-over-WSS（443/8084），
 *   这类 WebSocket 出口在运营商网络里几乎不会被拦。
 *
 * 安全性：
 *   每帧都用 AES-GCM 加密，密钥由邀请二维码里的 secret 派生（PBKDF 不需要，因为 secret
 *   本身就是 16 位随机串）。公共 broker 只能看到密文和随机化的 topic，看不到内容。
 *
 * 可靠性：
 *   每帧带序号，接收方累计确认，发送方超时重传 + 去重，断线重连后自动补发。
 *
 * 接口（给 app.js 用）：
 *   var r = new KiwiRelay({ room, secret, selfId, onPeer: fn, onStatus: fn });
 *   r.channel(peerId)  -> { peer, open, send(data), on(ev,fn), close(), pendingBytes() }
 */
(function (global) {
  'use strict';

  var BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',   // 实测最快（约 10Mbps），放第一个
    'wss://test.mosquitto.org:8081/',
    'wss://broker.emqx.io:8084/mqtt'
  ];
  var TOPIC_ROOT = 'kiwi/v1/';
  var WINDOW = 4;           // 同时在途的帧数（公共 broker 对突发大包比较敏感，窗口太大容易丢帧）
  var FRAME_TIMEOUT = 4500; // 单帧多久没确认就重发
  var FRAME_TRIES = 10;     // 单帧最多重发次数
  var KEEPALIVE = 25000;    // MQTT 协议层 PINGREQ 间隔
  var HANDSHAKE_TIMEOUT = 7000; // 握手卡住多久就放弃这个 broker 换下一个（手机网络下有的节点会被静默丢弃）
  var DEAD_AFTER = 75000;   // 已连通时，这么久没有任何对端下行就当连接已死
  var HELLO_EVERY = 3000;   // 还没确认对端在线时，多久探活一次
  var HEARTBEAT_EVERY = 20000; // 连通后心跳间隔
  var HELLO_ACK_GAP = 1200; // 回应探活的最小间隔，避免两端互相刷屏

  var te = new TextEncoder();
  var td = new TextDecoder();

  function noop() {}
  function u8(s) { return te.encode(s); }
  function hex(a) { var s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function b64(a) { var s = '', step = 0x8000; for (var i = 0; i < a.length; i += step) s += String.fromCharCode.apply(null, a.subarray(i, i + step)); return btoa(s); }
  function unb64(s) { var t = atob(s), out = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; }

  // ---------------- 极简 MQTT 3.1.1（只要 CONNECT/SUBSCRIBE/PUBLISH QoS1） ----------------
  function Mqtt(url, topic) {
    this.url = url;
    this.topic = topic;
    this.ws = null;
    this.up = false;
    this.pid = 1;
    this.pending = {};
    this.rx = new Uint8Array(0);
    this.lastRx = 0;
    this.kp = null;
    this.dead = false;
    this.handlers = { suback: noop, down: noop, message: noop, up: noop };
  }
  Mqtt.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };

  Mqtt.prototype.frame = function (type, body) {
    var len = body.length, vh = [];
    do { var d = len % 128; len = Math.floor(len / 128); if (len > 0) d |= 128; vh.push(d); } while (len > 0);
    var out = new Uint8Array(1 + vh.length + body.length);
    out[0] = type; out.set(vh, 1); out.set(body, 1 + vh.length);
    return out;
  };
  Mqtt.prototype.str = function (s) {
    var b = u8(s), out = new Uint8Array(2 + b.length);
    out[0] = b.length >> 8; out[1] = b.length & 255; out.set(b, 2);
    return out;
  };

  Mqtt.prototype.connect = function () {
    var self = this;
    try { this.ws = new WebSocket(this.url, ['mqtt']); } catch (e) { return false; }
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = function () {
      var id = 'kiwi-' + Math.random().toString(36).slice(2, 12);
      var vh = new Uint8Array(2 + 4 + 1 + 1 + 2 + 2 + id.length);
      var o = 0;
      vh[o++] = 0; vh[o++] = 4; vh.set(u8('MQTT'), o); o += 4;
      vh[o++] = 4;      // protocol level 3.1.1
      vh[o++] = 0x02;   // clean session
      vh[o++] = 0; vh[o++] = 60; // keepalive 60s
      vh[o++] = 0; vh[o++] = id.length; vh.set(u8(id), o);
      self.send(self.frame(0x10, vh));
    };
    this.ws.onmessage = function (ev) { self.feed(ev.data); };
    this.ws.onclose = function () { self.shutdown(); };
    this.ws.onerror = function () { try { self.ws.close(); } catch (e) {} self.shutdown(); };
    this.lastRx = Date.now();
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(function () {
      // WebSocket 打开了却一直拿不到 CONNACK/SUBACK，或握手根本没完成：
      // 主动放弃，交给上层换下一个 broker，避免在手机上干等几十秒。
      if (!self.up) { try { if (self.ws) self.ws.close(); } catch (e) {} self.shutdown(); }
    }, HANDSHAKE_TIMEOUT);
    if (this.kp) clearInterval(this.kp);
    this.kp = setInterval(function () {
      if (!self.up) return;
      if (Date.now() - self.lastRx > DEAD_AFTER) { try { self.ws.close(); } catch (e) {} return; }
      self.send(self.frame(0xC0, new Uint8Array(0)));
    }, KEEPALIVE);
    return true;
  };

  Mqtt.prototype.send = function (bytes) {
    try { if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return true; } } catch (e) {}
    return false;
  };

  Mqtt.prototype.subscribe = function () {
    var t = this.str(this.topic);
    var body = new Uint8Array(2 + t.length + 1);
    body[0] = 0; body[1] = 1;             // packet id 1
    body.set(t, 2); body[body.length - 1] = 1; // QoS 1
    this.send(this.frame(0x82, body));
  };

  Mqtt.prototype.publish = function (topic, bytes) {
    if (!this.up) return false;
    var t = this.str(topic);
    var body = new Uint8Array(t.length + bytes.length);
    body.set(t, 0);
    body.set(bytes, t.length);
    return this.send(this.frame(0x30, body)); // QoS0：自己这一层做确认/重传，broker 不用再回 PUBACK
  };

  Mqtt.prototype.feed = function (data) {
    var add = new Uint8Array(data);
    var buf = new Uint8Array(this.rx.length + add.length);
    buf.set(this.rx); buf.set(add, this.rx.length);
    this.lastRx = Date.now();
    var o = 0;
    while (o + 2 <= buf.length) {
      var mult = 1, len = 0, i = o + 1, b;
      do {
        if (i >= buf.length) { this.rx = buf.subarray(o); return; }
        b = buf[i++]; len += (b & 127) * mult; mult *= 128;
      } while (b & 128);
      var total = i + len;
      if (total > buf.length) { this.rx = buf.subarray(o); return; }
      this.packet(buf[o], buf.subarray(i, total));
      o = total;
    }
    this.rx = buf.subarray(o);
  };

  Mqtt.prototype.packet = function (type, body) {
    if (type === 0x20) {                     // CONNACK
      if (body[1] === 0) { if (this.handlers.suback === noop) { this.subscribe(); } else { this.subscribe(); } }
      else this.shutdown();
    } else if (type === 0x90) {              // SUBACK
      this.up = true;
      if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
      this.handlers.up();
    } else if (type === 0x40) {              // PUBACK
      var pid = (body[0] << 8) | body[1];
      delete this.pending[pid];
    } else if ((type & 0xf0) === 0x30) {     // PUBLISH
      var tl = (body[0] << 8) | body[1];
      var qos = (type >> 1) & 3;
      var off = 2 + tl;
      if (qos > 0) {
        var id = (body[off] << 8) | body[off + 1];
        off += 2;
        this.send(this.frame(0x40, new Uint8Array([id >> 8, id & 255])));
      }
      this.handlers.message(body.subarray(off));
    }
  };

  Mqtt.prototype.shutdown = function (silent) {
    if (this.dead) return;
    this.dead = true;
    this.up = false;
    if (this.kp) { clearInterval(this.kp); this.kp = null; }
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    try { if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } } catch (e) {}
    this.ws = null;
    this.rx = new Uint8Array(0);
    this.pending = {};
    // 注意：连接失败（还没 SUBACK 就断开）也必须通知上层重连，否则换 broker 的逻辑不会触发。
    if (!silent) this.handlers.down();
  };

  // ---------------- 单条通道（一对设备之间） ----------------
  // open 的语义：不仅本机 MQTT 连上了，而且「对端确实收到了我们的探活并回了确认」。
  // 这样 Guest 不会在 Host 根本没订阅时误报“已连接”，Host 也能及时发现对端关页。
  function Channel(relay, peerId) {
    var self = this;
    this.relay = relay;
    this.peer = peerId;
    this.open = false;
    this.closed = false;
    this.handlers = { open: [], data: [], close: [], error: [] };
    this.outSeq = 0;
    this.inSeq = 1;
    this.outQ = [];
    this.pendingSend = 0;       // 已调用 send()、但还没完成编码/加密的字节数（给上层做背压）
    this.inBuf = {};
    this.ackTimer = null;
    this.chain = Promise.resolve();     // 接收侧：串行解密
    this.sendChain = Promise.resolve(); // 发送侧：串行编码/加密/编号，保证调用顺序
    this.lastRx = Date.now();   // 最后一次收到对端任何消息
    this.lastHello = 0;         // 最后一次发探活/心跳
    this.lastAck = 0;           // 最后一次回应别人的探活
    this.timer = setInterval(function () { self.tick(); }, 1000);
  }
  Channel.prototype.on = function (ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); };
  Channel.prototype.emit = function (ev, a) {
    var l = this.handlers[ev] || [];
    for (var i = 0; i < l.length; i++) { try { l[i](a); } catch (e) {} }
  };
  Channel.prototype.pendingBytes = function () {
    var n = this.pendingSend || 0;
    for (var i = 0; i < this.outQ.length; i++) n += this.outQ[i].size;
    var ws = this.relay.mqtt && this.relay.mqtt.ws;
    if (ws && ws.bufferedAmount) n += ws.bufferedAmount;
    return n;
  };
  Channel.prototype.markOpen = function () {
    if (this.open || this.closed) return;
    this.open = true;
    this.emit('open');
  };
  Channel.prototype.sayHello = function (isAck) {
    var now = Date.now();
    if (isAck) {
      if (now - this.lastAck < HELLO_ACK_GAP) return;
      this.lastAck = now;
    }
    this.lastHello = now;
    var env = { f: this.relay.selfId, t: this.peer, h: 1 };
    if (isAck) env.a = 1;
    this.relay.publish(this.peer, u8(JSON.stringify(env)));
  };
  // 收到对端探活：
  //  - 普通 h：对方在找我们，回一个 h+a 确认
  //  - h+a：对端确实收到了我们的探活 → 双向可达，通道才算 open
  Channel.prototype.onHeartbeat = function (m) {
    this.lastRx = Date.now();
    if (m.a) this.markOpen();
    else this.sayHello(true);
  };
  // broker 重连成功：对端可能也重连过，重新探活并补发未确认的数据
  Channel.prototype.onRelayUp = function () {
    if (this.closed) return;
    this.lastRx = Date.now();
    this.sayHello(false);
    this.pump();
  };
  Channel.prototype.encode = function (data) {
    // 先判断二进制类型，再把普通对象当 JSON。
    // 注意：不能靠 data.size 判断 Blob —— file-meta 等对象本身也有 size 字段，
    // 之前因此被 String(data) 变成了 "[object Object]"，文件元数据全部丢失。
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return data.arrayBuffer().then(function (b) { return pref(1, new Uint8Array(b)); });
    }
    if (data instanceof ArrayBuffer) return Promise.resolve(pref(1, new Uint8Array(data)));
    if (global.ArrayBuffer.isView && global.ArrayBuffer.isView(data)) return Promise.resolve(pref(1, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    if (typeof data === 'string') return Promise.resolve(pref(0, u8(data)));
    if (data && typeof data === 'object') {
      try { return Promise.resolve(pref(0, u8(JSON.stringify(data)))); }
      catch (e) { return Promise.reject(e); }
    }
    return Promise.resolve(pref(0, u8(String(data))));
  };
  function pref(kind, bytes) {
    var out = new Uint8Array(bytes.length + 1);
    out[0] = kind; out.set(bytes, 1);
    return out;
  }
  Channel.prototype.send = function (data) {
    var self = this;
    if (this.closed) throw new Error('relay-closed');
    // 估算“还在加密队列里的字节数”。app.js 用 pendingBytes() 做背压；
    // 如果不算这一部分，发送端会在文件分片还没加密完时就误以为队列已空，
    // 把整个大文件一次性读进内存，最终触发 outQ 上限而丢帧。
    var est = 0;
    try {
      if (typeof data === 'string') est = data.length;
      else if (typeof Blob !== 'undefined' && data instanceof Blob) est = data.size || 0;
      else if (data instanceof ArrayBuffer) est = data.byteLength || 0;
      else if (global.ArrayBuffer.isView && global.ArrayBuffer.isView(data)) est = data.byteLength || 0;
      else if (data && typeof data === 'object') est = JSON.stringify(data).length;
    } catch (e) { est = 0; }
    this.pendingSend += est;
    // 重要：encode()/seal() 都是异步的，如果并发执行，AES-GCM 完成顺序可能变化，
    // 导致 file-meta 和第一个分片调换顺序。整条「编码 + 加密 + 分配 seq + 入队」
    // 必须按调用顺序串行执行。
    this.sendChain = this.sendChain.then(function () {
      if (self.closed) return null;
      return self.encode(data).then(function (plain) {
        return self.relay.seal(plain);
      }).then(function (ct) {
        var seq = ++self.outSeq;
        var env = { f: self.relay.selfId, t: self.peer, s: seq, p: b64(ct) };
        self.outQ.push({ seq: seq, json: u8(JSON.stringify(env)), sentAt: 0, tries: 0, size: ct.length });
        if (self.outQ.length > 4000) self.outQ.shift(); // 防御：极端情况下别把内存吃爆
        self.pump();
        return null;
      });
    }).catch(function (e) { self.emit('error', e); }).then(function () {
      self.pendingSend = Math.max(0, self.pendingSend - est);
    });
    return this.sendChain;
  };
  Channel.prototype.pump = function () {
    if (this.closed || !this.relay.ready) return;
    var ws = this.relay.mqtt && this.relay.mqtt.ws;
    if (ws && ws.bufferedAmount > 2 * 1024 * 1024) return; // 浏览器发送队列堵了就等下一拍
    var inflight = 0, i;
    for (i = 0; i < this.outQ.length; i++) if (this.outQ[i].sentAt) inflight++;
    for (i = 0; i < this.outQ.length && inflight < WINDOW; i++) {
      var it = this.outQ[i];
      if (it.sentAt) continue;
      this.transmit(it);
      inflight++;
    }
  };
  Channel.prototype.transmit = function (it) {
    it.sentAt = Date.now();
    it.tries++;
    if (!this.relay.publish(this.peer, it.json)) it.sentAt = 0;
  };
  Channel.prototype.tick = function () {
    if (this.closed) return;
    var now = Date.now(), i;
    if (!this.relay.ready) {
      // broker 断了：所有未确认的帧重新排队，等重连后补发
      for (i = 0; i < this.outQ.length; i++) this.outQ[i].sentAt = 0;
      return;
    }
    if (!this.open) {
      if (now - this.lastHello >= HELLO_EVERY) this.sayHello(false);
    } else {
      if (now - this.lastHello >= HEARTBEAT_EVERY) this.sayHello(false);
      if (now - this.lastRx > DEAD_AFTER) {
        // 对端关页 / 掉线：关闭通道，交给 app 现有的断线重连逻辑重新握手
        this.emit('error', new Error('relay-dead'));
        this.close();
        return;
      }
    }
    for (i = 0; i < this.outQ.length; i++) {
      var it = this.outQ[i];
      if (it.sentAt && now - it.sentAt > FRAME_TIMEOUT) {
        if (it.tries >= FRAME_TRIES) {
          it.sentAt = 0;
          this.emit('error', new Error('relay-timeout'));
          this.close();
          return;
        }
        it.sentAt = 0; // 超时重发（原来误写成 this.sentAt，永远不生效）
      }
    }
    this.pump();
  };
  Channel.prototype.queueAck = function (force) {
    var self = this;
    if (force) {
      if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
      this.relay.ack(this.peer, this.inSeq - 1);
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(function () { self.ackTimer = null; self.relay.ack(self.peer, self.inSeq - 1); }, 120);
  };
  Channel.prototype.onAck = function (seq) {
    this.lastRx = Date.now();
    while (this.outQ.length && this.outQ[0].seq <= seq) this.outQ.shift();
    this.pump();
  };
  Channel.prototype.onFrame = function (seq, ct) {
    var self = this;
    this.lastRx = Date.now();
    if (seq < this.inSeq) { this.queueAck(true); return; }
    if (this.inBuf[seq]) return;
    var gap = seq > this.inSeq;
    this.inBuf[seq] = ct;
    var ready = [];
    while (this.inBuf[this.inSeq]) { ready.push([this.inSeq, this.inBuf[this.inSeq]]); delete this.inBuf[this.inSeq]; this.inSeq++; }
    this.queueAck(gap);
    for (var i = 0; i < ready.length; i++) {
      var item = ready[i];
      // 串行解密，保证交付顺序和发送顺序一致
      this.chain = this.chain.then(function (it) {
        return self.relay.open_sealed(it[1]).then(function (plain) {
          if (self.closed) return;
          if (plain[0] === 1) self.emit('data', plain.slice(1).buffer);
          else { try { self.emit('data', JSON.parse(td.decode(plain.subarray(1)))); } catch (e) {} }
          return null;
        }).catch(function (e) { self.emit('error', e); });
      }.bind(null, item));
    }
  };
  Channel.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    clearInterval(this.timer);
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    if (this.relay.channels[this.peer] === this) delete this.relay.channels[this.peer];
    this.emit('close');
  };

  // ---------------- 中转客户端 ----------------
  function KiwiRelay(opts) {
    opts = opts || {};
    this.room = String(opts.room || '');
    this.secret = String(opts.secret || '');
    this.selfId = String(opts.selfId || '');
    this.onPeer = opts.onPeer || noop;
    this.onStatus = opts.onStatus || noop;
    this.channels = {};
    this.ready = false;
    this.stopped = false;
    this.mqtt = null;
    this.topicRoot = '';
    this.inbox = '';
    this.key = null;
    this.brokerIdx = 0;
    this.backoff = 800;
    this.tries = 0;
    this.timer = null;
    this.start();
  }

  KiwiRelay.prototype.start = function () {
    var self = this;
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle || !this.room || !this.secret || !this.selfId) { this.onStatus('unsupported'); return; }
    subtle.digest('SHA-256', u8('kiwi-relay-key-v1|' + this.room + '|' + this.secret)).then(function (d) {
      return subtle.importKey('raw', d, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }).then(function (k) {
      self.key = k;
      return subtle.digest('SHA-256', u8('kiwi-relay-topic-v1|' + self.room + '|' + self.secret));
    }).then(function (d) {
      var tb = new Uint8Array(d);
      self.topicRoot = TOPIC_ROOT + hex(tb.subarray(0, 12)) + '/';
      self.inbox = self.topicRoot + 'in/' + self.selfId;
      self.onStatus('connecting');
      self.connect();
    }).catch(function () { self.onStatus('unsupported'); });
  };

  KiwiRelay.prototype.seal = function (plain) {
    var iv = new Uint8Array(12);
    global.crypto.getRandomValues(iv);
    return global.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, this.key, plain).then(function (ct) {
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(iv); out.set(new Uint8Array(ct), 12);
      return out;
    });
  };
  KiwiRelay.prototype.open_sealed = function (sealed) {
    return global.crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, this.key, sealed.subarray(12)).then(function (p) {
      return new Uint8Array(p);
    });
  };

  KiwiRelay.prototype.connect = function () {
    var self = this;
    if (this.stopped) return;
    var url = BROKERS[this.brokerIdx % BROKERS.length];
    var m = new Mqtt(url, this.inbox);
    this.mqtt = m;
    m.on('up', function () {
      self.ready = true; self.tries = 0; self.backoff = 800;
      self.onStatus('up');
      Object.keys(self.channels).forEach(function (k) { self.channels[k].onRelayUp(); });
    });
    m.on('down', function () {
      self.ready = false;
      self.onStatus('connecting');
      self.scheduleReconnect();
    });
    m.on('message', function (payload) { self.onMessage(payload); });
    if (!m.connect()) this.scheduleReconnect();
  };

  KiwiRelay.prototype.scheduleReconnect = function () {
    var self = this;
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.tries++;
    if (this.tries > 2) this.brokerIdx++;    // 连续失败就换一个 broker
    this.timer = setTimeout(function () {
      if (self.stopped) return;
      if (self.mqtt) { try { self.mqtt.shutdown(true); } catch (e) {} }
      self.connect();
    }, Math.min(this.backoff, 8000));
    this.backoff = Math.min(this.backoff * 1.6, 8000);
  };

  KiwiRelay.prototype.publish = function (peerId, jsonBytes) {
    if (!this.mqtt || !this.topicRoot) return false;
    return this.mqtt.publish(this.topicRoot + 'in/' + peerId, jsonBytes);
  };
  KiwiRelay.prototype.ack = function (peerId, seq) {
    var env = JSON.stringify({ f: this.selfId, t: peerId, k: seq });
    this.publish(peerId, u8(env));
  };

  KiwiRelay.prototype.onMessage = function (payload) {
    var m;
    try { m = JSON.parse(td.decode(payload)); } catch (e) { return; }
    if (!m || m.t !== this.selfId || !m.f || m.f === this.selfId) return;
    var ch = this.channel(m.f);
    if (m.h) { ch.onHeartbeat(m); return; }   // 探活/心跳：同时用于判断对端是否还活着
    if (typeof m.k === 'number') { ch.onAck(m.k); return; }
    if (typeof m.s === 'number' && m.p) { ch.onFrame(m.s, unb64(m.p)); }
  };

  KiwiRelay.prototype.channel = function (peerId) {
    var ch = this.channels[peerId];
    if (ch && !ch.closed) return ch;
    ch = new Channel(this, peerId);
    this.channels[peerId] = ch;
    this.onPeer(peerId, ch);
    if (this.ready) ch.onRelayUp();   // 已连上 broker：立刻探活，对端在就会回
    return ch;
  };

  KiwiRelay.prototype.stop = function () {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.timer);
    Object.keys(this.channels).forEach(function (k) { try { this.channels[k].close(); } catch (e) {} }, this);
    if (this.mqtt) { try { this.mqtt.shutdown(); } catch (e) {} }
  };

  global.KiwiRelay = KiwiRelay;
})(typeof window !== 'undefined' ? window : this);






