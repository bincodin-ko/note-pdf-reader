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

/*
 * 로컬 모델 (Ollama) — 클로드를 대신하는 게 아니라 길을 하나 더 내는 것이다.
 *
 * 두 가지를 맡긴다.
 *   1) 스캔본 글자 읽기(OCR). 그림으로만 된 교재는 pdf.js가 글자를 못 뽑아
 *      "전체 쪽에서 찾기"가 통째로 막혔다. 이건 작은 모델로도 된다.
 *   2) 정리. 구독 없이 돌리거나 인터넷이 없을 때를 위한 선택지.
 *      기본은 여전히 클로드다 — 로컬 3B가 더 잘 쓸 일은 없다.
 *
 * npm 패키지를 늘리지 않으려고 HTTP로만 붙는다. Ollama가 안 떠 있으면
 * 이 기능들은 조용히 없는 것처럼 군다. 있는 척하고 실패하면 더 나쁘다.
 */
const OLLAMA = (process.env.CAPNOTE_OLLAMA || "http://127.0.0.1:11434").replace(/\/+$/, "");
const LOCAL_TEXT_ENV = process.env.CAPNOTE_LOCAL_MODEL || "";
const LOCAL_OCR_ENV = process.env.CAPNOTE_OCR_MODEL || "";

/*
 * 어떤 모델이 깔려 있는지는 사람마다 다르다. 이름을 못 박아 두면 "그 모델이
 * 없습니다"만 반복하게 되므로, 깔린 것 중에서 고른다. 환경 변수로 지정하면
 * 그게 먼저다.
 */
const TEXT_PICKS = [/exaone/i, /kanana/i, /hyperclova/i, /qwen3/i, /qwen2\.5/i, /gemma/i, /llama/i, /mistral/i];
// 이름표가 제각각이다 — qwen2.5vl:7b, llama3.2-vision, llava, minicpm-v …
const OCR_PICKS = [/hyperclova.*vision/i, /vision/i, /vl\b/i, /llava/i, /minicpm-v\b/i, /moondream/i];

let tagCache = { at: 0, names: [], err: "" };

async function localTags() {
  if (Date.now() - tagCache.at < 30000) return tagCache;       // 상태를 자주 묻는다
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);               // 없을 때 오래 끌지 않는다
    const r = await fetch(OLLAMA + "/api/tags", { signal: c.signal });
    clearTimeout(t);
    const j = await r.json();
    const names = (j.models || []).map((m) => m.name).filter(Boolean);
    tagCache = { at: Date.now(), names, err: "" };
  } catch (e) {
    // "fetch failed"는 사람에게 아무것도 안 알려 준다. 무엇을 하면 되는지를 적는다
    tagCache = { at: Date.now(), names: [], err: "Ollama가 떠 있지 않습니다 (" + OLLAMA + ")" };
  }
  return tagCache;
}

function pickModel(names, envName, picks) {
  if (envName && names.some((n) => n === envName || n.split(":")[0] === envName)) return envName;
  if (envName) return "";                       // 지정했는데 없으면 말없이 딴 걸 쓰지 않는다
  for (const re of picks) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return "";
}

async function localState() {
  const tags = await localTags();
  return {
    ok: tags.names.length > 0,
    base: OLLAMA,
    models: tags.names,
    text: pickModel(tags.names, LOCAL_TEXT_ENV, TEXT_PICKS),
    vision: pickModel(tags.names, LOCAL_OCR_ENV, OCR_PICKS),
    why: tags.names.length ? "" : (tags.err || "모델이 하나도 없습니다")
  };
}

/*
 * 앱이 보내는 것은 Anthropic 꼴(content 블록 배열)이다. Ollama는 글과 그림을
 * 따로 받으므로 여기서 옮겨 담는다. 앱 코드를 고치지 않으려는 것 —
 * 브라우저는 어느 쪽으로 가는지 알 필요가 없다.
 */
function toOllama(messages) {
  return (messages || []).map((m) => {
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const images = parts.filter((p) => p.type === "image" && p.source && p.source.data)
                        .map((p) => p.source.data);
    const out = { role: m.role === "assistant" ? "assistant" : "user", content: text };
    if (images.length) out.images = images;
    return out;
  });
}

