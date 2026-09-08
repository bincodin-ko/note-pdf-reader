/*
 * 데스크톱 앱 껍데기 (Electron)
 *
 * 하는 일은 세 가지뿐이다.
 *   1. 비어 있는 포트를 찾아 server.js를 앱 안에서 띄운다
 *   2. 그 주소를 창으로 연다
 *   3. 켤 때 Claude Code CLI가 있는지 확인하고, 없으면 안내한다
 *
 * server.js와 public/ 은 손대지 않는다. 터미널로 돌리던 것과 같은 코드가 그대로 돈다.
 */

const { app, BrowserWindow, dialog, shell, Menu } = require("electron");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");

let win = null;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function hasClaudeCli() {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 8000 }, (err) => resolve(!err));
  });
}

async function checkBackend() {
  // server.js와 같은 기준으로 판단해야 한다.
  // 키가 있다는 것만으로는 API 모드가 아니므로, 그때 CLI 확인을 건너뛰면
  // 실제로는 claude -p로 도는데 설치 안내만 사라져 "이유 없이 AI만 안 되는" 상태가 된다.
  const useApi = process.env.CLAUDE_USE_API === "1" && !!process.env.ANTHROPIC_API_KEY;
  if (useApi) return;                                 // API 모드면 CLI가 없어도 된다
  if (await hasClaudeCli()) return;

  const r = await dialog.showMessageBox({
    type: "info",
    title: "Claude Code가 필요합니다",
    message: "AI 정리 기능을 쓰려면 Claude Code를 설치하고 로그인해야 합니다.",
    detail:
      "터미널에서 아래 두 줄을 실행한 뒤 이 앱을 다시 켜세요.\n\n" +
      "  npm i -g @anthropic-ai/claude-code\n" +
      "  claude auth login\n\n" +
      "지금 그냥 써도 됩니다. PDF 열기·영역 선택·메모·내보내기는 모두 동작하고, " +
      "AI 정리만 나오지 않습니다.",
    buttons: ["설치 방법 보기", "그냥 쓰기"],
    defaultId: 1,
    cancelId: 1
  });

  if (r.response === 0) {
    shell.openExternal("https://code.claude.com/docs/en/overview");
  }
}

async function createWindow() {
  const port = await freePort();
  process.env.PORT = String(port);
  require("./server.js");                              // 앱 안에서 서버 기동

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#141d27",
    title: "오려둔 공책",
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  Menu.setApplicationMenu(null);                       // 기본 메뉴 숨김
  win.loadURL(`http://127.0.0.1:${port}`);

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
}

app.whenReady().then(async () => {
  await createWindow();
  checkBackend();                                      // 창을 먼저 띄우고 확인
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
