const { app, BrowserWindow, globalShortcut, dialog, screen } = require("electron");
const path = require("path");
const express = require("express");

let win;
let server;
let PORT = 0;
let clickThrough = false;

// ---- 自动收纳参数（可微调）----
const EDGE_PEEK = 10;           // 收纳时露出多少像素
const TRIGGER_DIST = 10;        // 鼠标距离屏幕边缘多少像素算“靠近边缘”
const MID_TRIGGER_RANGE = 10;   // ✅ 只在窗口中线上下多少像素才触发弹出
const HIDE_DELAY_MS = 50;      // 离开后多久收回
const CHECK_INTERVAL_MS = 120;  // 轮询鼠标位置频率

let dockMode = false;
let dockSide = "right";
let expandedBounds = null;      // ✅ 展开时位置大小（动态更新）
let expandedOpacity = 0.88;     // ✅ 展开时透明度（动态更新）
let collapsedOpacity = 0.18;    // 收纳时透明度（更隐蔽，可改）

let hideTimer = null;
let pollTimer = null;

// === pdf-mini 静态目录（与 pdf-float 同级）===
function getPdfMiniDir() {
  return path.join(__dirname, "..", "pdf-mini");
}

// ✅ 启动内置静态服务：viewer.html / pdfjs/ / pdf/ 都由它提供
async function startLocalServer() {
  const staticDir = getPdfMiniDir();
  const appServer = express();

  // 静态资源
  appServer.use(express.static(staticDir));

  // 允许通过一个固定 endpoint 打开“用户选择的 PDF”
  let selectedPdfPath = null;

  appServer.get("/__open_pdf", (req, res) => {
    if (!selectedPdfPath) return res.status(404).send("No PDF selected");
    res.sendFile(selectedPdfPath);
  });

  startLocalServer.setSelectedPdf = (p) => {
    selectedPdfPath = p;
  };

  return new Promise((resolve, reject) => {
    server = appServer.listen(0, "127.0.0.1", () => {
      PORT = server.address().port;
      resolve();
    });
    server.on("error", reject);
  });
}

