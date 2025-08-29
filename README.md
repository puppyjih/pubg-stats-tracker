# PUBG API Server

간단한 Express 기반 백엔드와 정적 프론트엔드(HTML/JS)로 PUBG 플레이어 전적을 조회하는 프로젝트입니다.

## 구성
- `server/`
  - `index.js`: Express 서버 진입점. 정적 파일 서빙 및 `/api/player/**` 라우트 연결.
  - `pubgService.js`: PUBG Open API 연동, 캐싱, 집계/시즌/텔레메트리 로직.
  - `routes/player.js`: 플레이어/시즌 관련 REST API 라우트.
- `client/`
  - `index.html`: UI 레이아웃과 스타일.
  - `app.js`: 검색, 렌더링, 페이지네이션, 시즌/맵/팀원/무기 패널.
- 루트
  - `.env`: 환경변수 (로컬에서 `.env.example` 복사 후 채우기)
  - `package.json`: 스크립트 및 의존성.

## 사전 준비
1) PUBG API 키 발급 (https://developer.pubg.com)
2) `.env` 파일 생성

```
cp .env.example .env
```

`.env` 편집:
- `PUBG_API_KEY` 필수
- `PORT`, `CACHE_TTL_MS`, `MATCH_LIMIT`, `MAX_MATCH_LIMIT` 선택
- `ENABLE_TELEMETRY`, `TELEMETRY_LIMIT` 선택 (텔레메트리 기반 무기별 딜량 패널)

## 실행
개발 모드:

```
npm install
npm run dev
```

프로덕션 모드:

```
npm run start
```

기본 포트는 `4000`이며, 브라우저에서 `http://localhost:4000` 접속 후 검색하세요.

## API 개요
- `GET /api/player/:platform/:name?limit=25&offset=0`
  - 플레이어 기본 정보, 최근 매치 요약, 집계, 맵/팀원/시즌/무기(옵션) 포함
- `GET /api/player/:platform/:name/seasons`
- `GET /api/player/:platform/:name/season/:seasonId`

## 주의사항
- Node.js 18+ 필요 (`package.json` engines)
- 텔레메트리 수집은 매치당 이벤트 JSON을 내려받으므로, API 호출이 상대적으로 느릴 수 있습니다.
- 캐시는 메모리 기반으로 서버 재시작 시 초기화됩니다.
