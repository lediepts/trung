// Main Process (Electron)
const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
let axios, HttpsProxyAgent;
try {
  axios = require("axios");
  ({ HttpsProxyAgent } = require("https-proxy-agent"));
} catch (e) {
  console.error("❌ Thiếu phụ thuộc. Hãy chạy: npm i axios https-proxy-agent");
  app.quit();
}
let mainWindow = null;
// ===== Hằng số =====
const TIMEOUT_MS = 10000;
const TEST_URL = "https://api.ipify.org?format=json";
const LOGIN_WAIT_MS = 2000;
const LOGIN_RETRIES = 8;
const PRODUCT_LOAD_DELAY_MS = 800;
const TAB2_HUMANIZE_MS = 5000;
const WAIT_SELECTOR_TIMEOUT = 5000;
const PROXY_ERRORS = [
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_NO_SUPPORTED_PROXIES",
];

// ===== Retry policy for proxy errors ===== (giữ nguyên, dùng cho chế độ có proxy)
const PROXY_RETRY_DELAY_MS = 10000; // 10s
const PROXY_MAX_RETRIES = 2; // thử lại 2 lần, lần thứ 3 mới restart
let PROXY_RETRY_STATE = { running: false };

// ===== Trạng thái & tiện ích UI =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uiLog = (msg) => {
  try {
    mainWindow?.webContents?.send("ui:log", { type: "log", message: msg });
  } catch (_) {}
};
const uiDone = () => {
  try {
    mainWindow?.webContents?.send("ui:done", { type: "done" });
  } catch (_) {}
};
let KEEP = { keepAlive1: null, tab2LoopAbort: false, aborted: false };
let TAB = { tab1: null, tab2: null };
let FLOW = {
  cfg: null,
  proxyIndex: 0,
  starting: false,
  inFailover: false,
  directMode: false, // true khi không dùng proxy
};

// ===== Xác thực Proxy (407) =====
const proxyAuthByWebContents = new WeakMap();
app.on("login", (event, webContents, request, authInfo, callback) => {
  if (authInfo && authInfo.isProxy) {
    event.preventDefault();
    const creds = proxyAuthByWebContents.get(webContents);
    if (creds && creds.username && creds.password)
      return callback(creds.username, creds.password);
  }
});

// ===== Cửa sổ ứng dụng =====
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    title: "Askul With Proxy & Config Manager",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}
app.whenReady().then(createMainWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (mainWindow === null) createMainWindow();
});

// ===== Lưu meta =====
const USER_DATA_DIR = () => app.getPath("userData");
const META_FILE = () => path.join(USER_DATA_DIR(), "meta.json");
const readMeta = () => {
  try {
    if (!fs.existsSync(META_FILE())) return {};
    return JSON.parse(fs.readFileSync(META_FILE(), "utf-8") || "{}");
  } catch {
    return {};
  }
};
const writeMeta = (m) => {
  try {
    fs.writeFileSync(META_FILE(), JSON.stringify(m || {}, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
};

// ===== Thiết lập UA & Accept-Language toàn cục để giảm fingerprint bất thường =====
// (Áp dụng cho mọi session nếu không set riêng)  — tham chiếu UA/headers: Electron webRequest & UA fallback
// https://stackoverflow.com/questions/35672602/how-to-set-electron-useragent  |  https://tinydew4.gitbooks.io/electron/content/api/session.html
app.whenReady().then(() => {
  const UA_CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  app.userAgentFallback = UA_CHROME;

  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders["Accept-Language"] =
      "ja-JP,ja;q=0.9,en;q=0.8,vi;q=0.7";
    if (details.requestHeaders["User-Agent"]) {
      details.requestHeaders["User-Agent"] = UA_CHROME;
    }
    cb({ requestHeaders: details.requestHeaders });
  });
});

// ===== Proxy helpers (parser linh hoạt) =====
function parseProxyFlexible(raw) {
  if (!raw || typeof raw !== "string")
    throw new Error("Chuỗi proxy không hợp lệ.");
  const s = raw.trim();
  // Hỗ trợ: http(s)://user:pass@host:port
  const m = s.match(/^(https?:\/\/)?([^:@]+):([^@]+)@([^:]+):(\d+)$/i);
  if (m) {
    const username = m[2],
      password = m[3],
      host = m[4],
      port = Number(m[5]);
    if (!host || Number.isNaN(port))
      throw new Error("Thông tin proxy không hợp lệ.");
    return { host, port, username, password, raw: s };
  }
  // host:port:user:pass
  const parts = s.split(":").map((x) => x.trim());
  if (parts.length !== 4)
    throw new Error(
      "Định dạng proxy sai. Dùng IP:Port:Username:Password hoặc http(s)://user:pass@host:port"
    );
  const [host, portStr, username, password] = parts;
  const port = Number(portStr);
  if (
    !host ||
    Number.isNaN(port) ||
    port <= 0 ||
    port > 65535 ||
    !username ||
    !password
  )
    throw new Error("Thông tin proxy không hợp lệ.");
  return { host, port, username, password, raw: s };
}
async function testWithHttpProxy(p) {
  const agent = new HttpsProxyAgent(
    `http://${encodeURIComponent(p.username)}:${encodeURIComponent(
      p.password
    )}@${p.host}:${p.port}`
  );
  const client = axios.create({
    httpsAgent: agent,
    proxy: false,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
  const res = await client.get(TEST_URL);
  return { ok: res?.status === 200 && !!res?.data?.ip, ip: res?.data?.ip };
}
function proxyRulesFromRaw(p) {
  return `http=${p.host}:${p.port};https=${p.host}:${p.port}`;
}
function currentProxyRaw() {
  const list = FLOW.cfg?.proxies || [];
  return list[FLOW.proxyIndex] || null;
}
function nextProxyIndex() {
  const list = FLOW.cfg?.proxies || [];
  if (!list.length) return 0;
  return (FLOW.proxyIndex + 1) % list.length;
}

// ===== Tạo cửa sổ: Direct (không proxy) & Proxy (cố định partition Tab1) =====
// direct mode: Electron/Chromium không dùng proxy (docs ProxyConfig: mode 'direct')
// https://www.electronjs.org/docs/latest/api/structures/proxy-config
async function createWindowDirect(url, title) {
  const partition = "persist:askul-tab1"; // cố định để giữ cookie
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title,
    webPreferences: {
      partition,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nativeWindowOpen: false, // giúp kiểm soát UA ở window.open
    },
  });
  win.webContents.setUserAgent(app.userAgentFallback);
  win.webContents.setMaxListeners(30);
  const ses = session.fromPartition(partition);
  await ses.setProxy({ mode: "direct" }); // dùng IP môi trường hiện tại
  try {
    await win.loadURL(url);
  } catch (e) {
    uiLog(`⚠️ ${title}: lỗi tải ban đầu: ${e.message || e}`);
  }
  return win;
}
async function createWindowWithProxy(url, proxyString, title) {
  const p = parseProxyFlexible(proxyString);
  const partition = "persist:askul-tab1"; // cố định để giữ cookie
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title,
    webPreferences: {
      partition,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nativeWindowOpen: false,
    },
  });
  win.webContents.setUserAgent(app.userAgentFallback);
  win.webContents.setMaxListeners(30);
  const ses = session.fromPartition(partition);
  await ses.setProxy({ proxyRules: proxyRulesFromRaw(p) });
  proxyAuthByWebContents.set(win.webContents, {
    username: p.username,
    password: p.password,
  });
  try {
    await win.loadURL(url);
  } catch (e) {
    uiLog(`⚠️ ${title}: lỗi tải ban đầu: ${e.message || e}`);
  }
  return win;
}

