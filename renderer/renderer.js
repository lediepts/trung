const els = {
  fileName: document.getElementById("fileName"),
  selectDirBtn: document.getElementById("selectDirBtn"),
  saveDir: document.getElementById("saveDir"),
  importBtn: document.getElementById("importBtn"),
  runBtn: document.getElementById("runBtn"),
  stopBtn: document.getElementById("stopBtn"),
  productId: document.getElementById("productId"),
  quantity: document.getElementById("quantity"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  proxies: document.getElementById("proxies"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  pvLoginUrl: document.getElementById("previewLoginUrl"),
  pvProductUrl: document.getElementById("previewProductUrl"),
  pvConfirmUrl: document.getElementById("previewConfirmUrl"),
};

// ===== HẰNG SỐ: URL xác nhận cố định (THAY GIÁ TRỊ PHÙ HỢP VỚI HỆ THỐNG) =====
const CONFIRM_URL = "https://www.askul.co.jp/odr/order/orderProcess/direct"; // TODO: thay bằng URL cố định thực tế

// Auto-scroll tới cuối mỗi lần ghi log
function appendLog(line) {
  const ts = new Date().toLocaleTimeString("vi-VN", { hour12: false });
  els.results.textContent += `[${ts}] ${line}\n`;
  els.results.scrollTop = els.results.scrollHeight;
}

// IPC log từ main
window.api.on("ui:log", (_ev, payload) => {
  if (payload?.message) appendLog(payload.message);
});
window.api.on("ui:done", () => {
  els.status.textContent = "✔ Hoàn tất";
});

// Hiển thị thư mục lưu hiện tại
(async () => {
  try {
    const { path } = await window.api.invoke("config:getSaveDir");
    els.saveDir.textContent = path || "";
  } catch (_) {}
})();

// Chọn thư mục lưu
els.selectDirBtn.addEventListener("click", async () => {
  const res = await window.api.invoke("config:selectSaveDir");
  if (res?.ok) els.saveDir.textContent = res.path;
});

// ---- Helpers: sinh URL từ mã sản phẩm ----
function sanitizeProductId(raw) {
  return (raw || "").trim().toUpperCase();
}
function computeUrlsFromProductId(productId) {
  const id = sanitizeProductId(productId);
  const productUrl = `https://www.askul.co.jp/p/${id}/`;
  const transition = encodeURIComponent(`/p/${id}/`);
  const loginUrl = `https://www.askul.co.jp/webapp/shops-club/servlet/YLogonSSLView?transitionURL=${transition}`;
  return { loginUrl, productUrl, id };
}
function extractProductIdFromUrl(url) {
  try {
    const m = String(url || "").match(/\/p\/([A-Z0-9]+)\//i);
    return m ? m[1].toUpperCase() : "";
  } catch (_) {
    return "";
  }
}
function updatePreview() {
  const { loginUrl, productUrl } = computeUrlsFromProductId(
    els.productId.value
  );
  els.pvLoginUrl.textContent = loginUrl || "";
  els.pvProductUrl.textContent = productUrl || "";
  els.pvConfirmUrl.textContent = CONFIRM_URL || "";
}

// Cập nhật preview khi nhập mã sản phẩm
els.productId.addEventListener("input", updatePreview);
updatePreview();

// Nhập cấu hình từ file (hỗ trợ cả cấu hình cũ & mới)
els.importBtn.addEventListener("click", async () => {
  const res = await window.api.invoke("config:import");
  if (res?.ok && res.config) {
    const c = res.config;

    // Ưu tiên productId mới; nếu không có, thử tách từ productUrl (cấu hình cũ)
    let pid = sanitizeProductId(c.productId);
    if (!pid && c.productUrl) pid = extractProductIdFromUrl(c.productUrl);

    if (!pid) {
      appendLog("❌ Cấu hình không có productId và không thể suy ra từ URL.");
      return;
    }

    els.fileName.value = res.path?.split("/").pop() || "config.json";
    els.productId.value = pid;
    els.quantity.value = String(c.quantity || 1);
    els.username.value = c.username || "";
    els.password.value = c.password || "";
    els.proxies.value = Array.isArray(c.proxies)
      ? c.proxies.join("\n")
      : c.proxies || "";

    updatePreview();
    appendLog("📥 Đã nhập cấu hình (đã suy ra URL từ mã sản phẩm).");
  } else if (res?.error) {
    appendLog(`❌ Lỗi nhập cấu hình: ${res.error}`);
  }
});

// Gom cấu hình: bản lưu (rút gọn) & bản chạy (đầy đủ URL + confirm)
function collectConfigs() {
  const proxies = (els.proxies.value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const productId = sanitizeProductId(els.productId.value);
  const { loginUrl, productUrl, id } = computeUrlsFromProductId(productId);

  const cfgForSave = {
    // LƯU RÚT GỌN: không URL, không confirmUrl
    productId: id,
    quantity: Number(els.quantity.value || 1),
    username: els.username.value,
    password: els.password.value,
    proxies,
  };

  const cfgForRun = {
    // CHẠY ĐẦY ĐỦ: có URL & confirmUrl (truyền trực tiếp sang main)
    loginUrl,
    productUrl,
    confirmUrl: CONFIRM_URL,
    quantity: Number(els.quantity.value || 1),
    username: els.username.value,
    password: els.password.value,
    proxies,
  };

  return { cfgForSave, cfgForRun };
}

// Lưu + Chạy (2 IPC: save rút gọn + run đầy đủ)
els.runBtn.addEventListener("click", async () => {
  const { cfgForSave, cfgForRun } = collectConfigs();
  const fileName = (els.fileName.value || "config.json").trim();

  try {
    els.status.textContent = "▶ Đang chạy…";

    // Lưu rút gọn (không có URL/confirm)
    const saveRes = await window.api.invoke(
      "config:saveAs",
      fileName,
      cfgForSave
    );
    if (saveRes?.ok) appendLog(`💾 Đã lưu cấu hình (rút gọn): ${saveRes.path}`);
    else appendLog(`❌ Lưu cấu hình thất bại: ${saveRes?.error || "không rõ"}`);

    // Chạy với config đầy đủ (có URL & confirm)
    const runRes = await window.api.invoke("action:run", cfgForRun);
    if (runRes?.ok)
      appendLog("▶ Bắt đầu chạy (đã truyền URL & confirm cố định cho main).");
    else appendLog(`❌ Lỗi chạy: ${runRes?.error || "không rõ"}`);
  } catch (e) {
    appendLog(`❌ Lỗi thực thi: ${e.message}`);
  }
});

// Dừng
els.stopBtn.addEventListener("click", async () => {
  const res = await window.api.invoke("action:stop");
  if (res?.ok) appendLog("⛔ Đã dừng.");
});
``;
