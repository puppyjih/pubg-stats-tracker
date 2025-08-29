// 1) dotenv/config: .env 파일을 읽어 process.env 에 환경변수 로드 (PORT, PUBG_API_KEY 등)
import 'dotenv/config';

// 2) Express (웹 서버 프레임워크) import
import express from 'express';

// 3) CORS: 다른 출처(frontend)에서 API 호출 가능하게 하는 미들웨어
import cors from 'cors';

// 4) 플레이어 관련 API 라우터 가져오기 (별도 파일에서 export)
import playerRouter from './routes/player.js';

// 5) 경로 처리 도구 (정적 파일 폴더 지정에 사용)
import { join, dirname } from 'path';
import { readFileSync } from 'fs';

// 6) 현재 모듈(ESM)에서 실제 파일 경로 얻기 위한 도구
import { fileURLToPath } from 'url';

// 7) Express 앱(서버 인스턴스) 생성
const app = express();

// 8) CORS 미들웨어 등록: 모든 요청에 CORS 헤더 붙임
app.use(cors());

// 9) JSON 본문(body) 파싱 미들웨어: 클라이언트가 JSON 전송하면 req.body 로 사용 가능
app.use(express.json());

// 10) __dirname 대용: ESM 환경에서는 바로 __dirname 사용 불가 → 변환
const __dirname = dirname(fileURLToPath(import.meta.url));

// 11) 정적 파일(HTML/JS/CSS)이 들어있는 client 폴더 경로 생성
const clientDir = join(__dirname, '..', 'client');
const assetsDir = join(__dirname, '..', 'api-assets-master', 'Assets');
const dataDir = join(__dirname, 'data');

// 12) 정적 파일 서빙: / 로 오면 client/index.html, /app.js 등 제공
//     extensions:['html'] → 확장자 없이 /index 요청 시 index.html 탐색
app.use(express.static(clientDir, { extensions: ['html'] }));
// Local API assets (images, icons)
app.use('/assets', express.static(assetsDir));
// Friendly alias for rank icons directory (avoid spaces in URL path)
app.use('/assets/ranks-v1', express.static(join(assetsDir, 'Icons', 'Ranks (v1) [Deprecated]')));

// 13) (선택적) API 요청만 간단히 로그 출력 (디버깅 도움)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) console.log(`[req] ${req.method} ${req.path}`);
  next(); // 다음 미들웨어/라우트로 진행
});

// 14) 헬스체크 라우트: 서버 살아있는지 확인용 (GET /health)
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// expose static name maps dictionary for client
app.get('/api/meta/nameMaps', (_req, res) => {
  try {
    const content = readFileSync(join(dataDir, 'nameMaps.json'), 'utf-8');
    res.set('Content-Type', 'application/json').send(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 15) 플레이어 관련 API 라우트 장착: /api/player/... 형식 URL 처리
//     실제 상세 로직은 routes/player.js → pubgService.js 로 이어짐
app.use('/api/player', playerRouter);

// 16) (여기까지 왔는데 위 라우터/정적에 해당 안 되면) 404 처리 - API 경로만 JSON 404 반환
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not Found' });
  next(); // 정적 파일이면 express.static 가 이미 처리했을 것이고, 남은 케이스는 거의 없음
});

// 17) 포트 값 결정: .env 의 PORT 가 있으면 사용, 없으면 4000
const PORT = process.env.PORT || 4000;

// 18) 서버 리스닝 시작: 해당 포트로 들어오는 HTTP 요청 수신
//     콜백은 서버가 실제 바인딩 완료되었을 때 1번 실행
app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});

// === 흐름 요약 ===
// (A) import 로 필요한 라이브러리/라우터 준비
// (B) app = express() 로 서버 객체 생성
// (C) 공통 미들웨어(cors, json, 정적) 장착
// (D) /health 와 /api/player 라우트 연결
// (E) 마지막 404 처리
// (F) app.listen 으로 실제 포트 열고 대기
// 브라우저 동작: index.html 로드 → app.js 로드 → 폼 submit → /api/player/{platform}/{name} 호출 → JSON → 화면 표시