// ===== Failover Proxy =====
async function switchToNextProxyAndRestart(reason) {
  if (FLOW.inFailover) return;
  FLOW.inFailover = true;
  uiLog(
    `⚠️ Phát hiện sự cố proxy (${reason}). Chuyển sang proxy tiếp theo và khởi động lại…`
  );
  try {
    await stopAll(true);
  } catch (_) {}
  FLOW.proxyIndex = nextProxyIndex();
  const raw = currentProxyRaw();
  let t = { ok: false, ip: "" };
  try {
    t = await testWithHttpProxy(parseProxyFlexible(raw));
  } catch (e) {
    uiLog(`❌ Kiểm tra proxy tiếp theo thất bại: ${e.message}`);
  }
  if (!t.ok) {
    uiLog("❌ Proxy tiếp theo không hợp lệ. Tiếp tục thử cái khác…");
    FLOW.inFailover = false;
    return switchToNextProxyAndRestart("Proxy tiếp theo không hợp lệ");
  }
  FLOW.inFailover = false;
  await startRunFlow();
}

// ===== Log thông tin Proxy =====
async function logCurrentProxy(win, name) {
  try {
    const ses = win.webContents.session;
    const target = FLOW.cfg?.productUrl || "https://example.com/";
    const proxyStr = await ses.resolveProxy(target);
    let ip = "";
    try {
      if (FLOW.directMode) {
        const res = await axios.get(TEST_URL, {
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        });
        ip = res?.data?.ip || "";
      } else {
        const raw = currentProxyRaw();
        if (raw) {
          const p = parseProxyFlexible(raw);
          const client = axios.create({
            httpsAgent: new HttpsProxyAgent(
              `http://${encodeURIComponent(p.username)}:${encodeURIComponent(
                p.password
              )}@${p.host}:${p.port}`
            ),
            proxy: false,
            timeout: TIMEOUT_MS,
            validateStatus: () => true,
          });
          const res = await client.get(TEST_URL);
          ip = res?.data?.ip || "";
        }
      }
    } catch (_) {}
    uiLog(`🔎 ${name}: Proxy=${proxyStr} / IP ngoài=${ip || "không rõ"}`);
  } catch (e) {
    uiLog(`⚠️ ${name}: Không lấy được thông tin proxy: ${e.message}`);
  }
}

// ===== Retry helpers & handler =====
async function retryCurrentProxyWithDelay(
  maxRetries = PROXY_MAX_RETRIES,
  delayMs = PROXY_RETRY_DELAY_MS
) {
  const raw = currentProxyRaw();
  if (!raw) return false;
  for (let i = 1; i <= maxRetries; i++) {
    uiLog(
      `🟠 Sẽ thử lại proxy sau ${Math.round(
        delayMs / 1000
      )} giây (${i}/${maxRetries})`
    );
    await sleep(delayMs);
    try {
      const t = await testWithHttpProxy(parseProxyFlexible(raw));
      if (t.ok) return true;
    } catch (_) {}
  }
  return false;
}
async function handleProxyError(label, reason) {
  if (FLOW.directMode) return; // trong Direct mode bỏ qua xử lý lỗi proxy
  if (FLOW.inFailover) return;
  if (PROXY_RETRY_STATE.running) return;

  PROXY_RETRY_STATE.running = true;
  try {
    uiLog(
      `⚠️ ${label}: Lỗi proxy (${reason}). Sẽ thử lại ${PROXY_MAX_RETRIES} lần với khoảng cách 10s rồi mới chuyển proxy nếu vẫn lỗi.`
    );
    const recovered = await retryCurrentProxyWithDelay(
      PROXY_MAX_RETRIES,
      PROXY_RETRY_DELAY_MS
    );
    if (recovered) {
      uiLog(`🟢 ${label}: Proxy đã phục hồi. Tiếp tục xử lý.`);
      try {
        TAB.tab1 && !TAB.tab1.isDestroyed() && TAB.tab1.reload();
      } catch (_) {}
      try {
        TAB.tab2 && !TAB.tab2.isDestroyed() && TAB.tab2.reload();
      } catch (_) {}
    } else {
      uiLog(
        `❌ ${label}: 3 lần liên tiếp thất bại. Chuyển sang proxy kế và khởi động lại.`
      );
      await switchToNextProxyAndRestart(`${label}: ${reason}`);
    }
  } finally {
    PROXY_RETRY_STATE.running = false;
  }
}

