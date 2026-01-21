(function () {
  const hud = document.getElementById("hud");
  const wrap = document.getElementById("wrap");

  function getFileUrl() {
    const sp = new URLSearchParams(location.search);
    return sp.get("file") || "./pdf/demo.pdf";
  }

  // 兼容你现在是 pdfjs/pdf.js（非模块版）
  const pdfjsLib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
  if (!pdfjsLib) {
    hud.textContent = "未检测到 pdf.js（pdfjsLib 不存在）";
    return;
  }

  // ✅ 指向 worker（关键）
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.js";

  async function render() {
    wrap.innerHTML = "";
    const fileUrl = getFileUrl();
    hud.textContent = "加载: " + fileUrl;

    const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
    const pdf = await loadingTask.promise;

    let scale = 1.35;
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      wrap.appendChild(canvas);

      await page.render({ canvasContext: ctx, viewport }).promise;

      hud.textContent = `第 ${pageNum}/${pdf.numPages} 页`;
    }
  }

  render().catch((e) => {
    console.error(e);
    hud.textContent = "渲染失败：" + (e && e.message ? e.message : e);
  });
})();