function viewerUrlForDemo() {
  // pdf-mini/pdf/demo.pdf
  return `http://127.0.0.1:${PORT}/viewer.html?file=${encodeURIComponent(
    `http://127.0.0.1:${PORT}/pdf/demo.pdf`
  )}`;
}

function viewerUrlForSelectedPdf() {
  return `http://127.0.0.1:${PORT}/viewer.html?file=${encodeURIComponent(
    `http://127.0.0.1:${PORT}/__open_pdf`
  )}`;
}

async function choosePdfAndLoad() {
  const ret = await dialog.showOpenDialog(win, {
    title: "选择 PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });

  if (ret.canceled || !ret.filePaths?.[0]) return;

  startLocalServer.setSelectedPdf(ret.filePaths[0]);
  await win.loadURL(viewerUrlForSelectedPdf());
}

/* -------------------- 工具函数（收纳/弹出） -------------------- */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getWorkArea() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}

function isCollapsedNow() {
  if (!win || !expandedBounds) return false;
  const wa = getWorkArea();
  const b = win.getBounds();

  if (dockSide === "right") {
    const edgeX = wa.x + wa.width - EDGE_PEEK;
    return b.x >= edgeX - 2;
  } else {
    const edgeX = wa.x - b.width + EDGE_PEEK;
    return b.x <= edgeX + 2;
  }
}

// ✅ 保存“展开快照”：位置/大小/透明度
function snapshotExpandedState() {
  if (!win) return;
  if (!dockMode) return;
  if (isCollapsedNow()) return; // 避免收纳位置覆盖快照
  expandedBounds = win.getBounds();
  expandedOpacity = win.getOpacity();
}

function setDock(side) {
  dockSide = side;
  dockMode = true;

  const wa = getWorkArea();

  // 初次进入收纳模式时，如果还没有快照，用当前窗口作为展开快照
  if (!expandedBounds) {
    const [w, h] = win.getSize();
    expandedBounds =
      side === "right"
        ? { x: wa.x + wa.width - w - 8, y: wa.y + 80, width: w, height: h }
        : { x: wa.x + 8, y: wa.y + 80, width: w, height: h };
  }

  // 贴边展开并保存透明度
  win.setBounds(expandedBounds);
  expandedOpacity = win.getOpacity();

  startDockPolling();
}

function collapseToEdge() {
  if (!dockMode || !expandedBounds) return;

  // ✅ 收回前保存一次“收纳那一刻”的展开状态
  snapshotExpandedState();

  const wa = getWorkArea();
  const { width, height, y } = expandedBounds;

  if (dockSide === "right") {
    win.setBounds({
      x: wa.x + wa.width - EDGE_PEEK,
      y,
      width,
      height
    });
  } else {
    win.setBounds({
      x: wa.x - width + EDGE_PEEK,
      y,
      width,
      height
    });
  }

  win.setOpacity(collapsedOpacity);
}

function expandFromEdge() {
  if (!dockMode || !expandedBounds) return;
  win.setBounds(expandedBounds);
  win.setOpacity(expandedOpacity);
}

// ✅ 仅右侧“中线±10px”触发弹出（左侧逻辑也保留）
function cursorNearEdge() {
  const wa = getWorkArea();
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();

  if (dockSide === "right") {
    const nearEdge = p.x >= wa.x + wa.width - TRIGGER_DIST;
    if (!nearEdge) return false;

    const midY = b.y + b.height / 2;
    return p.y >= midY - MID_TRIGGER_RANGE && p.y <= midY + MID_TRIGGER_RANGE;
  } else {
    const nearEdge = p.x <= wa.x + TRIGGER_DIST;
    if (!nearEdge) return false;

    const midY = b.y + b.height / 2;
    return p.y >= midY - MID_TRIGGER_RANGE && p.y <= midY + MID_TRIGGER_RANGE;
  }
}

function cursorInsideWindow() {
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

function startDockPolling() {
  if (pollTimer) return;

  collapseToEdge();

  pollTimer = setInterval(() => {
    if (!win || !dockMode) return;

    // 点穿透时不自动弹出/收回（避免误弹）
    if (clickThrough) return;

    const near = cursorNearEdge();
    const inside = cursorInsideWindow();

    if (near) {
      clearTimeout(hideTimer);
      hideTimer = null;
      expandFromEdge();
      return;
    }

    if (!inside) {
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          collapseToEdge();
          hideTimer = null;
        }, HIDE_DELAY_MS);
      }
    } else {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }, CHECK_INTERVAL_MS);
}

function stopDockPolling() {
  dockMode = false;
  clearTimeout(hideTimer);
  hideTimer = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* -------------------- Electron -------------------- */

async function create() {
  // ✅ 关键：先起本地 server（替代你手动开的 http-server/conda）
  await startLocalServer();

  win = new BrowserWindow({
    width: 460,
    height: 360,
    x: 30,
    y: 80,
    show: false,

    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: true,

    webPreferences: {
      contextIsolation: true,
      sandbox: false
    }
  });

  win.once("ready-to-show", () => {
    win.setOpacity(expandedOpacity);
    win.show();
    win.focus();
  });

  // ✅ 默认先打开 demo（你也可以改成启动就弹选择框）
  await win.loadURL(viewerUrlForDemo());

  // ✅ 拖动/缩放窗口：实时更新快照（保证“收纳那一刻”能恢复）
  win.on("moved", () => dockMode && snapshotExpandedState());
  win.on("resized", () => dockMode && snapshotExpandedState());

  // ---------- 热键 ----------
  // 老板键：Ctrl+Alt+H
  globalShortcut.register("Control+Alt+H", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });

  // 点穿透：Ctrl+Alt+T
  globalShortcut.register("Control+Alt+T", () => {
    if (!win) return;
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });

    // 开启点穿透时，收纳模式保持收纳
    if (dockMode && clickThrough) collapseToEdge();
  });

  // 透明度：Ctrl+Alt+Up / Down（同步更新快照）
  globalShortcut.register("Control+Alt+Up", () => {
    if (!win) return;
    win.setOpacity(clamp(win.getOpacity() + 0.05, 0.1, 1));
    dockMode && snapshotExpandedState();
  });
  globalShortcut.register("Control+Alt+Down", () => {
    if (!win) return;
    win.setOpacity(clamp(win.getOpacity() - 0.05, 0.1, 1));
    dockMode && snapshotExpandedState();
  });

  // 贴边并进入收纳：Ctrl+Alt+Right / Left
  globalShortcut.register("Control+Alt+Right", () => {
    if (!win) return;
    setDock("right");
  });
  globalShortcut.register("Control+Alt+Left", () => {
    if (!win) return;
    setDock("left");
  });

  // 手动切换收纳模式：Ctrl+Alt+M
  globalShortcut.register("Control+Alt+M", () => {
    if (!win) return;
    if (dockMode) {
      expandFromEdge();
      stopDockPolling();
    } else {
      setDock("right");
    }
  });

  // ✅ 用户选择 PDF：Ctrl+O
  globalShortcut.register("Control+Alt+O", () => {
    if (!win) return;
    choosePdfAndLoad();
  });

  // 失焦淡出（不影响收纳透明度策略）
  win.on("blur", () => {
    if (!win) return;
    if (!dockMode && !clickThrough) win.setOpacity(0.25);
  });
  win.on("focus", () => {
    if (!win) return;
    if (!dockMode) win.setOpacity(expandedOpacity);
  });

  win.on("closed", () => (win = null));
}

app.whenReady().then(create);

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopDockPolling();
  if (server) server.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