// ===== Theo dõi lỗi Proxy =====
function observeProxyErrors(win, label) {
  if (!win) return;
  win.webContents.on("did-fail-load", async (_ev, errorCode, errorDesc) => {
    const reason = errorDesc || String(errorCode || "");
    if (PROXY_ERRORS.some((k) => reason.includes(k)))
      handleProxyError(label, reason);
  });
  try {
    const ses = win.webContents.session;
    ses.webRequest.onErrorOccurred({ urls: ["*://*/*"] }, async (details) => {
      const err = details.error || "";
      if (PROXY_ERRORS.some((k) => err.includes(k)))
        handleProxyError(label, err);
    });
  } catch (_) {}
}

// ===== Humanize (chuột/scroll) =====
function randomMouseMove(win, times = 2) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  for (let i = 0; i < times; i++) {
    const x = Math.floor(20 + Math.random() * (b.width - 40));
    const y = Math.floor(80 + Math.random() * (b.height - 160));
    try {
      win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    } catch (_) {}
  }
}
async function humanizeScroll(win, durationMs = TAB2_HUMANIZE_MS) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    if (KEEP.aborted || KEEP.tab2LoopAbort || !win || win.isDestroyed()) break;
    randomMouseMove(win, 1);
    const deltaY =
      (Math.random() > 0.5 ? 1 : -1) * Math.floor(20 + Math.random() * 80);
    try {
      if (!win.isDestroyed())
        win.webContents.sendInputEvent({
          type: "mouseWheel",
          deltaX: 0,
          deltaY,
        });
    } catch (_) {}
    await sleep(400 + Math.random() * 250);
  }
}

// ===== Helpers: center/click/type =====
async function getElementCenter(win, selector) {
  const js = `
 (function(sel){
   const el = document.querySelector(sel);
   if (!el) return null;
   try { el.scrollIntoView({behavior:'instant', block:'center'}); } catch(_) {}
   const r = el.getBoundingClientRect();
   return { x: Math.floor(r.left + r.width/2), y: Math.floor(r.top + r.height/2) };
 })(${JSON.stringify(selector)});
 `;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch (_) {
    return null;
  }
}
async function clickAt(win, x, y) {
  try {
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    await sleep(25 + Math.random() * 50);
    win.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(25 + Math.random() * 50);
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(20 + Math.random() * 40);
  } catch (_) {}
}
async function typeChars(win, text) {
  if (!text) return;
  for (const ch of text) {
    try {
      win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    } catch (_) {}
    await sleep(60 + Math.random() * 90);
  }
  const js = `
 (function(){
   const el = document.activeElement;
   if (!el) return false;
   try {
     el.dispatchEvent(new Event('input', {bubbles:true}));
     el.dispatchEvent(new Event('change', {bubbles:true}));
   } catch(_) {}
   return true;
 })();
 `;
  try {
    await win.webContents.executeJavaScript(js, true);
  } catch (_) {}
}