async function localChat(messages, model, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs || 180000);   // 로컬은 느리다. 넉넉히
  try {
    const r = await fetch(OLLAMA + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: toOllama(messages), stream: false }),
      signal: c.signal
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("ollama http " + r.status));
    return String((j.message && j.message.content) || "");
  } finally {
    clearTimeout(t);
  }
}

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
      const body = JSON.parse(raw);
      const messages = body.messages;

      /*
       * 세 번째 길. 앱이 engine:"local"이라고 하면 로컬 모델로 간다.
       * 앞의 두 길(구독·API)은 그대로 있다 — 고르는 것이지 바꾸는 게 아니다.
       */
      if (body.engine === "local") {
        const st = await localState();

        /*
         * 오려낸 그림이 같이 오면 그림을 보는 모델로 보낸다. 글만 읽는 모델에
         * 그림을 물리면 말없이 무시하고 엉뚱한 답을 쓴다 — 글자만 보는 쪽이
         * 낫다고 사람이 판단할 수는 있어도, 앱이 몰래 그러면 안 된다.
         */
        const hasImage = (messages || []).some((m) =>
          Array.isArray(m.content) && m.content.some((c) => c.type === "image"));
        const model = hasImage ? (st.vision || st.text) : (st.text || st.vision);

        if (!model) {
          return send(res, 503, JSON.stringify({
            error: "로컬 모델이 준비되지 않았습니다" + (st.why ? " (" + st.why + ")" : ""),
            mode: "local"
          }));
        }
        if (hasImage && !st.vision) {
          return send(res, 503, JSON.stringify({
            error: "오려낸 그림을 읽으려면 그림을 보는 로컬 모델이 필요합니다. " +
                   "위 줄에서 클로드로 되돌리거나 ollama pull qwen2.5vl 하세요.",
            mode: "local"
          }));
        }

        const text = await localChat(messages, model);
        return send(res, 200, JSON.stringify({
          content: [{ type: "text", text }], mode: "local", model
        }));
      }

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
 * 쪽 그림에서 글자만 뽑는다.
 *
 * 정리와 달리 이건 "보이는 대로 옮겨 적기"라 작은 모델로도 된다. 그래서
 * 여기만 로컬로 돌려도 스캔본 교재의 "전체 쪽에서 찾기"가 열린다.
 * 정리는 건드리지 않는다 — 각자 잘하는 일이 다르다.
 */
async function ocr(req, res) {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 25 * 1024 * 1024) req.destroy();
  });

  req.on("end", async () => {
    try {
      const { image } = JSON.parse(raw);
      if (!image) return send(res, 400, JSON.stringify({ error: "그림이 없습니다" }));

      const st = await localState();
      if (!st.vision) {
        return send(res, 503, JSON.stringify({
          error: "글자를 읽을 로컬 모델이 없습니다" +
                 (st.ok ? " (그림을 보는 모델이 필요합니다)" : (st.why ? " (" + st.why + ")" : ""))
        }));
      }

      const text = await localChat([{
        role: "user",
        content: [
          { type: "image", source: { data: image } },
          { type: "text", text:
            "이 쪽에 적힌 글자를 그대로 옮겨 적으세요.\n" +
            "읽은 것만 적고 요약·설명·추측은 하지 마세요.\n" +
            "머리말 없이 본문만 출력하세요. 글자가 없으면 빈 줄로 두세요." }
        ]
      }], st.vision);

      send(res, 200, JSON.stringify({ text: String(text).trim(), model: st.vision }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
  });
}

/*
 * Claude Code 준비 상태
 *
 * 설치 여부만 보면 부족하다. 깔려는 있는데 로그인이 안 된 상태가 그냥
 * 통과해서, 정작 AI를 부를 때가 되어서야 실패했다.
 * claude auth status가 loggedIn을 JSON으로 주므로 그것까지 본다.
 */
function runQuick(args, timeout) {
  return new Promise((resolve) => {
    execFile("claude", args,
      { env: envForClaude(), shell: IS_WIN, timeout: timeout || 15000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ err: err, out: String(stdout || ""), errOut: String(stderr || "") });
      });
  });
}

async function claudeStatus() {
  const v = await runQuick(["--version"]);
  if (v.err) {
    return {
      installed: false,
      loggedIn: false,
      reason: v.err.code === "ENOENT" ? "not-found" : String(v.err.message || "").slice(0, 200)
    };
  }

  const a = await runQuick(["auth", "status"], 20000);
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(a.out).loggedIn === true;
  } catch (e) {
    // 출력 형식이 바뀌었을 때를 대비한 보루. 종료 코드와 문구로 짐작한다
    loggedIn = !a.err && !/not logged|logged out|로그인/i.test(a.out + a.errOut);
  }

  return { installed: true, loggedIn: loggedIn, version: String(v.out).trim().slice(0, 60) };
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

  if (req.method === "POST" && req.url === "/api/ocr") return ocr(req, res);

  if (req.url === "/api/status") {
    return Promise.all([claudeStatus(), localState()]).then(function (r) {
      send(res, 200, JSON.stringify({ mode: MODE, version: VERSION, claude: r[0], local: r[1] }));
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
    console.log("  준비: npm i -g @anthropic-ai/claude-code  &&  claude auth login");
  } else {
    console.log("  주의: 호출마다 요금이 나갑니다");
  }

  // 로컬 모델은 있으면 쓰고 없으면 그만이다. 있는지만 한 줄로 알린다
  localState().then(function (st) {
    console.log(st.text || st.vision
      ? "  로컬 모델: 정리 " + (st.text || "없음") + " · 글자 읽기 " + (st.vision || "없음") + "\n"
      : "  로컬 모델: 없음 (쓰려면 ollama serve — 없어도 앱은 그대로 돕니다)\n");
  });
});
