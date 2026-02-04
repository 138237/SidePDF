(() => {
  const hud = document.getElementById("hud");
  const wrap = document.getElementById("wrap");

  function getFileUrl() {
    const sp = new URLSearchParams(location.search);
    return sp.get("file") || "./pdf/demo.pdf";
  }

  const fileUrl = getFileUrl();

  // ✅ 生成稳定的存储 key：只用 pathname+search，不用 origin（域名+端口）
  const FILE_KEY = (() => {
    try {
      const u = new URL(fileUrl, location.href);
      return u.pathname + u.search;
    } catch {
      return String(fileUrl || "");
    }
  })();

  const STORE_KEY = "sidepdf:lastpos:" + encodeURIComponent(FILE_KEY);

  const pdfjsLib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
  if (!pdfjsLib) {
    hud.textContent = "未检测到 pdf.js（pdfjsLib 不存在）";
    return;
  }

  // ✅ 尽量设置 worker（如果你目录里有 pdfjs/pdf.worker.js）
  try {
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.js";
    }
  } catch {}

  let pdfDoc = null;
  let totalPages = 0;

  let scale = 1.2; // 默认缩放，可被保存的 scale 覆盖

  const pageHolders = new Map();     // pageNum -> holder div
  const pageCanvases = new Map();    // pageNum -> canvas
  const rendered = new Set();        // 已渲染页
  const rendering = new Set();       // 正在渲染页
  const pageHeightsReady = new Set();// 已计算过高度的页（用于稳定 offsetTop）

  let saveTimer = null;
  let rafScheduled = false;

  // ---------------- storage ----------------
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      return obj;
    } catch {
      return null;
    }
  }

  function saveNow(payload) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch {}
  }

  function scheduleSave(payload) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(payload), 200);
  }

  // ---------------- helpers ----------------
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function getVisibleRange() {
    // 根据 scrollTop 推估可视范围对应的页（用 holder.offsetTop 判断更稳）
    const top = wrap.scrollTop;
    const bottom = top + wrap.clientHeight;

    // 找到第一个进入视口的页
    let first = 1;
    for (let p = 1; p <= totalPages; p++) {
      const h = pageHolders.get(p);
      if (!h) continue;
      const y = h.offsetTop;
      const hgt = h.offsetHeight || 1;
      if (y + hgt >= top) {
        first = p;
        break;
      }
    }

    // 找到最后一个进入视口的页
    let last = totalPages;
    for (let p = first; p <= totalPages; p++) {
      const h = pageHolders.get(p);
      if (!h) continue;
      const y = h.offsetTop;
      if (y > bottom) {
        last = Math.max(first, p - 1);
        break;
      }
    }

    return { first, last };
  }

  function getCurrentPageAndOffset() {
    // 找到离 scrollTop 最近的 holder
    const y = wrap.scrollTop;

    let bestPage = 1;
    let bestDist = Infinity;

    for (const [p, holder] of pageHolders.entries()) {
      const dist = Math.abs(holder.offsetTop - y);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = p;
      }
    }

    const holder = pageHolders.get(bestPage);
    const offset = holder ? Math.max(0, y - holder.offsetTop) : 0;

    return { page: bestPage, offset };
  }

  function updateHud(extra = "") {
    const { page } = getCurrentPageAndOffset();
    hud.textContent =
      `第 ${page}/${totalPages} 页 · ` +
      `Rendered ${rendered.size}/${totalPages} · ` +
      `Zoom ${(scale * 100).toFixed(0)}%` +
      (extra ? ` · ${extra}` : "");
  }

  // ---------------- build layout ----------------
  function createHolders() {
    wrap.innerHTML = "";
    pageHolders.clear();
    pageCanvases.clear();
    rendered.clear();
    rendering.clear();
    pageHeightsReady.clear();

    for (let p = 1; p <= totalPages; p++) {
      const holder = document.createElement("div");
      holder.className = "page-holder";
      holder.style.position = "relative";
      holder.style.width = "100%";
      holder.style.display = "flex";
      holder.style.justifyContent = "center";
      holder.style.marginBottom = "18px";
      holder.dataset.page = String(p);

      // 先放一个最低高度，避免 offsetTop 全是 0
      holder.style.minHeight = "240px";

      wrap.appendChild(holder);
      pageHolders.set(p, holder);
    }
  }

  // 计算页面高度（只算 viewport，不渲染），用于稳定 offsetTop
  async function ensureHeightsUpTo(pageNum) {
    const target = clamp(pageNum, 1, totalPages);
    for (let p = 1; p <= target; p++) {
      if (pageHeightsReady.has(p)) continue;
      try {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale });
        const holder = pageHolders.get(p);
        if (holder) {
          // 用 canvas 的样式规则（圆角/阴影在 canvas 上）所以 holder 只负责高度
          holder.style.minHeight = `${Math.ceil(vp.height)}px`;
        }
        pageHeightsReady.add(p);
      } catch {
        // ignore
      }
    }
  }

  // 背景计算全部页高度（不阻塞主流程）
  async function ensureAllHeightsInBackground() {
    for (let p = 1; p <= totalPages; p++) {
      if (pageHeightsReady.has(p)) continue;
      try {
        const page = await pdfDoc.getPage(p);
        const vp = page.getViewport({ scale });
        const holder = pageHolders.get(p);
        if (holder) holder.style.minHeight = `${Math.ceil(vp.height)}px`;
        pageHeightsReady.add(p);
      } catch {}
      // 让出主线程
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ---------------- render ----------------
  async function renderPage(pageNum) {
    if (!pdfDoc) return;
    if (pageNum < 1 || pageNum > totalPages) return;
    if (rendered.has(pageNum) || rendering.has(pageNum)) return;

    rendering.add(pageNum);

    try {
      const holder = pageHolders.get(pageNum);
      if (!holder) return;

      // 已经有 canvas 就不重复创建
      let canvas = pageCanvases.get(pageNum);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.display = "block";
        canvas.style.margin = "0 auto 0";
        canvas.style.background = "#fff";
        canvas.style.boxShadow = "0 6px 18px rgba(0,0,0,.18)";
        canvas.style.borderRadius = "6px";
        holder.appendChild(canvas);
        pageCanvases.set(pageNum, canvas);
      }

      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // 更新 holder 的高度（防止后续渲染挤压）
      holder.style.minHeight = `${Math.ceil(viewport.height)}px`;
      pageHeightsReady.add(pageNum);

      const ctx = canvas.getContext("2d", { alpha: false });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;

      await page.render({ canvasContext: ctx, viewport }).promise;

      rendered.add(pageNum);
      updateHud();
    } catch (e) {
      hud.textContent = "渲染失败：" + (e && e.message ? e.message : e);
    } finally {
      rendering.delete(pageNum);
    }
  }

  function renderAroundViewport() {
    if (!pdfDoc || totalPages <= 0) return;

    const { first, last } = getVisibleRange();
    const buffer = 8; // 可视范围上下多渲染几页
    const from = clamp(first - buffer, 1, totalPages);
    const to = clamp(last + buffer, 1, totalPages);

    for (let p = from; p <= to; p++) renderPage(p);

    updateHud();
  }

  // ---------------- restore ----------------
  async function restoreToSaved(saved) {
    if (!saved) return;

    // scale
    if (typeof saved.scale === "number" && saved.scale > 0.2 && saved.scale < 6) {
      scale = saved.scale;
    }

    const page = clamp(Number(saved.page || 1), 1, totalPages);
    const offset = Math.max(0, Number(saved.offset || 0));

    // ✅ 先把 1..page 的高度算出来，让 offsetTop 稳定
    await ensureHeightsUpTo(page);

    // ✅ 目标页先渲染出来（避免后续渲染把 scrollTop 顶回去）
    await renderPage(page);

    // ✅ 下一帧再滚动到目标位置（DOM 更稳）
    await new Promise((r) => requestAnimationFrame(r));
    const holder = pageHolders.get(page);
    if (holder) {
      wrap.scrollTop = holder.offsetTop + offset;
    }

    // 渲染附近页
    const R = 10;
    for (let p = clamp(page - R, 1, totalPages); p <= clamp(page + R, 1, totalPages); p++) {
      renderPage(p);
    }

    updateHud("restored");
  }

  // ---------------- events ----------------
  function onScroll() {
    if (!pdfDoc) return;

    // 记录阅读位置（页 + offset + scale）
    const { page, offset } = getCurrentPageAndOffset();
    scheduleSave({ page, offset, scale, ts: Date.now() });

    // 懒加载渲染（用 rAF 合并频繁 scroll）
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        renderAroundViewport();
      });
    }
  }

  // 可选：Ctrl + / - 缩放
  async function applyZoom(newScale) {
    newScale = clamp(newScale, 0.4, 4);
    if (Math.abs(newScale - scale) < 0.001) return;

    // 变更前先记录当前阅读点
    const { page, offset } = getCurrentPageAndOffset();
    scale = newScale;

    // 重建 holders & 重新计算高度（至少到当前页）
    createHolders();
    await ensureHeightsUpTo(page);

    // 恢复到原阅读点
    const holder = pageHolders.get(page);
    if (holder) wrap.scrollTop = holder.offsetTop + offset;

    // 保存
    saveNow({ page, offset, scale, ts: Date.now() });

    // 渲染当前视口附近
    renderAroundViewport();

    // 背景补全高度
    ensureAllHeightsInBackground();
  }

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      applyZoom(scale + 0.1);
    }
    if (e.ctrlKey && e.key === "-") {
      e.preventDefault();
      applyZoom(scale - 0.1);
    }
    if (e.ctrlKey && e.key === "0") {
      e.preventDefault();
      applyZoom(1.2);
    }
  });

  // ---------------- main ----------------
  async function main() {
    hud.textContent = "Loading…";

    const saved = loadSaved();

    try {
      const task = pdfjsLib.getDocument(fileUrl);
      pdfDoc = await task.promise;
      totalPages = pdfDoc.numPages;

      createHolders();

      // 背景补全高度（不阻塞）
      ensureAllHeightsInBackground();

      // ✅ 恢复阅读位置（关键）
      await restoreToSaved(saved);

      // ✅ 初次渲染视口附近
      renderAroundViewport();

      wrap.addEventListener("scroll", onScroll, { passive: true });
      updateHud();
    } catch (e) {
      hud.textContent = "加载失败：" + (e && e.message ? e.message : e);
    }
  }

  main();
})();