// ===== Login (hybrid: type → fallback value → click/enter) =====
async function doExactLogin(win, loginUser, loginPass) {
  const sels = {
    user: 'input[name="loginId"]',
    pass: 'input[name="pass"]',
    btn: 'input.login_btn[type="button"][value="ログイン"], button[type="submit"], input[type="submit"]',
  };
  const exists = await win.webContents.executeJavaScript(
    `
 (function(s){
   return {
     u: !!document.querySelector(s.user),
     p: !!document.querySelector(s.pass),
     b: !!document.querySelector(s.btn)
   };
 })(${JSON.stringify(sels)})
 `,
    true
  );
  if (!exists?.u || !exists?.p)
    return { ok: false, msg: "Không tìm thấy form đăng nhập." };
  const cU = await getElementCenter(win, sels.user);
  if (!cU) return { ok: false, msg: "Không lấy được tọa độ ô User." };
  await clickAt(win, cU.x, cU.y);
  await typeChars(win, loginUser);
  const cP = await getElementCenter(win, sels.pass);
  if (!cP) return { ok: false, msg: "Không lấy được tọa độ ô Password." };
  await clickAt(win, cP.x, cP.y);
  await typeChars(win, loginPass);
  // Fallback nếu chưa thấy value trong input
  const filled = await win.webContents.executeJavaScript(
    `
 (function(s){
   const iu=document.querySelector(s.user), ip=document.querySelector(s.pass);
   return !!iu && !!ip && (iu.value||'').length>0 && (ip.value||'').length>0;
 })(${JSON.stringify(sels)})
 `,
    true
  );
  if (!filled) {
    await win.webContents.executeJavaScript(
      `
 (function(s,u,p){
   const iu=document.querySelector(s.user), ip=document.querySelector(s.pass);
   if (!iu||!ip) return false;
   iu.value=u; iu.dispatchEvent(new Event('input',{bubbles:true}));
   iu.dispatchEvent(new Event('change',{bubbles:true}));
   ip.value=p; ip.dispatchEvent(new Event('input',{bubbles:true}));
   ip.dispatchEvent(new Event('change',{bubbles:true}));
   return true;
 })(${JSON.stringify(sels)}, ${JSON.stringify(loginUser)}, ${JSON.stringify(
        loginPass
      )})
 `,
      true
    );
    uiLog("🟡 Đã gán giá trị vào ô nhập (fallback).");
  }
  // Submit
  const submitRes = await win.webContents.executeJavaScript(
    `
 (function(s){
   if (window.__LOGIN_SUBMIT_LOCK__) return 'locked';
   window.__LOGIN_SUBMIT_LOCK__ = true;
   const btn = document.querySelector(s.btn);
   if (btn) { try { btn.click(); } catch(_){} return 'clicked'; }
   return 'no-btn';
 })(${JSON.stringify(sels)})
 `,
    true
  );
  if (submitRes === "clicked" || submitRes === "locked") {
    uiLog("🟢 Đã gửi đăng nhập (click nút).");
  } else {
    try {
      const p = document.querySelector(sels.pass);
      if (p) p.focus();
    } catch (_) {}
    try {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      uiLog("🟢 Đã gửi đăng nhập (Enter).");
    } catch (_) {}
  }
  const navOk = await waitForNavigationOrStop(win, 8000);
  if (!navOk.ok)
    return {
      ok: false,
      msg: "Đăng nhập thất bại (không có điều hướng xảy ra).",
    };
  return { ok: true };
}

// ===== CHỈ KIỂM TRA ĐĂNG NHẬP THỦ CÔNG BẰNG LINK "ログアウト" =====
async function hasLogoutLink(win) {
  try {
    return await win.webContents.executeJavaScript(
      `
 Array.from(document.querySelectorAll('a')).some(a => ((a.innerText||'').trim().includes('ログアウト')))
 `,
      true
    );
  } catch (_) {
    return false;
  }
}
/**
 * Chờ người dùng tự đăng nhập: chỉ kiểm tra link “logout” (selector vẫn dùng chữ Nhật).
 * Không timeout cứng; ghi log “đang chờ…” mỗi 30s, kiểm tra mỗi 2s.
 */
async function waitForUserManualLogin(win) {
  uiLog(
    "🔶 Đăng nhập thất bại (có thể do CAPTCHA hoặc sai thông tin). Vui lòng TỰ đăng nhập trên Tab1. Ứng dụng sẽ chờ…"
  );
  let lastLog = Date.now();
  while (!KEEP.aborted && !win.isDestroyed()) {
    const ok = await hasLogoutLink(win);
    if (ok) {
      uiLog(
        "🟢 Phát hiện trạng thái đăng nhập (đã thấy liên kết logout). Tiếp tục quy trình…"
      );
      return true;
    }
    if (Date.now() - lastLog > 30000) {
      uiLog("⏳ Đang chờ bạn đăng nhập…");
      lastLog = Date.now();
    }
    await sleep(2000);
  }
  return false;
}
// Chờ điều hướng hoặc dừng tải
function waitForNavigationOrStop(win, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ ok: false });
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        win.webContents.removeListener("did-navigate", onNav);
        win.webContents.removeListener("did-navigate-in-page", onNav);
        win.webContents.removeListener("did-stop-loading", onStop);
      } catch (_) {}
    };
    const onNav = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onStop = () => {
      cleanup();
      resolve({ ok: true });
    };
    win.webContents.once("did-navigate", onNav);
    win.webContents.once("did-navigate-in-page", onNav);
    win.webContents.once("did-stop-loading", onStop);
    setTimeout(() => {
      cleanup();
      resolve({ ok: false });
    }, timeoutMs);
  });
}

