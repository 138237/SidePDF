\# pdf-mini / 悬浮 PDF 阅读器



A minimal floating PDF reader built with \*\*Electron + PDF.js\*\*.  

一个基于 \*\*Electron + PDF.js\*\* 的极简「悬浮/贴边收纳」PDF 阅读器。



`pdf-mini` is designed for reading PDFs in a small always-on-top window that can be docked to the screen edge and quickly revealed when needed.  

`pdf-mini` 适合在工作/学习时把 PDF 以小窗口置顶显示，贴边收纳，鼠标靠近触发区即可快速展开查看。



---



\## Features / 功能特性



\- 🪟 Always-on-top floating window / 置顶悬浮窗口

\- 📌 Edge dock + auto hide/show / 贴边收纳与自动展开/收回

\- 🖱️ Hover-to-reveal trigger zone / 鼠标触发区展开（避免整条边误触）

\- 🔍 PDF rendering powered by PDF.js / 基于 PDF.js 清晰渲染

\- 📂 Open local PDFs / 打开本地 PDF（快捷键）

\- ⚡ Lightweight \& framework-free / 轻量、无前端框架依赖



---



\## Project Structure / 项目结构（当前仓库）



> The viewer is served locally by an internal Express static server (started by Electron).  

> 查看器资源通过 Electron 内置的 Express 静态服务提供（启动程序时自动启动）。



```text

pdf-mini/

├─ pdf/            # Sample PDFs / 示例 PDF（可选）

├─ pdfjs/          # PDF.js distribution / pdf.js 与 worker 等文件

├─ viewer.html     # Viewer UI / 查看器页面

├─ viewer.js       # Viewer logic / 渲染逻辑

├─ main.js         # Electron main process / Electron 主进程

├─ package.json

├─ package-lock.json

├─ .gitignore

└─ README.md



