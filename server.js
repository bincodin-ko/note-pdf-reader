/*
 * 로컬 개발 서버 (외부 패키지 없음, Node 18 이상)
 *
 * 하는 일 두 가지
 *  1) public/ 폴더를 http로 서비스한다
 *     - file:// 로 열면 PDF 워커와 저장소가 브라우저 보안 정책에 막힌다
 *  2) /api/ask 를 받아 Anthropic API로 대신 보낸다
 *     - 키를 브라우저 코드에 넣으면 배포하는 순간 누구나 볼 수 있고,
 *       Anthropic API는 브라우저의 직접 호출을 CORS로 막아둔다
 *     - 그래서 키는 이 파일(서버)에서만 쓰이고 브라우저로 내려가지 않는다
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const PORT = process.env.PORT || 5173;

/*
 * 어느 빌드를 돌리고 있는지 화면에서 확인할 수 있어야 한다.
 * 설치파일 이름만으로는 구분이 안 돼서, 같은 버전 위에 덮어 깔고도
 * 예전 앱을 보고 있는지 알 방법이 없었다.
 * 브라우저에서는 package.json을 읽을 수 없으므로 서버가 대신 내준다.
 */
let VERSION = "0.0.0";
try {
  VERSION = require("./package.json").version || VERSION;
} catch (e) { /* 못 읽어도 앱은 돌아야 한다 */ }
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PUBLIC = path.join(__dirname, "public");

/*
 * 모드는 키 유무가 아니라 CLAUDE_USE_API로만 정한다.
 *
 * 예전에는 ANTHROPIC_API_KEY가 있으면 자동으로 API 경로를 탔는데,
 * 그러면 셸이나 .env에 키가 굴러다니는 것만으로 모르는 사이 과금 경로로 샌다.
 * 기본은 구독(claude -p)이고, 돈 나가는 쪽은 반드시 명시적으로 켜야 한다.
 */
const USE_API = process.env.CLAUDE_USE_API === "1";
const KEY = USE_API ? process.env.ANTHROPIC_API_KEY : undefined;   // API 모드일 때만 키를 읽는다

// API를 켜라고 했는데 키가 없으면 죽이지 않고 구독으로 되돌린다.
// 수업 중에 쓰는 도구라 오타 하나로 서버가 안 뜨는 쪽이 더 나쁘다. 대신 시끄럽게 알린다.
const API_NO_KEY = USE_API && !KEY;
const USE_CLI = !USE_API || API_NO_KEY;
const MODE = USE_CLI ? "cli" : "api";
const MODE_LABEL = USE_CLI
  ? "Claude Code CLI (구독으로 처리)"
  : "Anthropic API · 모델 " + MODEL;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "X-Capnote-Mode": MODE          // 어느 경로로 답했는지 응답만 봐도 알 수 있게
  });
  res.end(body);
}

/*
 * 경로 B: Claude Code CLI (구독으로 처리, API 키 불필요)
 *
 * 이미지는 인자로 못 넘기므로 임시 파일로 떨군 뒤 경로를 프롬프트에 적어 준다.
 * Claude Code가 Read 도구로 그 파일을 직접 읽는다.
 */

const IS_WIN = process.platform === "win32";

/*
 * GUI로 띄운 앱은 로그인 셸의 PATH를 물려받지 않는다.
 * 터미널에서는 claude가 잡히는데 앱에서만 "설치 안 됨"이 되는 게 이 때문이다.
 * npm 전역과 흔한 설치 경로를 보태준다.
 */
function envForClaude() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;          // 구독 자격으로 붙게 한다

  if (!IS_WIN) {
    const home = os.homedir();
    const extra = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".npm-global/bin"),
      path.join(home, ".local/bin"),
      path.join(home, ".volta/bin")
    ];
    env.PATH = (env.PATH || "") + ":" + extra.join(":");
  }
  return env;
}

/*
 * claude를 띄우고 프롬프트를 stdin으로 넘긴다.
 *
 * 인자로 넘기지 않는 이유가 두 가지다.
 *   - Windows 명령줄은 8191자에서 잘린다. 원문 텍스트만 2500자까지 들어간다
 *   - shell을 거치면 프롬프트 안의 따옴표가 명령을 망가뜨린다
 * stdin으로 주면 둘 다 사라진다.
 *
 * shell은 Windows에서만 켠다. npm 전역 설치본이 claude.cmd인데
 * Node는 보안 수정 이후 shell 없이 .cmd를 띄우지 못한다.
 */
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--allowedTools", "Read", "--max-turns", "4"];
    let child;
    try {
      child = spawn("claude", args, {
        env: envForClaude(),
        shell: IS_WIN,
        windowsHide: true,
        timeout: 120000
      });
    } catch (e) {
      return reject(new Error("claude 실행 실패: " + e.message));
    }

    let out = "", err = "";
    child.stdout.on("data", (d) => { if (out.length < 20e6) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 1e6) err += d; });

    child.on("error", (e) => {
      reject(new Error(
        e.code === "ENOENT"
          ? "claude 명령을 찾지 못했습니다"
          : "claude 실행 실패: " + e.message
      ));
    });

    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      // 진짜 이유를 그대로 올려보낸다. 뭉개면 "그냥 실패"로만 보인다
      reject(new Error(
        "claude가 " + code + "번으로 끝났습니다" + (err.trim() ? ": " + err.trim().slice(0, 400) : "")
      ));
    });

    child.stdin.on("error", () => {});   // 상대가 먼저 죽으면 EPIPE가 난다
    child.stdin.end(prompt);
  });
}

