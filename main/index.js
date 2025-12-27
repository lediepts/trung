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
let FLOW = { cfg: null, proxyIndex: 0, starting: false, inFailover: false };

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

// ===== Tạo cửa sổ với Proxy =====
async function createWindowWithProxy(url, proxyString, title) {
  const p = parseProxyFlexible(proxyString);
  const partition = `persist:auto-${Date.now()}-${Math.random()}`;
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title,
    webPreferences: {
      partition,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setMaxListeners(30);

  const ses = session.fromPartition(partition);
  await ses.setProxy({ proxyRules: proxyRulesFromRaw(p) }); // đặt proxy TRƯỚC khi loadURL
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
async function createAnonWindowWithProxy(url, proxyString, title) {
  const p = parseProxyFlexible(proxyString);
  const partition = `anon-${Date.now()}-${Math.random()}`;
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title,
    webPreferences: {
      partition,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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

    const raw = currentProxyRaw();
    let ip = "";
    if (raw) {
      const p = parseProxyFlexible(raw);
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
      try {
        const res = await client.get(TEST_URL);
        ip = res?.data?.ip || "";
      } catch (_) {}
    }
    uiLog(`🔎 ${name}: Proxy=${proxyStr} / IP ngoài=${ip || "không rõ"}`);
  } catch (e) {
    uiLog(`⚠️ ${name}: Không lấy được thông tin proxy: ${e.message}`);
  }
}

// ===== Theo dõi lỗi Proxy =====
function observeProxyErrors(win, label) {
  if (!win) return;
  win.webContents.on("did-fail-load", (_ev, errorCode, errorDesc) => {
    const reason = errorDesc || String(errorCode || "");
    if (PROXY_ERRORS.some((k) => reason.includes(k)))
      switchToNextProxyAndRestart(`${label}: ${reason}`);
  });
  try {
    const ses = win.webContents.session;
    ses.webRequest.onErrorOccurred({ urls: ["*://*/*"] }, (details) => {
      const err = details.error || "";
      if (PROXY_ERRORS.some((k) => err.includes(k)))
        switchToNextProxyAndRestart(`${label}: ${err}`);
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
        el.dispatchEvent(new Event('input',  {bubbles:true}));
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
      })(${JSON.stringify(sels)}, ${JSON.stringify(
        loginUser
      )}, ${JSON.stringify(loginPass)})
    `,
      true
    );
    uiLog("🟡 Đã gán giá trị vào ô nhập (fallback).");
  }

  // Submit: ưu tiên nhấn nút ログイン; nếu không có nút thì Enter ở PASS (debounce)
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

// ===== CHỈ KIỂM TRA ĐĂNG NHẬP THỦ CÔNG BẰNG LINK “ログアウト” =====
async function hasLogoutLink(win) {
  try {
    return await win.webContents.executeJavaScript(
      `
      Array.from(document.querySelectorAll('a')).some(a => ((a.innerText || '').trim().includes('ログアウト')))
    `,
      true
    );
  } catch (_) {
    return false;
  }
}

/**
 * Chờ người dùng tự đăng nhập: chỉ kiểm tra link “ログアウト”.
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
        "🟢 Phát hiện trạng thái đăng nhập (đã thấy liên kết “ログアウト”). Tiếp tục quy trình…"
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

// ===== Helpers sản phẩm: ĐẶT SỐ LƯỢNG & Thêm giỏ (THEO SỬA CỦA ANH) =====
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
      const t   = els.find(el => (el.innerText||'').includes('カゴに入れる') || (el.value||'').includes('カゴに入れる'));
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

// ===== Vòng Tab2: humanize → reload → check =====
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
          `🟢 Tab2: Vòng #${cycle} – đã thấy “カゴに入れる” (${elapsed}ms)`
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
    uiLog("⚠️ Không phát hiện “カゴに入れる”.");
    return;
  }

  const added = await setQuantityAndAddToCart(TAB.tab1, FLOW.cfg.quantity);
  if (added)
    uiLog(`🟢 Đã đặt số lượng (${FLOW.cfg.quantity}) và bấm “カゴに入れる”.`);
  else
    uiLog(
      `⚠️ Không thể đặt số lượng chính xác (${FLOW.cfg.quantity}). Vẫn thử bấm “カゴに入れる”.`
    );

  try {
    await TAB.tab1.loadURL(FLOW.cfg.confirmUrl);
    uiLog("🔵 Chuyển sang trang xác nhận (tự OK dialog).");
  } catch (_) {}
  await sleep(800);

  // const okHL = await highlightConfirmButton(TAB.tab1);
  // uiLog(
  //   okHL
  //     ? "🟢 Đã tô nổi nút “ご注文確定”. Vui lòng xác nhận thủ công."
  //     : "⚠️ Không tìm thấy nút “ご注文確定”."
  // );

  // (Tuỳ chọn) Nhấn nút “ご注文確定” tự động:
  const clickedConfirm = await clickConfirmButton(TAB.tab1);
  uiLog(
    clickedConfirm.ok
      ? "🟢 Đã bấm “ご注文確定”."
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
    uiLog(`🟢 Đã đặt số lượng (${FLOW.cfg.quantity}) và bấm “カゴに入れる”.`);
  else
    uiLog(
      `⚠️ Không thể đặt số lượng chính xác (${FLOW.cfg.quantity}). Vẫn thử bấm “カゴに入れる”.`
    );

  try {
    await TAB.tab1.loadURL(FLOW.cfg.confirmUrl);
    uiLog("🔵 Chuyển sang trang xác nhận (tự OK dialog).");
  } catch (_) {}
  await sleep(800);

  // const okHL = await highlightConfirmButton(TAB.tab1);
  // uiLog(
  //   okHL
  //     ? "🟢 Đã tô nổi nút “ご注文確定”. Vui lòng xác nhận thủ công."
  //     : "⚠️ Không tìm thấy nút “ご注文確定”."
  // );

  // (Tuỳ chọn) Nhấn nút “ご注文確定” tự động:
  const clickedConfirm = await clickConfirmButton(TAB.tab1);
  uiLog(
    clickedConfirm.ok
      ? "🟢 Đã bấm “ご注文確定”."
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
    if (!raw) throw new Error("Danh sách proxy trống.");

    let t = { ok: false, ip: "" };
    try {
      t = await testWithHttpProxy(parseProxyFlexible(raw));
    } catch (e) {
      uiLog(`❌ Kiểm tra proxy thất bại: ${e.message}`);
    }
    if (!t.ok)
      return switchToNextProxyAndRestart("Kiểm tra khi khởi động thất bại");

    // Tab1: login qua proxy ngay từ đầu
    TAB.tab1 = await createWindowWithProxy(
      FLOW.cfg.loginUrl,
      raw,
      "Tab1: Đăng nhập"
    );
    observeProxyErrors(TAB.tab1, "Tab1");
    uiLog("🔵 Tab1: Mở trang đăng nhập…");

    // Thử đăng nhập tự động
    const loginRes = await doExactLogin(
      TAB.tab1,
      FLOW.cfg.username,
      FLOW.cfg.password
    );
    if (!loginRes.ok) {
      // Fallback: Báo người dùng tự đăng nhập và chờ đến khi thấy link ログアウト
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
        // Ở luồng mới, chỉ coi là logged khi có <a> “ログアウト”
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

    uiLog("🟢 Đã xác nhận đăng nhập (thấy liên kết “ログアウト”). Tiếp tục…");
    await navigateAndEnsureLoaded(TAB.tab1, FLOW.cfg.productUrl);
    uiLog("🔵 Tab1: Đã chuyển sang trang sản phẩm.");
    await logCurrentProxy(TAB.tab1, "Tab1");

    const hasCart = await isAddToCartPresent(TAB.tab1);
    if (hasCart) {
      uiLog("🟢 Đã thấy “カゴに入れる”. Tiến hành mua.");
      await triggerTab1PurchaseFlow();
    } else {
      uiLog("🟡 Chưa thấy “カゴに入れる”. Mở Tab2 để theo dõi.");
      await startTab2AfterTab1Ready(raw);
    }

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

  TAB.tab2 = await createAnonWindowWithProxy(
    FLOW.cfg.productUrl,
    rawProxy,
    "Tab2: Theo dõi (ẩn danh)"
  );
  observeProxyErrors(TAB.tab2, "Tab2");
  uiLog("🟣 Tab2: Bắt đầu theo dõi (humanize 5s → reload → check).");

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

// ===== LỚP 1: Override trong trang =====
async function overrideAlerts(win) {
  const script = `
    (function(){
      try {
        const safe = (fn, fallback) => { try { return fn(); } catch(_) { return fallback; } };

        // Thay thế alert/confirm/prompt ở frame hiện tại
        window.alert   = (msg) => { console.log('[alert suppressed]', msg); };
        window.confirm = (msg) => { console.log('[confirm auto-OK]', msg); return true; };
        window.prompt  = (msg, def) => { console.log('[prompt auto]', msg); return def || ''; };

        // Tắt beforeunload (nếu có)
        try { window.onbeforeunload = null; } catch(_) {}

        // Thử áp vào các iframe same-origin (nếu truy cập được)
        const iframes = safe(() => Array.from(document.querySelectorAll('iframe')), []);
        for (const f of iframes) {
          const w = safe(() => f.contentWindow, null);
          if (!w) continue;
          try {
            w.alert   = (msg) => { console.log('[alert suppressed - iframe]', msg); };
            w.confirm = (msg) => { console.log('[confirm auto-OK - iframe]', msg); return true; };
            w.prompt  = (msg, def) => { console.log('[prompt auto - iframe]', msg); return def || ''; };
            try { w.onbeforeunload = null; } catch(_) {}
          } catch (_) { /* cross-origin: bỏ qua */ }
        }
        return true;
      } catch(e) { return false; }
    })();
  `;
  try {
    await win.webContents.executeJavaScript(script, true);
  } catch (_) {}
}

// Gắn overrideAlerts vào các sự kiện phù hợp (có cờ chống gắn lặp)

// ===== LỚP 2: Gắn lại override theo sự kiện (chống gắn lặp) =====
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

// ===== LỚP 3: Reinjection lặp lại trong khung thời gian ngắn sau điều hướng =====
const __alertTimers = new WeakMap();
/**
 * Reinjection overrideAlerts() liên tục trong durationMs (mặc định 15s) mỗi periodMs (mặc định 1s).
 */
function scheduleRepeatedOverrideAlerts(
  win,
  durationMs = 15000,
  periodMs = 1000
) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;

  // Clear timer cũ nếu có
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

// ===== CDP: tự động OK dialog JS trên Tab1 =====

// ===== CDP: Tự động OK dialog JS (re-attach chắc chắn) =====
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
    if (dbg.__wiredJSDlg) return; // chống gắn lặp nhiều lần
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

  // Gắn ngay bây giờ
  attachOnce();

  // Re-attach khi điều hướng (nếu bị detach do chuyển trang)
  wc.on("dom-ready", attachOnce);
  wc.on("did-frame-navigate", attachOnce);
  wc.on("did-navigate", attachOnce);
  wc.on("did-navigate-in-page", attachOnce);
}

// ===== (Tuỳ chọn) Nhấn nút “ご注文確定” tự động =====
async function clickConfirmButton(win) {
  const script = `
    (function(){
      const els = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'));
      const t = els.find(el => (el.innerText||'').includes('ご注文確定') || (el.value||'').includes('ご注文確定'));
      if (!t) return { ok:false, reason:'Không tìm thấy nút “ご注文確定”.' };
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
``;