// ===== Helpers sản phẩm: ĐẶT SỐ LƯỢNG & Thêm giỏ =====
async function setQuantityAndAddToCart(win, quantity) {
  const script = `
 (function(){
   const sel = document.querySelector('select[data-cart-quantity="select"]');
   if (sel) {
     let ok = false;
     for (let i=0;i<sel.options.length;i++){
       const opt = sel.options[i];
       const val = (opt.value||'').trim(); const txt = (opt.textContent||'').trim();
       if (val===String(${JSON.stringify(
         quantity
       )}) || txt===String(${JSON.stringify(
    quantity
  )})) { sel.selectedIndex=i; ok=true; break; }
     }
     sel.dispatchEvent(new Event('change',{bubbles:true}));
   }
   const els = Array.from(document.querySelectorAll('button[data-supplier-id][data-should-show-modal]'));
   const t = els.find(el => (el.innerText||'').includes('カゴに入れる') || (el.value||'').includes('カゴに入れる'));
   if (t){ t.scrollIntoView({behavior:'smooth',block:'center'}); t.click(); return true; }
   return false;
 })();
 `;
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (_) {
    return false;
  }
}
async function highlightConfirmButton(win) {
  const script = `
 (function(){
   const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
   const t = els.find(el => (el.innerText||'').includes('ご注文確定') || (el.value||'').includes('ご注文確定'));
   if (t){ t.style.outline='3px solid #10b981'; t.style.boxShadow='0 0 0 4px rgba(16,185,129,0.3)'; t.scrollIntoView({behavior:'smooth',block:'center'}); return true; }
   return false;
 })();
 `;
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (_) {
    return false;
  }
}
async function isAddToCartPresent(win) {
  try {
    return await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button,a,input[type="button"]')).some(el => (el.innerText||'').includes('カゴに入れる')||(el.value||'').includes('カゴに入れる'))`,
      true
    );
  } catch (_) {
    return false;
  }
}
async function waitForSelector(
  win,
  selector,
  timeoutMs = WAIT_SELECTOR_TIMEOUT
) {
  const script = `
 (function(sel, timeoutMs){
   return new Promise((resolve) => {
     const start = performance.now();
     function tick(){
       try { if (document.querySelector(sel)) return resolve(true); } catch (_) {}
       if (performance.now() - start >= timeoutMs) return resolve(false);
       setTimeout(tick, 100);
     }
     tick();
   });
 })(${JSON.stringify(selector)}, ${timeoutMs});
 `;
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (_) {
    return false;
  }
}
async function navigateAndEnsureLoaded(win, url) {
  try {
    await win.loadURL(url);
  } catch (e) {
    uiLog(`⚠️ Tải trang thất bại: ${e.message || e}`);
  }
  await sleep(PRODUCT_LOAD_DELAY_MS);
}
async function reloadAndWaitForSelector(
  win,
  selector,
  timeoutMs = WAIT_SELECTOR_TIMEOUT,
  urlIfNeeded = null
) {
  if (urlIfNeeded) {
    try {
      await win.loadURL(urlIfNeeded);
    } catch (_) {}
  }
  uiLog("🔁 Tab1: Đang tải lại trang sản phẩm…");
  const t0 = Date.now();
  try {
    await win.reload();
  } catch (_) {}
  const ok = await waitForSelector(win, selector, timeoutMs);
  const elapsed = Date.now() - t0;
  uiLog(
    ok
      ? `🟢 Tab1: Tải lại xong (${elapsed}ms) → đã thấy nút`
      : `🔍 Tab1: Tải lại xong (${elapsed}ms) → chưa thấy nút`
  );
  return ok;
}

// ===== Vòng Tab2 (giữ nguyên logic, không liên quan CAPTCHA) =====
async function startTab2Loop(tab2) {
  KEEP.tab2LoopAbort = false;
  let cycle = 0;
  while (!KEEP.aborted && !KEEP.tab2LoopAbort && !tab2.isDestroyed()) {
    cycle++;
    try {
      uiLog(
        `🟣 Tab2: Vòng #${cycle} humanize (~${Math.round(
          TAB2_HUMANIZE_MS / 1000
        )}s)`
      );
      await humanizeScroll(tab2, TAB2_HUMANIZE_MS);
      if (KEEP.aborted || KEEP.tab2LoopAbort || tab2.isDestroyed()) break;
      uiLog(`🔁 Tab2: Vòng #${cycle} – tải lại`);
      const t0 = Date.now();
      try {
        await tab2.reload();
      } catch (_) {}
      const hit = await isAddToCartPresent(tab2);
      const elapsed = Date.now() - t0;
      if (hit) {
        uiLog(
          `🟢 Tab2: Vòng #${cycle} – đã thấy nút thêm vào giỏ (${elapsed}ms)`
        );
        await triggerTab1PurchaseAfterDetection();
        KEEP.tab2LoopAbort = true;
        break;
      } else {
        uiLog(`🔍 Tab2: Vòng #${cycle} – chưa thấy (${elapsed}ms)`);
      }
    } catch (e) {
      uiLog(`⚠️ Tab2: Lỗi vòng #${cycle}: ${e?.message || "không rõ"}`);
    }
    await sleep(1000);
  }
}

// ===== Dừng =====
async function stopAll(silent = false) {
  KEEP.aborted = true;
  KEEP.tab2LoopAbort = true;
  FLOW.starting = false;
  FLOW.inFailover = false;
  if (KEEP.keepAlive1) {
    try {
      clearInterval(KEEP.keepAlive1);
    } catch (_) {}
    KEEP.keepAlive1 = null;
  }
  try {
    if (TAB.tab2 && !TAB.tab2.isDestroyed()) {
      TAB.tab2.webContents.removeAllListeners();
      TAB.tab2.close();
    }
  } catch (_) {}
  TAB.tab2 = null;
  try {
    if (TAB.tab1 && !TAB.tab1.isDestroyed()) {
      TAB.tab1.webContents.removeAllListeners();
      TAB.tab1.close();
    }
  } catch (_) {}
  TAB.tab1 = null;
  if (!silent) uiDone();
}

