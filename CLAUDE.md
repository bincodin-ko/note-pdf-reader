# 작업 안내

## 이 프로젝트

PDF 강의자료에서 마우스로 영역을 드래그하면 그 부분을 잘라 AI 정리를 받고,
원하면 그 자리에 한 줄 메모로 붙여두는 학습 도구.

자세한 구조·제약·다음 할 일은 `README.md`에 있다. **먼저 읽을 것.**

## 파일

- `server.js` — 정적 서비스 + `/api/ask`. API 키가 있으면 Anthropic API로,
  없으면 `claude -p`(Claude Code CLI)로 넘어간다
- `public/index.html` — 앱 전체. 화면·선택·카드·메모·내보내기가 한 파일에 들어 있다
- `public/storage.js` — IndexedDB 저장소
- `main.js` — Electron 껍데기. 서버를 앱 안에서 띄우고 창으로 연다

## 지켜야 할 것

- **빌드 단계를 만들지 말 것.** 지금은 `node server.js` 하나로 돌아간다.
  번들러·프레임워크를 넣자는 제안은 하지 말 것.
- **`public/index.html`을 쪼개지 말 것.** 한 파일로 두는 게 의도다.
  Claude 아티팩트로 다시 옮길 수 있어야 한다.
- 외부 의존성은 CDN(pdf.js, pdf-lib)과 Electron뿐이다. npm 패키지를 늘리지 말 것.
- 화면 문구는 한국어. 사용자는 수업 중에 이 도구를 쓴다 — 방해를 늘리는 UI는 피할 것.
- 코드 주석에는 "무엇을"이 아니라 **"왜 이렇게 했는지"**를 적을 것.
  (예: 자동 다운로드를 쓰지 않는 이유, IndexedDB를 고른 이유)

## 확인 순서

1. `npm run web` → 브라우저에서 PDF 열기·드래그가 되는지
2. AI 정리는 Claude Code 로그인 후 확인
3. 화면이 다 확인된 뒤에야 Electron(`npm start`)으로 넘어갈 것
