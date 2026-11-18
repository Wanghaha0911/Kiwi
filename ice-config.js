/* Kiwi 的 ICE 配置（WebRTC 直连用）
 *
 * 连接策略：
 *  1) 先尝试 WebRTC 直连（STUN 打洞），能直连速度最快；
 *  2) 打洞失败时（手机 4G/5G 在运营商 CGNAT 后面很常见），Kiwi 会自动切到内置的
 *     「运营商中转」通道（relay.js：公共 MQTT-over-WSS + AES-GCM 端到端加密），
 *     不需要用户配置 TURN，也不需要注册任何账号。
 *
 * 所以这里填的 TURN 只是「可选增强」：如果你有自建 coturn，可以填在 TURN_SERVERS
 * 或 ice-test.html 里，让更多场景走 WebRTC 中转（延迟更低）。不填完全不影响手机流量可用。
 *
 * 历史说明：旧代码用的 turn:openrelay.metered.ca + 公开账号 openrelayproject 已被
 * Metered 官方下线（域名解析到 192.0.2.1 黑洞）；PeerJS 自带的 eu-0 / us-0.turn.peerjs.com
 * 也已失效，所以不能再依赖它们。
 *
 * 怎么配可选 TURN（两种方式，任选其一）：
 *  1) 不改代码：打开 ice-test.html，把 TURN 地址/用户名/密码填进去，点“保存”。
 *     配置存在本机 localStorage(kiwi_ice_servers)，主页面会自动读取。
 *  2) 改代码：直接填下面的 TURN_SERVERS（会随网页发布给所有人，适合自建 coturn）。
 */(function () {
  // 需要中转时在这里填（注意：写在源码里等于公开凭据，只适合自建服务）
  var TURN_SERVERS = [
    // { urls: "turn:global.relay.metered.ca:443", username: "你的用户名", credential: "你的密码" },
    // { urls: "turn:global.relay.metered.ca:443?transport=tcp", username: "你的用户名", credential: "你的密码" },
    // { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "你的用户名", credential: "你的密码" }
  ];

  // 打洞用的 STUN。优先国内/亚洲节点，Google 在部分移动网络下会被拦。
  var STUN_SERVERS = [
    "stun:stun.chat.bilibili.com:3478",
    "stun:stun.hitv.com:3478",
    "stun:stun.miwifi.com:3478",
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302"
  ];

  function fromStorage() {
    try {
      var v = JSON.parse(localStorage.getItem("kiwi_ice_servers") || "null");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function normalize(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (s) {
      if (!s || !s.urls) return;
      var urls = s.urls;
      var key = String(urls);
      if (seen[key]) return;
      // TURN 必须有用户名和密码，缺一个就是无效配置，直接跳过免得拖慢 ICE 收集
      if (/^turns?:/i.test(key) && (!s.username || !s.credential)) return;
      seen[key] = 1;
      out.push({ urls: urls, username: s.username, credential: s.credential });
    });
    return out;
  }

  // 全局给 app.js / ice-test.html 用
  window.kiwiIceServers = function () {
    var stun = STUN_SERVERS.map(function (u) { return { urls: u }; });
    return normalize(stun.concat(TURN_SERVERS, fromStorage()));
  };
  window.kiwiTurnServers = function () {
    return normalize(TURN_SERVERS.concat(fromStorage()));
  };
  window.kiwiSaveIceServers = function (list) {
    localStorage.setItem("kiwi_ice_servers", JSON.stringify(normalize(list)));
  };
})();