// ===== Mua sau khi Tab2 phát hiện =====
async function triggerTab1PurchaseAfterDetection() {
  if (KEEP.aborted || !TAB.tab1 || TAB.tab1.isDestroyed() || !FLOW.cfg) return;
  wireDialogSuppressEvents(TAB.tab1);
  attachAutoAcceptJsDialogs(TAB.tab1);
  scheduleRepeatedOverrideAlerts(TAB.tab1, 15000, 1000);
  uiLog("🔵 Tab1: Tải lại trang sản phẩm và chờ nút xuất hiện…");
  const ready = await reloadAndWaitForSelector(
    TAB.tab1,
    'button, a, input[type="button"]',
    WAIT_SELECTOR_TIMEOUT,
    FLOW.cfg.productUrl
  );
  if (!ready) {
    uiLog("⚠️ Đã chờ nhưng không thấy nút.");
    return;
  }
  const hasCart = await isAddToCartPresent(TAB.tab1);
  if (!hasCart) {
    uiLog("⚠️ Không phát hiện nút thêm vào giỏ.");
    return;
  }
  const added = await setQuantityAndAddToCart(TAB.tab1, FLOW.cfg.quantity);
  if (added)
    uiLog(`🟢 Đã đặt số lượng (${FLOW.cfg.quantity}) và bấm nút thêm vào giỏ.`);
  else
    uiLog(
      `⚠️ Không thể đặt số lượng chính xác (${FLOW.cfg.quantity}). Vẫn thử bấm nút thêm vào giỏ.`
    );
  try {
    await TAB.tab1.loadURL(FLOW.cfg.confirmUrl);
    uiLog("🔵 Chuyển sang trang xác nhận (tự OK dialog).");
  } catch (_) {}
  await sleep(800);
  const clickedConfirm = await clickConfirmButton(TAB.tab1);
  uiLog(
    clickedConfirm.ok
      ? "🟢 Đã bấm nút xác nhận đơn hàng."
      : `⚠️ Không thể bấm: ${clickedConfirm.reason || "không rõ"}`
  );
  KEEP.tab2LoopAbort = true;
  uiDone();
}

// ===== Mua trực tiếp khi Tab1 sẵn sàng =====
async function triggerTab1PurchaseFlow() {
  if (KEEP.aborted || !TAB.tab1 || TAB.tab1.isDestroyed() || !FLOW.cfg) return;
  wireDialogSuppressEvents(TAB.tab1);
  attachAutoAcceptJsDialogs(TAB.tab1);
  await navigateAndEnsureLoaded(TAB.tab1, FLOW.cfg.productUrl);
  uiLog("🔵 Tab1: Đã chuyển sang trang sản phẩm.");
  const added = await setQuantityAndAddToCart(TAB.tab1, FLOW.cfg.quantity);
  if (added)
    uiLog(`🟢 Đã đặt số lượng (${FLOW.cfg.quantity}) và bấm nút thêm vào giỏ.`);
  else
    uiLog(
      `⚠️ Không thể đặt số lượng chính xác (${FLOW.cfg.quantity}). Vẫn thử bấm nút thêm vào giỏ.`
    );
  try {
    await TAB.tab1.loadURL(FLOW.cfg.confirmUrl);
    uiLog("🔵 Chuyển sang trang xác nhận (tự OK dialog).");
  } catch (_) {}
  await sleep(800);
  const clickedConfirm = await clickConfirmButton(TAB.tab1);
  uiLog(
    clickedConfirm.ok
      ? "🟢 Đã bấm nút xác nhận đơn hàng."
      : `⚠️ Không thể bấm: ${clickedConfirm.reason || "không rõ"}`
  );
  uiDone();
}

// ===== Start Flow =====
async function startRunFlow() {
  if (FLOW.starting) return;
  FLOW.starting = true;
  try {
    KEEP.aborted = false;
    KEEP.tab2LoopAbort = false;

    const raw = currentProxyRaw();
    FLOW.directMode = !raw;

    // --- Tab1: mở trang đăng nhập với cơ chế giảm CAPTCHA ---
    if (FLOW.directMode) {
      uiLog(
        "🟢 Không có proxy. Sử dụng kết nối trực tiếp (dùng IP môi trường hiện tại)."
      );
      TAB.tab1 = await createWindowDirect(FLOW.cfg.loginUrl, "Tab1: Đăng nhập");
    } else {
      // có proxy: kiểm tra + retry trước khi chạy
      let t = { ok: false, ip: "" };
      try {
        t = await testWithHttpProxy(parseProxyFlexible(raw));
      } catch (e) {
        uiLog(`❌ Kiểm tra proxy thất bại: ${e.message}`);
      }
      if (!t.ok) {
        uiLog(
          "🟠 Kiểm tra proxy khi khởi động thất bại. Sẽ thử lại 2 lần, cách 10s…"
        );
        const recovered = await retryCurrentProxyWithDelay(
          PROXY_MAX_RETRIES,
          PROXY_RETRY_DELAY_MS
        );
        if (!recovered) {
          await switchToNextProxyAndRestart("Kiểm tra khi khởi động thất bại");
          return;
        } else {
          uiLog("🟢 Proxy đã phục hồi, tiếp tục khởi động.");
        }
      }
      TAB.tab1 = await createWindowWithProxy(
        FLOW.cfg.loginUrl,
        raw,
        "Tab1: Đăng nhập"
      );
      observeProxyErrors(TAB.tab1, "Tab1");
    }

    uiLog("🔵 Tab1: Mở trang đăng nhập…");

    // --- KHÔNG gắn auto-accept JS dialog trước login để giảm tín hiệu automation ---
    // Thử đăng nhập tự động
    const loginRes = await doExactLogin(
      TAB.tab1,
      FLOW.cfg.username,
      FLOW.cfg.password
    );
    if (!loginRes.ok) {
      uiLog(`⚠️ Đăng nhập tự động thất bại: ${loginRes.msg || "không rõ"}`);
      const okManual = await waitForUserManualLogin(TAB.tab1);
      if (!okManual) {
        uiLog("❌ Không thể tiếp tục do chưa đăng nhập.");
        uiDone();
        return;
      }
    } else {
      uiLog("🟢 Đã gửi đăng nhập tự động. Kiểm tra trạng thái…");
      let logged = false;
      for (let i = 0; i < LOGIN_RETRIES; i++) {
        if (KEEP.aborted) break;
        await sleep(LOGIN_WAIT_MS);
        logged = await hasLogoutLink(TAB.tab1);
        if (logged) break;
      }
      if (!logged) {
        uiLog(
          "⚠️ Không xác nhận được đăng nhập tự động. Vui lòng TỰ đăng nhập trên Tab1. Ứng dụng sẽ chờ…"
        );
        const okManual = await waitForUserManualLogin(TAB.tab1);
        if (!okManual) {
          uiLog("❌ Không thể tiếp tục do chưa đăng nhập.");
          uiDone();
          return;
        }
      }
    }

    uiLog("🟢 Đã xác nhận đăng nhập (đã thấy liên kết logout). Tiếp tục…");
    await navigateAndEnsureLoaded(TAB.tab1, FLOW.cfg.productUrl);
    uiLog("🔵 Tab1: Đã chuyển sang trang sản phẩm.");
    await logCurrentProxy(TAB.tab1, "Tab1");
    const hasCart = await isAddToCartPresent(TAB.tab1);
    if (hasCart) {
      uiLog("🟢 Đã thấy nút thêm vào giỏ. Tiến hành mua.");
      await triggerTab1PurchaseFlow();
    } else {
      uiLog("🟡 Chưa thấy nút thêm vào giỏ. Mở Tab2 để theo dõi.");
      await startTab2AfterTab1Ready(FLOW.directMode ? null : raw);
    }

    // Sau login mới gắn suppress dialogs (tránh dấu hiệu bất thường lúc login)
    if (TAB.tab1 && !TAB.tab1.isDestroyed()) {
      wireDialogSuppressEvents(TAB.tab1);
      attachAutoAcceptJsDialogs(TAB.tab1);
    }
  } finally {
    FLOW.starting = false;
  }
}