async function askViaCli(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capnote-"));
  const parts = [];

  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    for (const b of blocks) {
      if (b.type === "text") {
        parts.push(b.text);
      } else if (b.type === "image" && b.source && b.source.data) {
        const f = path.join(dir, `crop-${parts.length}.jpg`);
        fs.writeFileSync(f, Buffer.from(b.source.data, "base64"));
        parts.push(`아래 이미지 파일을 읽고 답하세요: ${f}`);
      }
    }
  }

  try {
    const stdout = await runClaude(parts.join("\n\n"));
    let text = stdout;
    try {
      const j = JSON.parse(stdout);
      text = j.result || j.text || stdout;
    } catch (e) { /* 평문이면 그대로 */ }
    return { content: [{ type: "text", text: String(text) }] };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

async function ask(req, res) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 25 * 1024 * 1024) req.destroy();   // 이미지가 오므로 넉넉히
  });

  req.on("end", async () => {
    try {
      const { messages } = JSON.parse(raw);

      if (USE_CLI) {
        const out = await askViaCli(messages);
        return send(res, 200, JSON.stringify({ ...out, mode: MODE }));
      }

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages })
      });
      const data = await r.text();
      let out = data;
      try {
        const j = JSON.parse(data);
        j.mode = MODE;
        out = JSON.stringify(j);
      } catch (e) { /* JSON이 아니면 원문을 그대로 넘겨야 진짜 이유가 보인다 */ }
      send(res, r.status, out);
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e), mode: MODE }));
    }
  });
}

/*
 * Claude Code가 깔려 있는지, 로그인은 됐는지 화면이 물어볼 수 있게 한다.
 * "왜 AI만 안 되는지"를 사용자가 알 방법이 없었다.
 */
function claudeStatus() {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { env: envForClaude(), shell: IS_WIN, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve({ installed: false, reason: err.code === "ENOENT" ? "not-found" : String(err.message) });
        resolve({ installed: true, version: String(stdout).trim().slice(0, 60) });
      });
  });
}

/*
 * 로그인은 앱 안에서 끝낼 수 없다. claude auth login이 대화형이라
 * 브라우저와 터미널을 오가야 하기 때문이다. 그래서 터미널만 열어 준다 —
 * 사용자가 명령을 외워서 직접 치는 것보다는 낫다.
 */
function openLoginTerminal() {
  return new Promise((resolve) => {
    const env = envForClaude();
    let cmd, args, opts = { env, detached: true, stdio: "ignore" };

    if (IS_WIN) {
      cmd = "cmd"; args = ["/c", "start", "", "cmd", "/k", "claude auth login"];
    } else if (process.platform === "darwin") {
      cmd = "osascript";
      args = ["-e", 'tell application "Terminal" to do script "claude auth login"',
              "-e", 'tell application "Terminal" to activate'];
    } else {
      cmd = "x-terminal-emulator"; args = ["-e", "claude auth login"];
    }

    try {
      const c = spawn(cmd, args, opts);
      c.on("error", (e) => resolve({ ok: false, error: String(e.message) }));
      c.unref();
      setTimeout(() => resolve({ ok: true }), 400);
    } catch (e) {
      resolve({ ok: false, error: String(e.message) });
    }
  });
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/ask") return ask(req, res);

  if (req.url === "/api/status") {
    return claudeStatus().then(function (st) {
      send(res, 200, JSON.stringify({ mode: MODE, version: VERSION, claude: st }));
    });
  }

  if (req.method === "POST" && req.url === "/api/login") {
    return openLoginTerminal().then(function (r) {
      send(res, r.ok ? 200 : 500, JSON.stringify(r));
    });
  }

  if (req.url === "/api/version") {
    return send(res, 200, JSON.stringify({ version: VERSION, mode: MODE }));
  }

  const rel = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(file)] || "application/octet-stream");
  });
}).listen(PORT, () => {
  console.log(`\n  오려둔 공책 v${VERSION} → http://localhost:${PORT}`);
  console.log(`  모드: ${MODE_LABEL}  [${MODE}]`);

  if (API_NO_KEY) {
    console.log("  !! CLAUDE_USE_API=1을 켰지만 ANTHROPIC_API_KEY가 없어 구독 경로로 돌아갑니다.");
  }

  if (USE_CLI) {
    if (process.env.ANTHROPIC_API_KEY) {
      // 키가 있는데도 안 쓴다는 걸 분명히 해야, 요금이 나갈까 걱정하지 않는다
      console.log("  ANTHROPIC_API_KEY가 환경에 있지만 쓰지 않습니다 (API를 쓰려면 CLAUDE_USE_API=1)");
    }
    console.log("  준비: npm i -g @anthropic-ai/claude-code  &&  claude auth login\n");
  } else {
    console.log("  주의: 호출마다 요금이 나갑니다\n");
  }
});
