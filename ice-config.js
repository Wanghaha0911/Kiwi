/* Kiwi 的 ICE / TURN 配置（WebRTC 连接用）
 *
 * 说明：
 *  STUN 只负责“打洞”，能拿到自己的公网地址；两个手机都在运营商 CGNAT（4G/5G 流量）后面时，
 *  打洞经常失败，这时必须有 TURN 中转服务器把数据转发过去，否则会一直“正在连接主机…”。
 *
 *  旧代码里用的 turn:openrelay.metered.ca + 公开账号 openrelayproject 已经被官方下线，
 *  该域名现在解析到 192.0.2.1（RFC 5737 测试地址，等于黑洞），所以中转实际上是不存在的。
 *
 * 怎么配 TURN（两种方式，任选其一）：
 *  1) 不改代码：打开 ice-test.html，把 TURN 地址/用户名/密码填进去，点“保存并用于 Kiwi”。
 *     配置存在本机 localStorage(kiwi_ice_servers)，主页面会自动读取。
 *  2) 改代码：直接填下面的 TURN_SERVERS（会随网页发布给所有人，适合自建 coturn）。
 *
 * 免费 TURN 推荐：Metered 免费额度（每月约 20GB，注册后在 Dashboard 的 TURN 页拿到
 *   “username / credential”，或 TURN 地址 global.relay.metered.ca）。
 */
(function () {
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