async function startTab2AfterTab1Ready(rawProxy) {
  KEEP.keepAlive1 = setInterval(async () => {
    if (KEEP.aborted) return;
    try {
      await TAB.tab1.reload();
    } catch (_) {}
    randomMouseMove(TAB.tab1, 3);
  }, 5 * 60 * 1000);
  TAB.tab1.on("closed", () => {
    if (KEEP.keepAlive1) {
      clearInterval(KEEP.keepAlive1);
      KEEP.keepAlive1 = null;
    }
  });

  const partition = "persist:askul-tab2"; // cố định cho Tab2
  if (FLOW.directMode || !rawProxy) {
    TAB.tab2 = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Tab2: Theo dõi (ẩn danh)",
      webPreferences: {
        partition,
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        nativeWindowOpen: false,
      },
    });
    TAB.tab2.webContents.setUserAgent(app.userAgentFallback);
    const ses2 = session.fromPartition(partition);
    await ses2.setProxy({ mode: "direct" });
    await TAB.tab2.loadURL(FLOW.cfg.productUrl);
  } else {
    const p = parseProxyFlexible(rawProxy);
    TAB.tab2 = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Tab2: Theo dõi (ẩn danh)",
      webPreferences: {
        partition,
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        nativeWindowOpen: false,
      },
    });
    TAB.tab2.webContents.setUserAgent(app.userAgentFallback);
    const ses2 = session.fromPartition(partition);
    await ses2.setProxy({ proxyRules: proxyRulesFromRaw(p) });
    await TAB.tab2.loadURL(FLOW.cfg.productUrl);
  }
  observeProxyErrors(TAB.tab2, "Tab2");
  uiLog("🟣 Tab2: Bắt đầu theo dõi (cuộn ~5s → tải lại → kiểm tra).");
  await logCurrentProxy(TAB.tab2, "Tab2");
  await startTab2Loop(TAB.tab2);
}

// ===== IPC: cấu hình & chạy/dừng =====
ipcMain.handle("config:import", async () => {
  const ret = await dialog.showOpenDialog({
    title: "Chọn file cấu hình",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (ret.canceled || !ret.filePaths?.length)
    return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(ret.filePaths[0], "utf-8");
    return { ok: true, config: JSON.parse(raw), path: ret.filePaths[0] };
  } catch (e) {
    return { ok: false, error: `Lỗi đọc file: ${e.message}` };
  }
});
ipcMain.handle("config:getSaveDir", async () => ({
  path: readMeta().saveDir || USER_DATA_DIR(),
}));
ipcMain.handle("config:selectSaveDir", async () => {
  const ret = await dialog.showOpenDialog({
    title: "Chọn thư mục lưu",
    properties: ["openDirectory", "createDirectory"],
  });
  if (ret.canceled || !ret.filePaths?.length)
    return { ok: false, canceled: true };
  const m = readMeta();
  m.saveDir = ret.filePaths[0];
  if (!writeMeta(m))
    return { ok: false, error: "Không lưu được thư mục đích." };
  return { ok: true, path: ret.filePaths[0] };
});
ipcMain.handle("config:saveAs", async (_e, fileName, config) => {
  if (!fileName || typeof fileName !== "string")
    throw new Error("Hãy nhập tên file.");
  let base = fileName.trim();
  if (!/^[a-zA-Z0-9._-]+(\.json)?$/.test(base))
    throw new Error("Tên file không hợp lệ.");
  if (!base.endsWith(".json")) base += ".json";
  const dir = readMeta().saveDir || USER_DATA_DIR();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, base),
    JSON.stringify(config || {}, null, 2),
    "utf-8"
  );
  return { ok: true, path: path.join(dir, base) };
});
// alias: giữ nếu UI cũ còn gọi
ipcMain.handle("proxy:test", async (_e, proxyRaw) => {
  try {
    const p = parseProxyFlexible(proxyRaw);
    const t = await testWithHttpProxy(p);
    if (t.ok) return { ok: true, ip: t.ip };
    return { ok: false, error: "Kiểm tra proxy thất bại." };
  } catch (e) {
    return { ok: false, error: `Kiểm tra proxy thất bại: ${e.message}` };
  }
});
ipcMain.handle("action:stop", async () => {
  uiLog("⛔ Đã nhận yêu cầu dừng. Tiến hành dừng…");
  await stopAll(false);
  return { ok: true };
});
ipcMain.handle("action:run", async (_event, cfg) => {
  FLOW.cfg = cfg;
  FLOW.proxyIndex = 0;
  await startRunFlow();
  return { ok: true };
});
ipcMain.handle("action:saveAndRun", async (_event, fileName, cfg) => {
  if (!fileName || typeof fileName !== "string")
    throw new Error("Hãy nhập tên file.");
  let base = fileName.trim();
  if (!/^[a-zA-Z0-9._-]+(\.json)?$/.test(base))
    throw new Error("Tên file không hợp lệ.");
  if (!base.endsWith(".json")) base += ".json";
  const dir = readMeta().saveDir || USER_DATA_DIR();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, base),
    JSON.stringify(cfg || {}, null, 2),
    "utf-8"
  );
  FLOW.cfg = cfg;
  FLOW.proxyIndex = 0;
  await startRunFlow();
  return { ok: true, path: path.join(dir, base) };
});

