import { Router } from 'express';                 // Express 라우터 불러오기
import { getPlayerWithMatches, getPlayerSeasonStats, getSeasons, fetchSeasonRaw, collectNameDictionaries, getMatchDetails, getNameMaps, getMapDebugOverrides, setMapDebugOverride, clearMapDebugOverride, getTelemetryForMatch } from '../pubgService.js'; // 시즌 관련 import + 디버그 함수들
import { inspectRanked } from '../tools/rankInspector.js';

const router = Router();                          // 라우터 인스턴스 생성

// GET /api/player/:platform/:name
router.get('/:platform/:name', async (req, res) => {
  const { platform, name } = req.params;
  let limit, offset;
  if (req.query.limit !== undefined) {
    const n = Number(req.query.limit);
    if (!Number.isNaN(n)) limit = n;
  }
  if (req.query.offset !== undefined) {
    const o = Number(req.query.offset);
    if (!Number.isNaN(o) && o >= 0) offset = o;
  }
  if (!platform || !name) return res.status(400).json({ error: 'platform and name required' });
  try {
    const data = await getPlayerWithMatches(platform, name, { limit, offset });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 시즌 목록만 (선택적)
router.get('/:platform/:name/seasons', async (req, res) => {
  const { platform, name } = req.params;
  try {
    const playerData = await getPlayerWithMatches(platform, name, { limit: 1, offset: 0 });
    const seasons = playerData.seasons || await getSeasons(platform);
    res.json({ playerId: playerData.player.id, seasons });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 특정 시즌 스탯
router.get('/:platform/:name/season/:seasonId', async (req, res) => {
  const { platform, name, seasonId } = req.params;
  try {
    const playerData = await getPlayerWithMatches(platform, name, { limit: 1, offset: 0 });
    const stats = await getPlayerSeasonStats(platform, playerData.player.id, seasonId);
    res.json({ player: playerData.player, season: stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 디버그: 시즌 원본 응답 확인
router.get('/:platform/:name/season/:seasonId/debug-raw', async (req, res) => {
  const { platform, name, seasonId } = req.params;
  try {
    const playerData = await getPlayerWithMatches(platform, name, { limit: 1, offset: 0 });
    const raw = await fetchSeasonRaw(platform, playerData.player.id, seasonId);
    res.json({ player: playerData.player, raw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 디버그: ranked 엔드포인트 다각 확인
router.get('/:platform/:name/season/:seasonId/inspect-ranked', async (req, res) => {
  const { platform, name, seasonId } = req.params;
  try {
    const report = await inspectRanked({ platform, playerName: name, seasonId });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 유틸: 최근 데이터에서 맵/무기 내부명 목록 수집
router.get('/:platform/:name/dictionaries', async (req, res) => {
  const { platform, name } = req.params;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const dict = await collectNameDictionaries(platform, name, { limit });
    res.json(dict);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 매치 상세: 팀/플레이어 스탯 + 내 킬 이벤트(텔레메트리)
router.get('/:platform/:name/match/:matchId', async (req, res) => {
  const { platform, name, matchId } = req.params;
  try {
    const detail = await getMatchDetails(platform, name, matchId);
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 정적 매핑(nameMaps.json) 제공: 맵/무기 표준 표시명 매핑
router.get('/:platform/:name/nameMaps', async (req, res) => {
  try {
    const maps = getNameMaps();
    res.json(maps);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 디버그: 맵 오버라이드 조회/설정/삭제
router.get('/debug/map-overrides', (req, res) => {
  res.json(getMapDebugOverrides());
});

router.post('/debug/map-overrides', (req, res) => {
  const { mapName, invertY, worldSize } = req.body || {};
  if (!mapName) return res.status(400).json({ error: 'mapName required' });
  const out = setMapDebugOverride(mapName, { invertY, worldSize });
  res.json(out);
});

router.delete('/debug/map-overrides', (req, res) => {
  const { mapName } = req.body || {};
  if (!mapName) return res.status(400).json({ error: 'mapName required' });
  const out = clearMapDebugOverride(mapName);
  res.json(out);
});

// 디버그: 매치 텔레메트리 원본 조회(큰 JSON 주의)
router.get('/:platform/match/:matchId/telemetry', async (req, res) => {
  try {
    const { platform, matchId } = req.params;
    const data = await getTelemetryForMatch(platform, matchId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 정상적으로 한 번만 export
export default router;