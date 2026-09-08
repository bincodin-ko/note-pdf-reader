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
const { execFile } = require("node:child_process");

const PORT = process.env.PORT || 5173;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const PUBLIC = path.join(__dirname, "public");

// 키가 없으면 Claude Code CLI로 넘어간다 (claude auth login 필요, 구독으로 처리)
const USE_CLI = !KEY;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" });
  res.end(body);
}

/*
 * 경로 B: Claude Code CLI (구독으로 처리, API 키 불필요)
 *
 * 이미지는 인자로 못 넘기므로 임시 파일로 떨군 뒤 경로를 프롬프트에 적어 준다.
 * Claude Code가 Read 도구로 그 파일을 직접 읽는다.
 */
function askViaCli(messages) {
  return new Promise((resolve, reject) => {
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

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;          // 구독 자격으로 붙게 한다

    execFile(
      "claude",
      ["-p", parts.join("\n\n"), "--output-format", "json", "--allowedTools", "Read", "--max-turns", "4"],
      { env, timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        if (err) return reject(new Error("claude CLI 실행 실패: " + err.message));
        let text = stdout;
        try {
          const j = JSON.parse(stdout);
          text = j.result || j.text || stdout;
        } catch (e) { /* 평문이면 그대로 */ }
        resolve({ content: [{ type: "text", text: String(text) }] });
      }
    );
  });
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
        return send(res, 200, JSON.stringify(out));
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
      send(res, r.status, data);
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e.message || e) }));
    }
  });
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/ask") return ask(req, res);

  const rel = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(file)] || "application/octet-stream");
  });
}).listen(PORT, () => {
  console.log(`\n  오려둔 공책 → http://localhost:${PORT}`);
  if (USE_CLI) {
    console.log("  모드: Claude Code CLI (구독으로 처리 · API 키 없음)");
    console.log("  준비: npm i -g @anthropic-ai/claude-code  &&  claude auth login\n");
  } else {
    console.log(`  모드: Anthropic API · 모델 ${MODEL}\n`);
  }
});