// ===== Vô hiệu dialog JS trên trang (fallback) =====
// LỚP 1: Override trong trang
async function overrideAlerts(win) {
  const script = `
 (function(){
   try {
     const safe = (fn, fallback) => { try { return fn(); } catch(_) { return fallback; } };
     window.alert = (msg) => { console.log('[alert suppressed]', msg); };
     window.confirm = (msg) => { console.log('[confirm auto-OK]', msg); return true; };
     window.prompt = (msg, def) => { console.log('[prompt auto]', msg); return def || ''; };
     try { window.onbeforeunload = null; } catch(_) {}
     const iframes = safe(()=>Array.from(document.querySelectorAll('iframe')), []);
     for (const f of iframes) {
       const w = safe(()=>f.contentWindow, null);
       if (!w) continue;
       try {
         w.alert = (msg) => { console.log('[alert suppressed - iframe]', msg); };
         w.confirm = (msg) => { console.log('[confirm auto-OK - iframe]', msg); return true; };
         w.prompt = (msg, def) => { console.log('[prompt auto - iframe]', msg); return def || ''; };
         try { w.onbeforeunload = null; } catch(_) {}
       } catch (_) {}
     }
     return true;
   } catch(e) { return false; }
 })();
 `;
  try {
    await win.webContents.executeJavaScript(script, true);
  } catch (_) {}
}
// LỚP 2: Gắn lại override theo sự kiện (chống gắn lặp)
function wireDialogSuppressEvents(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (wc.__wiredAlerts) return;
  wc.__wiredAlerts = true;
  const reapply = () => {
    try {
      overrideAlerts(win);
    } catch (_) {}
  };
  wc.on("dom-ready", reapply);
  wc.on("did-frame-navigate", reapply);
  wc.on("did-navigate", reapply);
  wc.on("did-navigate-in-page", reapply);
}
// LỚP 3: Reinjection lặp lại
const __alertTimers = new WeakMap();
function scheduleRepeatedOverrideAlerts(
  win,
  durationMs = 15000,
  periodMs = 1000
) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const old = __alertTimers.get(wc);
  if (old) {
    try {
      clearInterval(old);
    } catch (_) {}
  }
  const start = Date.now();
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    try {
      overrideAlerts(win);
    } catch (_) {}
    if (Date.now() - start >= durationMs) {
      clearInterval(timer);
    }
  }, periodMs);
  __alertTimers.set(wc, timer);
}

// ===== CDP: tự động OK dialog JS trên Tab1 (gắn sau login) =====
function attachAutoAcceptJsDialogs(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const attachOnce = () => {
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.2");
    } catch (err) {
      uiLog(`⚠️ DevTools attach lỗi: ${err.message}`);
      return;
    }
    dbg.sendCommand("Page.enable").catch(() => {});
    if (dbg.__wiredJSDlg) return;
    dbg.__wiredJSDlg = true;
    dbg.on("message", async (_event, method) => {
      if (method === "Page.javascriptDialogOpening") {
        try {
          await dbg.sendCommand("Page.handleJavaScriptDialog", {
            accept: true,
            promptText: "",
          });
          uiLog("🟢 Đã tự động OK hộp thoại JS.");
        } catch (e) {
          uiLog(`⚠️ Lỗi tự động xử lý hộp thoại JS: ${e.message}`);
        }
      }
    });
  };
  attachOnce();
  wc.on("dom-ready", attachOnce);
  wc.on("did-frame-navigate", attachOnce);
  wc.on("did-navigate", attachOnce);
  wc.on("did-navigate-in-page", attachOnce);
}

// ===== (Tuỳ chọn) Nhấn nút xác nhận đơn hàng tự động =====
async function clickConfirmButton(win) {
  const script = `
 (function(){
   const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
   const t = els.find(el => (el.innerText||'').includes('ご注文確定') || (el.value||'').includes('ご注文確定'));
   if (!t) return { ok:false, reason:'Không tìm thấy nút xác nhận đơn hàng.' };
   try {
     t.scrollIntoView({behavior:'smooth',block:'center'});
     t.click();
     return { ok:true };
   } catch (e) {
     return { ok:false, reason: e?.message || 'Lỗi click không rõ' };
   }
 })();
 `;
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (_) {
    return { ok: false, reason: "Lỗi thực thi JS" };
  }
}
