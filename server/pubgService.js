import fetch from 'node-fetch';                                    // HTTP 요청을 보내기 위한 fetch 구현 (Node 환경용)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 환경변수에서 API 키 읽기 (dotenv 가 index.js 에서 이미 로드)
const API_KEY = process.env.PUBG_API_KEY;
if (!API_KEY) console.warn('[warn] PUBG_API_KEY not set');         // 키 없으면 경고 (요청 시 401 날 가능성)

// PUBG API 기본 URL 형태 (shards/{platform} 를 기반으로 엔드포인트 구성)
const BASE_URL = 'https://api.pubg.com/shards';

// 기본 페이지 사이즈 (환경변수 없으면 25)
const DEFAULT_LIMIT = parseInt(process.env.MATCH_LIMIT || '25', 10);
const MAX_MATCH_LIMIT = process.env.MAX_MATCH_LIMIT ? parseInt(process.env.MAX_MATCH_LIMIT, 10) : null;

// 캐시 유지 시간 (밀리초). 기본 60초.
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '60000', 10);

// 재시도/백오프/동시성 제한 설정
const RETRY_MAX = parseInt(process.env.RETRY_MAX || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.RETRY_BASE_MS || '400', 10);
const MATCH_FETCH_CONCURRENCY = parseInt(process.env.MATCH_FETCH_CONCURRENCY || '3', 10);

// 간단한 인메모리 캐시 (서버 재시작 시 모두 사라짐)
// key -> { expires: 타임스탬프, data: 저장데이터 }
const cache = new Map();

// 이름 매핑(내부명 -> 표시명) 로드
let NAME_MAPS = { maps: {}, weapons: {} };
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const mapsPath = path.resolve(__dirname, 'data', 'nameMaps.json');
  const raw = fs.readFileSync(mapsPath, 'utf-8');
  NAME_MAPS = JSON.parse(raw);
} catch (e) {
  console.warn('[nameMaps] not loaded, using internal names');
}

// 좌표 정규화 디버그용 맵 오버라이드 저장소
// key: mapName (e.g., 'Baltic_Main'), value: { invertY?: boolean, worldSize?: number }
const MAP_DEBUG_OVERRIDES = new Map();

function mapDisplayName(kind, key) {
  if (!key) return key;
  const table = NAME_MAPS[kind] || {};
  return table[key] || key;
}

// 외부 노출용: nameMaps getter
export function getNameMaps() {
  return NAME_MAPS;
}

// 무기 코드 추출 헬퍼: 다양한 경로의 damageCauserName을 탐색 (전역)
function extractDamageCauser(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const pick = (...vals) => vals.find(v => typeof v === 'string' && v.trim().length > 0) || null;
  let v = pick(
    ev.damageCauserName,
    ev.common?.damageCauserName,
    ev.killerDamageInfo?.damageCauserName,
    ev.damageInfo?.damageCauserName,
    ev.weapon,
    ev.damageCauser,
    ev.victim?.dbnoMaker?.damageCauserName,
    ev.victim?.DBNOMaker?.damageCauserName,
    ev.dbnoMaker?.damageCauserName,
    ev.DBNOMaker?.damageCauserName,
    ev.victim?.dbno?.maker?.damageCauserName,
    ev.damageInfo?.dbnoMaker?.damageCauserName
  );
  if (v) return v;
  const seen = new Set();
  let found = null;
  const maxNodes = 300;
  let visited = 0;
  const dfs = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || found || depth > 3) return;
    if (seen.has(obj)) return; seen.add(obj);
    if (visited++ > maxNodes) return;
    for (const [k, val] of Object.entries(obj)) {
      if (typeof k === 'string' && k.toLowerCase() === 'damagecausername' && typeof val === 'string' && val.trim()) {
        found = val; return;
      }
    }
    for (const val of Object.values(obj)) {
      if (found) return;
      if (val && typeof val === 'object') dfs(val, depth + 1);
    }
  };
  dfs(ev, 0);
  return (typeof found === 'string' && found.trim().length > 0) ? found : null;
}

// 좌표 선택 헬퍼: 피해자 위치가 없으면 공통/공격자 위치까지 폭넓게 탐색
function pickBestLocationFromEvent(ev, attacker, victim) {
  const cand = [
    victim?.location,
    ev?.victim?.character?.location,
    ev?.victimPlayer?.location,
    ev?.victim?.location,
    ev?.common?.victimLocation,
    ev?.common?.location,
    attacker?.location,
    ev?.attacker?.character?.location,
    ev?.attackerPlayer?.location
  ];
  for (const loc of cand) {
    if (loc && typeof loc.x === 'number' && typeof loc.y === 'number') return loc;
  }
  return null;
}

// 디버그: 맵 좌표계 오버라이드 제어
export function getMapDebugOverrides() {
  return Object.fromEntries(MAP_DEBUG_OVERRIDES);
}
export function setMapDebugOverride(mapName, { invertY, worldSize } = {}) {
  if (!mapName) return { error: 'mapName required' };
  const cur = MAP_DEBUG_OVERRIDES.get(mapName) || {};
  const next = { ...cur };
  if (typeof invertY === 'boolean') next.invertY = invertY;
  if (typeof worldSize === 'number' && isFinite(worldSize)) next.worldSize = worldSize;
  MAP_DEBUG_OVERRIDES.set(mapName, next);
  return { mapName, override: next };
}
export function clearMapDebugOverride(mapName) {
  if (!mapName) return { error: 'mapName required' };
  const existed = MAP_DEBUG_OVERRIDES.delete(mapName);
  return { mapName, deleted: existed };
}

// 캐시에 값 저장
function setCache(key, data) {
  cache.set(key, { expires: Date.now() + CACHE_TTL, data });
}

// 캐시 조회 (만료되었으면 삭제 후 null)
function getCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}

// 실제 PUBG API 호출 공통 함수
async function pubgFetch(url) {
  let attempt = 0;
  let lastErr;
  while (attempt <= RETRY_MAX) {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/vnd.api+json'
      }
    });
    if (r.ok) {
      return r.json();
    }
    // 429/5xx 재시도
    const status = r.status;
    const text = await r.text().catch(() => '');
    const err = new Error(`PUBG API error ${status}: ${text.slice(0, 160)}`);
    // @ts-ignore 커스텀 속성 부여
    err.status = status;
    lastErr = err;

    // Retry-After 헤더 우선
    let backoff = 0;
    const retryAfter = r.headers.get('retry-after');
    if (retryAfter) {
      const sec = Number(retryAfter);
      if (!Number.isNaN(sec) && sec >= 0) backoff = Math.ceil(sec * 1000);
    }
    // 지수 백오프 + 지터
    if (!backoff) {
      const jitter = Math.floor(Math.random() * 150);
      backoff = RETRY_BASE_MS * Math.pow(2, attempt) + jitter;
    }
    if ((status === 429 || (status >= 500 && status < 600)) && attempt < RETRY_MAX) {
      await sleep(backoff);
      attempt += 1;
      continue;
    }
    throw err;
  }
  throw lastErr || new Error('PUBG API unknown error');
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// 간단한 동시성 제한 map 구현
async function mapLimit(items, limit, iterator) {
  const ret = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      ret[i] = await iterator(items[i], i);
    }
  });
  await Promise.all(workers);
  return ret;
}

// 외부에서 사용하는 핵심 함수: 플레이어 + 최근 매치 요약 묶어서 반환
export async function getPlayerWithMatches(platform, playerName, opts = {}) {
  // limit/offset 정규화
  let rawLimit = null;
  if (typeof opts.limit === 'number' && !Number.isNaN(opts.limit)) rawLimit = Math.floor(opts.limit);
  if (rawLimit !== null && rawLimit < -1) rawLimit = null;
  const offset = (typeof opts.offset === 'number' && opts.offset >= 0) ? Math.floor(opts.offset) : 0;

  const cacheKeyPart = `${rawLimit === -1 ? 'all' : (rawLimit ?? 'default')}:off=${offset}`;
  const key = `player:${platform}:${playerName.toLowerCase()}:${cacheKeyPart}`;
  const cached = getCache(key);
  if (cached) return { cached: true, ...cached };

  // 플레이어 조회
  const playerUrl = `${BASE_URL}/${platform}/players?filter[playerNames]=${encodeURIComponent(playerName)}`;
  const playerResp = await pubgFetch(playerUrl);
  if (!playerResp.data || playerResp.data.length === 0) throw new Error('Player not found');
  const player = playerResp.data[0];
  const playerId = player.id;

  // 매치 ID 슬라이스
  const matchRefs = player.relationships?.matches?.data || [];
  let effectiveLimit;
  if (rawLimit === -1) effectiveLimit = matchRefs.length; else if (rawLimit === null) effectiveLimit = DEFAULT_LIMIT; else effectiveLimit = rawLimit;
  if (effectiveLimit < 1) effectiveLimit = DEFAULT_LIMIT;
  if (MAX_MATCH_LIMIT != null) effectiveLimit = Math.min(effectiveLimit, MAX_MATCH_LIMIT);
  const sliceStart = offset;
  const sliceEnd = offset + effectiveLimit;
  const limitedRefs = matchRefs.slice(sliceStart, sliceEnd);

  // 매치 상세 (동시성 제한)
  const matches = await mapLimit(limitedRefs, MATCH_FETCH_CONCURRENCY, async (m) => {
    try {
      const matchData = await pubgFetch(`${BASE_URL}/${platform}/matches/${m.id}`);
      return simplifyMatch(matchData, playerId);
    } catch (e) {
      return { id: m.id, error: e.message };
    }
  });

  // 집계 (첫 페이지만)
  const aggregates = (offset === 0) ? computeAggregates(matches) : null;
  const mapStats = (offset === 0) ? computeMapStats(matches) : null;
  const topTeammates = (offset === 0) ? computeTopTeammates(matches) : [];

  // 시즌/랭크 (첫 페이지만)
  let seasons = null;
  let currentSeasonStats = null;
  if (offset === 0) {
    try {
      seasons = await getSeasons(platform);
      const current = seasons.find(s => s.isCurrent);
      if (current) currentSeasonStats = await getPlayerSeasonStats(platform, playerId, current.id);
    } catch (e) {
      console.warn('[season] fetch failed:', e.message);
      // 429 와 같이 레이트리밋이면 결과에 플래그 추가
      // @ts-ignore
      if (e && typeof e === 'object' && e.status === 429) {
        resultFlags.seasonRateLimited = true;
      }
    }
  }

  // 무기별 딜량(첫 페이지만, 옵션)
  let weaponStats = null;
  if (offset === 0 && ENABLE_TELEMETRY) {
    try {
      weaponStats = await computeWeaponStatsFromTelemetry(player.attributes?.name, matches);
    } catch (e) {
      weaponStats = { weapons: [], total: 0, note: 'telemetry error' };
    }
  }

  const resultFlags = {};
  const result = {
    player: {
      id: playerId,
      name: player.attributes?.name,
      shardId: player.attributes?.shardId
    },
    matches,
    offset,
    limitRequested: rawLimit,
    limitEffective: effectiveLimit,
    totalMatchesAvailable: matchRefs.length,
    hasMore: sliceEnd < matchRefs.length,
    aggregates,
    mapStats,
    topTeammates,       // 상위 팀원
    seasons,
    currentSeasonStats, // rankedSummary/최고티어 포함
    weaponStats,        // 무기별 딜량
    fetchedAt: new Date().toISOString(),
    ...resultFlags
  };

  setCache(key, result);
  return { cached: false, ...result };
}

// 텔레메트리 설정(기본 활성, 최대 N경기까지 파싱)
const ENABLE_TELEMETRY = process.env.ENABLE_TELEMETRY !== 'false';
const TELEMETRY_LIMIT = parseInt(process.env.TELEMETRY_LIMIT || '8', 10);

// 티어 비교용 순서
const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'];
const SUBTIER_ORDER = ['V', 'IV', 'III', 'II', 'I']; // V < ... < I
function tierValue(tier, subTier) {
  const t = TIER_ORDER.indexOf(tier || '');
  const s = SUBTIER_ORDER.indexOf((subTier || '').toString().toUpperCase());
  return (t < 0 ? -1 : t) * 10 + (s < 0 ? -1 : s);
}
function pickBestTier(candidates) {
  // candidates: [{tier, subTier, points, source}]
  return candidates.reduce((best, cur) => {
    if (!cur?.tier) return best;
    if (!best) return cur;
    return tierValue(cur.tier, cur.subTier) > tierValue(best.tier, best.subTier) ? cur : best;
  }, null);
}

// 시즌 목록/시즌 스탯 기존 코드 상단에 이미 있다면 유지, 없으면 아래 함수 사용
export async function getSeasons(platform) {
  const cacheKey = `seasons:${platform}`;
  const c = getCache(cacheKey);
  if (c) return c;
  const url = `${BASE_URL}/${platform}/seasons`;
  const json = await pubgFetch(url);
  const out = (json.data || []).map(s => ({
    id: s.id,
    isCurrent: s.attributes?.isCurrentSeason,
    isOffseason: s.attributes?.isOffseason
  }));
  setCache(cacheKey, out);
  return out;
}

export async function getPlayerSeasonStats(platform, playerId, seasonId) {
  const cacheKey = `season:${platform}:${playerId}:${seasonId}`;
  const c = getCache(cacheKey);
  if (c) return c;
  const url = `${BASE_URL}/${platform}/players/${playerId}/seasons/${seasonId}`;
  const json = await pubgFetch(url);
  const attr = json.data?.attributes || {};
  let ranked = attr.rankedGameModeStats || {};
  let modes = Object.keys(ranked);
  const gms = attr.gameModeStats || {};

  // 현재/최고 티어 후보 모으기
  const tierCandidates = [];
  let agg = { kills: 0, assists: 0, deaths: 0, damage: 0, headshots: 0, rounds: 0, longestKill: 0, mostKillsGame: 0 };
  let estHeadshots = 0;
  modes.forEach(m => {
    const v = ranked[m];
    if (!v) return;
    // 현재 티어/포인트 (객체 형태 currentTier: { tier, subTier }) 대응)
    const curTierObj = v.currentTier;
    const curTier = (curTierObj && typeof curTierObj === 'object') ? curTierObj.tier : (v.currentTier || v.tier);
    const curSub = (curTierObj && typeof curTierObj === 'object') ? curTierObj.subTier : (v.currentSubTier || v.subTier);
    const curPts = v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints;
    if (curTier) tierCandidates.push({ tier: curTier, subTier: curSub, points: curPts, source: m });
    // 최고 티어 (객체 형태 bestTier: { tier, subTier }) 대응)
    const bestTierObj = v.bestTier;
    const bestTier = (bestTierObj && typeof bestTierObj === 'object') ? bestTierObj.tier : bestTierObj;
    const bestSub = (bestTierObj && typeof bestTierObj === 'object') ? bestTierObj.subTier : v.bestSubTier;
    const bestPts = v.bestRankPoint ?? v.bestRankPoints;
    if (bestTier) tierCandidates.push({ tier: bestTier, subTier: bestSub, points: bestPts, source: `${m}-best` });

    // 누적 지표 합산
    agg.kills += v.kills || 0;
    agg.assists += v.assists || 0;
    agg.deaths += v.deaths || 0;
    agg.damage += v.damageDealt || 0;
    agg.headshots += v.headshotKills || 0;
    if (typeof v.headshotKills === 'number' && v.headshotKills > 0) estHeadshots += v.headshotKills;
    else if (typeof v.headshotKillRatio === 'number' && (v.kills || 0) > 0) estHeadshots += (v.headshotKillRatio * (v.kills || 0));
    agg.rounds += v.roundsPlayed || 0;
    agg.longestKill = Math.max(agg.longestKill, v.longestKill || 0);
    agg.mostKillsGame = Math.max(agg.mostKillsGame, v.roundMostKills || v.mostKillsInAGame || v.maxKills || 0);
  });

  // 랭크 표시는 현재 티어 우선, 없으면 bestTier 중 최상위
  const currentTier = pickBestTier(
    modes
      .map(m => ranked[m])
      .filter(Boolean)
      .map(v => {
        const ct = v.currentTier;
        const tier = (ct && typeof ct === 'object') ? ct.tier : (v.currentTier || v.tier);
        const subTier = (ct && typeof ct === 'object') ? ct.subTier : (v.currentSubTier || v.subTier);
        return {
          tier,
          subTier,
          points: v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints,
          source: 'current'
        };
      })
  );
  let bestTier = pickBestTier(tierCandidates);

  let kda = agg.deaths > 0 ? (agg.kills + agg.assists) / agg.deaths : (agg.kills + agg.assists);
  let avgDamage = agg.rounds > 0 ? agg.damage / agg.rounds : 0;
  // headshot 비율: headshotKills가 비어 있는 시즌을 대비해 ratio 기반 추정 사용
  const hsNumerator = estHeadshots > 0 ? estHeadshots : agg.headshots;
  let hsRate = agg.kills > 0 ? (hsNumerator / agg.kills) * 100 : 0;
  let summarySource = 'ranked';

  // Fallback 1: ranked 전용 엔드포인트 시도 (응답 타입: rankedplayerstats)
  if (!modes.length) {
    try {
      const rankedFromEndpoint = await getRankedStats(platform, playerId, seasonId);
      if (rankedFromEndpoint && Object.keys(rankedFromEndpoint).length) {
        ranked = rankedFromEndpoint;
        modes = Object.keys(ranked);
        // 티어 후보 재구성
        tierCandidates.length = 0;
        agg = { kills: 0, assists: 0, deaths: 0, damage: 0, headshots: 0, rounds: 0, longestKill: 0, mostKillsGame: 0 };
        modes.forEach(m => {
          const v = ranked[m];
          if (!v) return;
          const ct = v.currentTier;
          const curTier = (ct && typeof ct === 'object') ? ct.tier : (v.currentTier || v.tier);
          const curSub = (ct && typeof ct === 'object') ? ct.subTier : (v.currentSubTier || v.subTier);
          const curPts = v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints;
          if (curTier) tierCandidates.push({ tier: curTier, subTier: curSub, points: curPts, source: m });
          const bt = v.bestTier;
          const bestTierX = (bt && typeof bt === 'object') ? bt.tier : bt;
          const bestSubX = (bt && typeof bt === 'object') ? bt.subTier : v.bestSubTier;
          const bestPtsX = v.bestRankPoint ?? v.bestRankPoints;
          if (bestTierX) tierCandidates.push({ tier: bestTierX, subTier: bestSubX, points: bestPtsX, source: `${m}-best` });
          agg.kills += v.kills || 0;
          agg.assists += v.assists || 0;
          agg.deaths += v.deaths || 0;
          agg.damage += v.damageDealt || 0;
          agg.headshots += v.headshotKills || 0;
          if (typeof v.headshotKills === 'number' && v.headshotKills > 0) estHeadshots += v.headshotKills;
          else if (typeof v.headshotKillRatio === 'number' && (v.kills || 0) > 0) estHeadshots += (v.headshotKillRatio * (v.kills || 0));
          agg.rounds += v.roundsPlayed || 0;
          agg.longestKill = Math.max(agg.longestKill, v.longestKill || 0);
          agg.mostKillsGame = Math.max(agg.mostKillsGame, v.roundMostKills || v.mostKillsInAGame || v.maxKills || 0);
        });
        currentTier = pickBestTier(
          modes
            .map(m => ranked[m])
            .filter(Boolean)
            .map(v => {
              const ct2 = v.currentTier;
              const tier = (ct2 && typeof ct2 === 'object') ? ct2.tier : (v.currentTier || v.tier);
              const subTier = (ct2 && typeof ct2 === 'object') ? ct2.subTier : (v.currentSubTier || v.subTier);
              return {
                tier,
                subTier,
                points: v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints,
                source: 'current'
              };
            })
        );
        bestTier = pickBestTier(tierCandidates);
        // ranked 합산으로 유효 요약이 안 나오면 이후 gms 폴백 시도
        const sumFromRanked = summarizeRanked(ranked);
        if (sumFromRanked.valid) {
          kda = sumFromRanked.kda; avgDamage = sumFromRanked.avgDamage; hsRate = sumFromRanked.hsRate;
          agg.longestKill = sumFromRanked.longestKill; agg.mostKillsGame = sumFromRanked.mostKillsGame;
          // ranked 합산에 longest/most가 비어있다면 gms에서 최대값 보강
          if ((!agg.longestKill || agg.longestKill === 0) || (!agg.mostKillsGame || agg.mostKillsGame === 0)) {
            let gLongest = 0, gMostKills = 0;
            Object.values(gms).forEach(v => {
              if (!v) return;
              gLongest = Math.max(gLongest, v.longestKill || 0);
              gMostKills = Math.max(gMostKills, v.roundMostKills || v.mostKillsInAGame || v.maxKills || 0);
            });
            if (!agg.longestKill || agg.longestKill === 0) agg.longestKill = gLongest;
            if (!agg.mostKillsGame || agg.mostKillsGame === 0) agg.mostKillsGame = gMostKills;
          }
          summarySource = 'ranked';
        }
      }
    } catch (e) {
      // ignore and continue to gameModeStats fallback
    }
  }

  // Fallback 2: ranked 전용도 없으면 gameModeStats 기반으로 요약 산출
  // 또한 ranked 모드가 존재하더라도 합산 rounds/kills 등이 0이면 폴백
  if (!modes.length || !isRankedSummaryMeaningful({ rounds: agg.rounds, kills: agg.kills, damage: agg.damage })) {
    let gKills = 0, gAssists = 0, gDamage = 0, gHead = 0, gRounds = 0, gLongest = 0, gMostKills = 0, gLosses = 0, gWins = 0;
    Object.values(gms).forEach(v => {
      if (!v) return;
      gKills += v.kills || 0;
      gAssists += v.assists || 0;
      gDamage += v.damageDealt || 0;
      gHead += v.headshotKills || 0;
      gRounds += v.roundsPlayed || 0;
      gLongest = Math.max(gLongest, v.longestKill || 0);
      gMostKills = Math.max(gMostKills, v.roundMostKills || v.mostKillsInAGame || v.maxKills || 0);
      gLosses += v.losses || 0;
      gWins += v.wins || 0;
    });
    // 팀전 기준 losses 합이 '사망'과 유사하게 동작하므로 근사 KDA 계산
    const denom = Math.max(gLosses, 0);
    kda = denom > 0 ? (gKills + gAssists) / denom : (gKills + gAssists);
    avgDamage = gRounds > 0 ? gDamage / gRounds : 0;
    hsRate = gKills > 0 ? (gHead / gKills) * 100 : 0;
    agg.longestKill = gLongest;
    agg.mostKillsGame = gMostKills;
    summarySource = 'gameModeStats';
  }

  const out = {
    seasonId,
    rankedTier: currentTier || null,
    bestRankedTier: bestTier || null,
    gameModeStats: attr.gameModeStats || {},
    rankedRaw: ranked,
    rankedSummary: {
      kda: +kda.toFixed(2),
      avgDamage: +avgDamage.toFixed(1),
      headshotRate: +hsRate.toFixed(2),
      longestKill: +agg.longestKill.toFixed(2),
      mostKillsGame: agg.mostKillsGame,
      // 신규 지표
      winRate: (() => {
        const s = summarizeRanked(ranked);
        return s && isFinite(s.winRate) ? +s.winRate.toFixed(1) : 0;
      })(),
      top10Rate: (() => {
        const s = summarizeRanked(ranked);
        return s && isFinite(s.top10Rate) ? +s.top10Rate.toFixed(1) : 0;
      })(),
      avgRank: (() => {
        const s = summarizeRanked(ranked);
        return s && s.avgRank != null && isFinite(s.avgRank) ? +s.avgRank.toFixed(2) : null;
      })()
    },
    // 게임이 통합 레이팅으로 제공하는 경우 대비하여 포인트도 함께 반환
    rankPoints: {
      best: attr.bestRankPoint ?? null
    },
    summarySource
  };
  setCache(cacheKey, out);
  return out;
}

// ranked 전용 엔드포인트를 여러 경로로 시도
async function getRankedStats(platform, playerId, seasonId) {
  const cacheKey = `ranked:${platform}:${playerId}:${seasonId}`;
  const c = getCache(cacheKey);
  if (c) return c;

  const candidates = [
    `${BASE_URL}/${platform}/players/${playerId}/seasons/${seasonId}/ranked`,
    `${BASE_URL}/${platform}/seasons/${seasonId}/ranked/players/${playerId}`
  ];
  for (const url of candidates) {
    try {
      const json = await pubgFetch(url);
      const attr = json?.data?.attributes || {};
      const ranked = attr.rankedGameModeStats || {};
      if (ranked && Object.keys(ranked).length) {
        setCache(cacheKey, ranked);
        return ranked;
      }
    } catch (e) {
      // 404/403/429 등은 다음 후보 시도
      continue;
    }
  }
  return {};
}

// simplifyMatch 확장: 팀원/텔레메트리 URL 포함
function simplifyMatch(matchData, playerId) {
  const { data, included } = matchData;
  const gameMode = data?.attributes?.gameMode;
  const createdAt = data?.attributes?.createdAt;
  const duration = data?.attributes?.duration;
  const participants = included?.filter(i => i.type === 'participant') || [];
  const rosters = included?.filter(i => i.type === 'roster') || [];
  const assets = included?.filter(i => i.type === 'asset') || [];
  const telemetryUrl = assets[0]?.attributes?.URL || null;

  // 무기 코드 헬퍼는 전역 extractDamageCauser 사용

  const me = participants.find(p => p.attributes?.stats?.playerId === playerId);
  const myStats = me?.attributes?.stats || null;

  let rank = null;
  let teammates = [];
  if (myStats) {
    const roster = rosters.find(r => r.relationships?.participants?.data?.some(pd => pd.id === me.id));
    rank = roster?.attributes?.stats?.rank ?? myStats.winPlace;
    if (roster) {
      const memberIds = roster.relationships?.participants?.data?.map(d => d.id) || [];
      teammates = participants
        .filter(p => memberIds.includes(p.id) && p !== me)
        .map(p => p.attributes?.stats?.name)
        .filter(Boolean);
    }
  }

  return {
    id: data.id,
    createdAt,
    gameMode,
    duration,
    mapName: data.attributes?.mapName,
    assetUrl: telemetryUrl,
    my: myStats ? {
      name: myStats.name,
      kills: myStats.kills,
      headshotKills: myStats.headshotKills,
      damage: myStats.damageDealt,
      assists: myStats.assists,
      DBNOs: myStats.DBNOs,
      revives: myStats.revives,
      winPlace: myStats.winPlace,
      rank
    } : null,
    teammates
  };
}

// 단일 매치 상세: 참여자/팀 스탯과 '내' 킬 이벤트(텔레메트리) 반환
export async function getMatchDetails(platform, playerName, matchId) {
  const url = `${BASE_URL}/${platform}/matches/${matchId}`;
  const matchData = await pubgFetch(url);
  const { data, included } = matchData;
  const mapName = data?.attributes?.mapName;
  const createdAt = data?.attributes?.createdAt;
  const duration = data?.attributes?.duration;
  const worldSize = getWorldSize(mapName);
  const participants = included?.filter(i => i.type === 'participant') || [];
  const rosters = included?.filter(i => i.type === 'roster') || [];
  const assets = included?.filter(i => i.type === 'asset') || [];
  const telemetryUrl = assets[0]?.attributes?.URL || null;

  // 참가자 기본 스탯 수집
  const pidByParticipantId = new Map(); // participant.id -> { ...stats, teamId }
  const allPlayers = [];
  // rosterId -> teamId 및 rank
  const rosterInfo = new Map();
  rosters.forEach(r => {
    rosterInfo.set(r.id, {
      teamId: r.attributes?.stats?.teamId ?? r.attributes?.stats?.teamId2 ?? r.id,
      rank: r.attributes?.stats?.rank ?? null
    });
  });
  participants.forEach(p => {
    const s = p.attributes?.stats || {};
    // 해당 참가자가 속한 roster 찾기
    const roster = rosters.find(r => r.relationships?.participants?.data?.some(pd => pd.id === p.id));
    const info = roster ? rosterInfo.get(roster.id) : { teamId: 'unknown', rank: null };
    const deaths = s.deathType && s.deathType !== 'alive' && s.deathType !== 'Alive' ? 1 : 0;
    const kda = deaths > 0 ? ((s.kills || 0) + (s.assists || 0)) / deaths : ((s.kills || 0) + (s.assists || 0));
    const rec = {
      id: p.id,
      name: s.name,
      accountId: s.playerId,
      kills: s.kills || 0,
      assists: s.assists || 0,
      DBNOs: s.DBNOs || 0,
      damage: s.damageDealt || 0,
      deaths,
      kda: +kda.toFixed(2),
      winPlace: s.winPlace,
      teamId: info?.teamId,
      teamRank: info?.rank ?? null
    };
    pidByParticipantId.set(p.id, rec);
    allPlayers.push(rec);
  });

  // 팀별 그룹 및 합계
  const teamsMap = new Map(); // teamId -> { teamId, rank, players:[], totals }
  allPlayers.forEach(pl => {
    const t = teamsMap.get(pl.teamId) || { teamId: pl.teamId, rank: pl.teamRank, players: [], totals: { kills: 0, DBNOs: 0, damage: 0 } };
    t.players.push(pl);
    t.totals.kills += pl.kills;
    t.totals.DBNOs += pl.DBNOs;
    t.totals.damage += pl.damage;
    if (t.rank == null && pl.teamRank != null) t.rank = pl.teamRank;
    teamsMap.set(pl.teamId, t);
  });
  const teams = Array.from(teamsMap.values()).sort((a, b) => (a.rank || 999) - (b.rank || 999));

  // 내 캐릭터 이름 표준화(정확한 매칭) - 대소문자 무시 보강
  const my = allPlayers.find(p => p.name === playerName)
    || allPlayers.find(p => String(p.name || '').toLowerCase() === String(playerName || '').toLowerCase())
    || null;

  // 텔레메트리에서 내가 한 킬 이벤트만 수집
  const kills = [];
  const rawKillLogs = [];
  let telemetryEvents = null;
  if (telemetryUrl) {
    try {
      const resp = await fetch(telemetryUrl);
      if (resp.ok) {
        telemetryEvents = await resp.json();
        const myId = my?.accountId || null;
        const myNameLower = (my?.name ? String(my.name) : String(playerName || '')).toLowerCase();
        for (const ev of telemetryEvents) {
          const type = ev?._T || ev?.type || '';
          if (type === 'LogPlayerKill' || type === 'LogPlayerKillV2') {
            const attacker = ev.killer || ev.attacker || ev.attackerPlayer || ev.attacker?.character;
            const victim = ev.victim || ev.victimPlayer || ev.victim?.character;
            const attackerName = attacker?.name || attacker?.character?.name;
            const attackerId = attacker?.accountId || attacker?.character?.accountId || null;
            const isMeAsAttacker = (myId && attackerId && attackerId === myId)
              || (attackerName && myNameLower && attackerName.toLowerCase() === myNameLower);
            if (isMeAsAttacker) {
              const damageCauser = extractDamageCauser(ev);
              const timeISO = ev._D || ev.timestamp || null;
              // 위치(피격자 기준) 정규화: 피해자 위치 없으면 보조 후보 사용
              const loc = pickBestLocationFromEvent(ev, attacker, victim);
              const { nx, ny } = normalizeLocation(mapName, loc);
              // 거리 보정: 필드 없으면 좌표로 계산 (cm -> m 추정)
              let distance = (typeof ev.distance === 'number') ? ev.distance : (typeof ev.common?.distance === 'number' ? ev.common.distance : null);
              if ((distance == null || Number.isNaN(distance)) && attacker?.location && victim?.location) {
                const dx = (attacker.location.x - victim.location.x) || 0;
                const dy = (attacker.location.y - victim.location.y) || 0;
                const distUnits = Math.sqrt(dx * dx + dy * dy);
                distance = Math.round((distUnits / 100) * 10) / 10; // meters (approx)
              }
              // 시간(초) 보정: 매치 시작(createdAt) 대비 경과초
              let timeSec = null;
              try {
                if (createdAt && timeISO) {
                  const t0 = Date.parse(createdAt);
                  const t1 = Date.parse(timeISO);
                  if (isFinite(t0) && isFinite(t1)) timeSec = Math.max(0, Math.round((t1 - t0) / 1000));
                }
              } catch { }
              kills.push({
                victim: victim?.name || ev?.victim?.name || 'Unknown',
                weaponCode: damageCauser || null,
                weapon: mapDisplayName('weapons', damageCauser || null) || (damageCauser || 'Unknown'),
                time: timeISO,
                timeSec,
                headshot: !!(ev.isHeadShot || ev.isHeadshot || ev.common?.isHeadShot),
                distance: (distance != null && isFinite(distance)) ? distance : null,
                x: loc?.x ?? null,
                y: loc?.y ?? null,
                nx,
                ny
              });
              rawKillLogs.push(ev);
            }
          }
        }
      }
    } catch (e) {
      // ignore telemetry failure
    }
  }

  // 내 사망 이벤트 수집 (가해자/무기/위치)
  const deaths = [];
  if (telemetryEvents && Array.isArray(telemetryEvents)) {
    try {
      const myId = my?.accountId || null;
      const myNameLower = (my?.name ? String(my.name) : String(playerName || '')).toLowerCase();
      // 1차: 공식 Kill 이벤트 스캔 (O(n))
      for (const ev of telemetryEvents) {
        const type = ev?._T || ev?.type || '';
        if (type !== 'LogPlayerKill' && type !== 'LogPlayerKillV2') continue;
        const attacker = ev.killer || ev.attacker || ev.attackerPlayer || ev.attacker?.character;
        const victim = ev.victim || ev.victimPlayer || ev.victim?.character;
        const victimName = victim?.name || ev?.victim?.name;
        const victimId = victim?.accountId || victim?.character?.accountId || null;
        const isMeAsVictim = (myId && victimId && victimId === myId)
          || (victimName && myNameLower && victimName.toLowerCase() === myNameLower);
        if (!isMeAsVictim) continue;
        const damageCauser = extractDamageCauser(ev);
        const timeISO = ev._D || ev.timestamp || null;
        const loc = pickBestLocationFromEvent(ev, attacker, victim);
        const { nx, ny } = normalizeLocation(mapName, loc);
        let distance = (typeof ev.distance === 'number') ? ev.distance : (typeof ev.common?.distance === 'number' ? ev.common.distance : null);
        if ((distance == null || Number.isNaN(distance)) && attacker?.location && victim?.location) {
          const dx = (attacker.location.x - victim.location.x) || 0;
          const dy = (attacker.location.y - victim.location.y) || 0;
          const distUnits = Math.sqrt(dx * dx + dy * dy);
          distance = Math.round((distUnits / 100) * 10) / 10;
        }
        let timeSec = null;
        try {
          if (createdAt && timeISO) {
            const t0 = Date.parse(createdAt);
            const t1 = Date.parse(timeISO);
            if (isFinite(t0) && isFinite(t1)) timeSec = Math.max(0, Math.round((t1 - t0) / 1000));
          }
        } catch { }
        let attackerLabel = attacker?.name || attacker?.character?.name || null;
        if (!attackerLabel) {
          const cat = ev.damageTypeCategory || ev.common?.damageTypeCategory || ev.damageReason || '';
          if (/BlueZone/i.test(cat)) attackerLabel = 'Blue Zone';
          else if (/RedZone|Explosion_RedZone/i.test(cat)) attackerLabel = 'Red Zone';
          else if (/Drown/i.test(cat)) attackerLabel = 'Drowning';
          else if (/Fall/i.test(cat)) attackerLabel = 'Fall';
          else attackerLabel = 'Unknown';
        }
        deaths.push({
          attacker: attackerLabel,
          weaponCode: damageCauser || null,
          weapon: mapDisplayName('weapons', damageCauser || null) || (damageCauser || 'Unknown'),
          time: timeISO,
          timeSec,
          headshot: !!(ev.isHeadShot || ev.isHeadshot || ev.common?.isHeadShot),
          distance: (distance != null && isFinite(distance)) ? distance : null,
          x: loc?.x ?? null,
          y: loc?.y ?? null,
          nx,
          ny,
          inferred: false
        });
        rawKillLogs.push(ev);
      }

      // 2차 Fallback: Kill 이벤트가 전혀 없을 때만 한 번 실행 (O(n))
      if (deaths.length === 0) {
        let candidate = null;
        for (const ev of telemetryEvents) {
          if (ev?._T !== 'LogPlayerTakeDamage') continue;
          const v = ev.victim || ev.victimPlayer || ev.victim?.character || null;
          const name = v?.name || ev?.victim?.name || null;
          const vid = v?.accountId || v?.character?.accountId || null;
          const matchesMe = (myId && vid && vid === myId) || (name && myNameLower && name.toLowerCase() === myNameLower);
          if (!matchesMe) continue;
          const victimHealth = v?.health ?? ev.victimHealth ?? null;
          if (victimHealth != null && typeof victimHealth === 'number' && victimHealth <= 0) {
            candidate = ev; // latest zero-health event
          }
        }
        if (candidate) {
          const attacker = candidate.attacker || candidate.killer || candidate.attackerPlayer || candidate.attacker?.character;
          const v = candidate.victim || candidate.victimPlayer || candidate.victim?.character || null;
          const timeISO = candidate._D || candidate.timestamp || null;
          const loc = pickBestLocationFromEvent(candidate, attacker, v);
          const { nx, ny } = normalizeLocation(mapName, loc);
          const damageCauser = extractDamageCauser(candidate) || candidate.damageTypeCategory || null;
          let timeSec = null;
          try {
            if (createdAt && timeISO) {
              const t0 = Date.parse(createdAt);
              const t1 = Date.parse(timeISO);
              if (isFinite(t0) && isFinite(t1)) timeSec = Math.max(0, Math.round((t1 - t0) / 1000));
            }
          } catch { }
          let attackerLabel = attacker?.name || attacker?.character?.name || null;
          if (!attackerLabel) {
            const cat = candidate.damageTypeCategory || candidate.common?.damageTypeCategory || candidate.damageReason || '';
            if (/BlueZone/i.test(cat)) attackerLabel = 'Blue Zone';
            else if (/RedZone|Explosion_RedZone/i.test(cat)) attackerLabel = 'Red Zone';
            else if (/Drown/i.test(cat)) attackerLabel = 'Drowning';
            else if (/Fall/i.test(cat)) attackerLabel = 'Fall';
            else attackerLabel = 'Unknown';
          }
          deaths.push({
            attacker: attackerLabel,
            weaponCode: damageCauser || null,
            weapon: mapDisplayName('weapons', damageCauser || null) || (damageCauser || 'Unknown'),
            time: timeISO,
            timeSec,
            headshot: false,
            distance: null,
            x: loc?.x ?? null,
            y: loc?.y ?? null,
            nx, ny,
            inferred: true
          });
        } else {
          // 마지막 MakeGroggy 사용
          let groggy = null;
          for (const ev of telemetryEvents) {
            if (ev?._T !== 'LogPlayerMakeGroggy') continue;
            const v = ev.victim || ev.victimPlayer || ev.victim?.character || null;
            const name = v?.name || ev?.victim?.name || null;
            const vid = v?.accountId || v?.character?.accountId || null;
            const matchesMe = (myId && vid && vid === myId) || (name && myNameLower && name.toLowerCase() === myNameLower);
            if (!matchesMe) continue;
            groggy = ev;
          }
          if (groggy) {
            const attacker = groggy.attacker || groggy.killer || groggy.attackerPlayer || groggy.attacker?.character;
            const v = groggy.victim || groggy.victimPlayer || groggy.victim?.character || null;
            const timeISO = groggy._D || groggy.timestamp || null;
            const loc = pickBestLocationFromEvent(groggy, attacker, v);
            const { nx, ny } = normalizeLocation(mapName, loc);
            const damageCauser = extractDamageCauser(groggy) || groggy.damageTypeCategory || null;
            let timeSec = null;
            try {
              if (createdAt && timeISO) {
                const t0 = Date.parse(createdAt);
                const t1 = Date.parse(timeISO);
                if (isFinite(t0) && isFinite(t1)) timeSec = Math.max(0, Math.round((t1 - t0) / 1000));
              }
            } catch { }
            let attackerLabel = attacker?.name || attacker?.character?.name || null;
            if (!attackerLabel) {
              const cat = groggy.damageTypeCategory || groggy.common?.damageTypeCategory || groggy.damageReason || '';
              if (/BlueZone/i.test(cat)) attackerLabel = 'Blue Zone';
              else if (/RedZone|Explosion_RedZone/i.test(cat)) attackerLabel = 'Red Zone';
              else if (/Drown/i.test(cat)) attackerLabel = 'Drowning';
              else if (/Fall/i.test(cat)) attackerLabel = 'Fall';
              else attackerLabel = 'Unknown';
            }
            deaths.push({
              attacker: attackerLabel,
              weaponCode: damageCauser || null,
              weapon: mapDisplayName('weapons', damageCauser || null) || (damageCauser || 'Unknown'),
              time: timeISO,
              timeSec,
              headshot: false,
              distance: null,
              x: loc?.x ?? null,
              y: loc?.y ?? null,
              nx, ny,
              inferred: true
            });
          }
        }
      }
    } catch (e) {
      // ignore telemetry failure
    }
  }

  return {
    id: matchId,
    mapName,
    createdAt,
    duration,
    worldSize,
    telemetry: !!telemetryUrl,
    my: my ? { name: my.name, teamId: my.teamId } : null,
    teams,
    kills,
    deaths,
    rawKillLogs
  };
}

// 맵별 월드 좌표 범위를 대략적으로 정의하여 0..1 정규화
function getWorldSize(mapName) {
  const key = mapName || '';
  // 내부 맵 키 기준 대략치
  const eight = 816000, four = 408000, two = 204000, three = 306000, one = 102000;
  if (/Erangel|Desert|DihorOtok|Tiger|Kiki|Vikendi|Rondo/i.test(key)) return eight;
  if (/Savage/i.test(key)) return four;
  if (/Summerland|Range/i.test(key)) return two; // Karakin, Camp Jackal
  if (/Chimera/i.test(key)) return three; // Paramo
  if (/Heaven/i.test(key)) return one; // Haven
  return eight;
}

function normalizeLocation(mapName, loc) {
  const o = MAP_DEBUG_OVERRIDES.get(mapName) || null;
  const size = (o && typeof o.worldSize === 'number' && isFinite(o.worldSize)) ? o.worldSize : getWorldSize(mapName);
  if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number') return { nx: null, ny: null };
  const nx = Math.min(Math.max(loc.x / size, 0), 1);
  // 기본: BL(좌하단) 원점 기준으로 y/size를 그대로 반환합니다.
  // 필요 시 맵별 오버라이드 invertY=true로 설정하면 (1 - y/size)로 반전(TL 기준)합니다.
  const nyRaw = loc.y / size;
  const invert = (o && typeof o.invertY === 'boolean') ? o.invertY : false; // 기본 비반전(BL 기준)
  const ny = Math.min(Math.max((invert ? (1 - nyRaw) : nyRaw), 0), 1);
  return { nx, ny };
}

// 디버그: 매치의 텔레메트리 전체 이벤트 반환 (주의: 응답이 큼)
export async function getTelemetryForMatch(platform, matchId) {
  const url = `${BASE_URL}/${platform}/matches/${matchId}`;
  const matchData = await pubgFetch(url);
  const assets = matchData?.included?.filter(i => i.type === 'asset') || [];
  const telemetryUrl = assets[0]?.attributes?.URL || null;
  if (!telemetryUrl) return { error: 'No telemetry asset' };
  const r = await fetch(telemetryUrl);
  if (!r.ok) return { error: `telemetry HTTP ${r.status}` };
  return r.json();
}

// 최근 매치에서 함께한 팀원 TOP 5
function computeTopTeammates(matches) {
  const m = new Map(); // name -> {count,sumRank,sumDamage}
  matches.forEach(match => {
    if (!match || match.error || !match.my) return;
    const r = match.my.rank ?? match.my.winPlace;
    const dmg = match.my.damage || 0;
    (match.teammates || []).forEach(name => {
      const v = m.get(name) || { count: 0, sumRank: 0, sumDamage: 0 };
      v.count += 1;
      v.sumRank += (typeof r === 'number' ? r : 0);
      v.sumDamage += dmg;
      m.set(name, v);
    });
  });
  const arr = Array.from(m.entries()).map(([name, v]) => ({
    name,
    games: v.count,
    avgRank: v.count ? +(v.sumRank / v.count).toFixed(2) : null,
    avgDamage: v.count ? +(v.sumDamage / v.count).toFixed(1) : 0
  }));
  arr.sort((a, b) => b.games - a.games || a.avgRank - b.avgRank);
  return arr.slice(0, 5);
}

// 텔레메트리에서 무기별 딜량 계산 (공격자=해당 플레이어)
async function computeWeaponStatsFromTelemetry(playerName, matches) {
  const targets = matches
    .filter(m => m.assetUrl && m.my && m.my.name)
    .slice(0, TELEMETRY_LIMIT);
  if (targets.length === 0) return { weapons: [], total: 0, note: 'No telemetry' };

  const sum = new Map(); // weapon -> damage
  let total = 0;

  for (const m of targets) {
    try {
      const resp = await fetch(m.assetUrl); // 텔레메트리는 보통 공개 URL
      if (!resp.ok) continue;
      const events = await resp.json();
      for (const ev of events) {
        if (ev?._T === 'LogPlayerTakeDamage' && ev.attacker && ev.damage && ev.attacker.name) {
          if (ev.attacker.name === playerName && ev.damage > 0) {
            const internal = ev.damageCauserName || ev.damageCauser || ev.damageTypeCategory || 'Unknown';
            const name = mapDisplayName('weapons', internal);
            const d = sum.get(name) || 0;
            sum.set(name, d + ev.damage);
            total += ev.damage;
          }
        }
      }
    } catch {
      // ignore telemetry failure for a match
    }
  }
  const weapons = Array.from(sum.entries())
    .map(([weapon, damage]) => ({ weapon, damage: +damage.toFixed(1) }))
    .sort((a, b) => b.damage - a.damage)
    .slice(0, 10);
  return { weapons, total: +total.toFixed(1), note: `parsed ${targets.length} matches` };
}

// 최근 매치 집계(평균/비율 등)
function computeAggregates(matches) {
  const valid = matches.filter(m => m && !m.error && m.my);
  const n = valid.length || 0;
  if (n === 0) return null;
  let wins = 0, top10 = 0;
  let sumRank = 0, sumKills = 0, sumDamage = 0, sumAssists = 0, sumHS = 0;
  valid.forEach(m => {
    const r = m.my.rank ?? m.my.winPlace;
    if (typeof r === 'number') {
      sumRank += r;
      if (r === 1) wins += 1;
      if (r <= 10) top10 += 1;
    }
    sumKills += m.my.kills || 0;
    sumDamage += m.my.damage || 0;
    sumAssists += m.my.assists || 0;
    sumHS += m.my.headshotKills || 0;
  });
  const avgRank = n ? +(sumRank / n).toFixed(2) : null;
  const avgKills = n ? +(sumKills / n).toFixed(2) : 0;
  const avgDamage = n ? +(sumDamage / n).toFixed(1) : 0;
  const kd = n ? +(((sumKills + sumAssists) / n)).toFixed(2) : 0; // 간단화된 KDA
  const winRate = n ? +((wins / n) * 100).toFixed(1) : 0;
  const top10Rate = n ? +((top10 / n) * 100).toFixed(1) : 0;
  const hsRate = sumKills > 0 ? +((sumHS / sumKills) * 100).toFixed(2) : 0;
  return {
    games: n,
    wins,
    winRate,
    top10,
    top10Rate,
    avgRank,
    kd,
    avgKills,
    avgDamage,
    hsRate
  };
}

// 맵별 통계 집계
function computeMapStats(matches) {
  const m = new Map();
  matches.forEach(x => {
    if (!x || x.error || !x.my) return;
    const key = x.mapName || 'Unknown';
    const r = x.my.rank ?? x.my.winPlace;
    const v = m.get(key) || { matches: 0, wins: 0, sumRank: 0, sumKills: 0, sumDamage: 0 };
    v.matches += 1;
    if (r === 1) v.wins += 1;
    if (typeof r === 'number') v.sumRank += r;
    v.sumKills += x.my.kills || 0;
    v.sumDamage += x.my.damage || 0;
    m.set(key, v);
  });
  const arr = Array.from(m.entries()).map(([map, v]) => ({
    map: mapDisplayName('maps', map),
    matches: v.matches,
    wins: v.wins,
    winRate: v.matches ? +((v.wins / v.matches) * 100).toFixed(1) : 0,
    avgRank: v.matches ? +((v.sumRank / v.matches).toFixed(2)) : null,
    avgKills: v.matches ? +((v.sumKills / v.matches).toFixed(2)) : 0,
    avgDamage: v.matches ? +((v.sumDamage / v.matches).toFixed(1)) : 0
  }));
  arr.sort((a, b) => b.matches - a.matches);
  return arr;
}

// 디버그용: 시즌 원본 응답(attributes)을 그대로 반환
export async function fetchSeasonRaw(platform, playerId, seasonId) {
  const url = `${BASE_URL}/${platform}/players/${playerId}/seasons/${seasonId}`;
  const json = await pubgFetch(url);
  const attr = json?.data?.attributes || {};
  const ranked = attr.rankedGameModeStats || {};
  // ranked 전용도 함께 확인
  let rankedFromEndpoint = {};
  try {
    rankedFromEndpoint = await getRankedStats(platform, playerId, seasonId);
  } catch { }
  return {
    seasonId,
    attributesKeys: Object.keys(attr || {}),
    hasRankedGameModeStats: ranked && Object.keys(ranked).length > 0,
    rankedModes: Object.keys(ranked || {}),
    sampleRanked: ranked, // 주의: 응답이 크면 생략 가능. 여기선 그대로 반환
    sampleGameMode: attr.gameModeStats || {},
    rankedEndpoint: {
      has: rankedFromEndpoint && Object.keys(rankedFromEndpoint).length > 0,
      modes: Object.keys(rankedFromEndpoint || {}),
      sample: rankedFromEndpoint
    }
  };
}

// 유의미한 ranked 합산인지 판단 (라운드/킬/데미지 중 하나라도 양수면 의미있다고 간주)
function isRankedSummaryMeaningful({ rounds, kills, damage }) {
  return (rounds || 0) > 0 || (kills || 0) > 0 || (damage || 0) > 0;
}

// ranked 응답을 합산하여 간단 요약 산출
function summarizeRanked(ranked) {
  const modes = Object.keys(ranked || {});
  let kills = 0, assists = 0, deaths = 0, damage = 0, estHead = 0, rounds = 0, longest = 0, mostKills = 0;
  // 승/탑10/평균 순위 집계용
  let totalRounds = 0, totalWins = 0;
  let wrWeighted = 0, top10Weighted = 0;
  let avgRankWeighted = 0, avgRankWeight = 0;
  modes.forEach(m => {
    const v = ranked[m];
    if (!v) return;
    kills += v.kills || 0;
    assists += v.assists || 0;
    deaths += v.deaths || 0;
    damage += v.damageDealt || 0;
    // headshot 계산: headshotKills가 있으면 사용, 없으면 ratio * kills 추정
    if (typeof v.headshotKills === 'number' && v.headshotKills > 0) estHead += v.headshotKills;
    else if (typeof v.headshotKillRatio === 'number' && (v.kills || 0) > 0) estHead += (v.headshotKillRatio * v.kills);
    const rds = v.roundsPlayed || 0;
    rounds += rds;
    longest = Math.max(longest, v.longestKill || 0);
    mostKills = Math.max(mostKills, v.roundMostKills || v.mostKillsInAGame || v.maxKills || 0);
    // 승/탑10/평균 순위
    const wins = v.wins ?? 0;
    totalWins += wins;
    totalRounds += rds;
    const modeWr = (v.winRatio != null) ? v.winRatio : (rds ? (wins / rds) : 0);
    wrWeighted += modeWr * rds;
    const modeTop10 = (v.top10Ratio != null) ? v.top10Ratio : 0;
    top10Weighted += modeTop10 * rds;
    if (v.avgRank != null) {
      const w = rds || 1;
      avgRankWeighted += (+v.avgRank) * w;
      avgRankWeight += w;
    }
  });
  const valid = isRankedSummaryMeaningful({ rounds, kills, damage });
  const kda = deaths > 0 ? (kills + assists) / deaths : (kills + assists);
  const avgDamage = rounds > 0 ? damage / rounds : 0;
  const hsRate = kills > 0 ? (estHead / kills) * 100 : 0;
  const winRate = totalRounds > 0
    ? ((totalWins > 0 ? (totalWins / totalRounds) : (wrWeighted / totalRounds)) * 100)
    : 0;
  const top10Rate = totalRounds > 0 ? (top10Weighted / totalRounds) * 100 : 0;
  const avgRank = avgRankWeight > 0 ? (avgRankWeighted / avgRankWeight) : null;
  return { valid, kda, avgDamage, hsRate, longestKill: longest, mostKillsGame: mostKills, winRate, top10Rate, avgRank };
}

// 최근 매치/텔레메트리 기반으로 맵 이름과 무기 내부명 목록 수집
export async function collectNameDictionaries(platform, playerName, opts = {}) {
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  // 플레이어 + 매치 간단 로드 (기존 함수 활용)
  const bundle = await getPlayerWithMatches(platform, playerName, { limit, offset: 0 });
  const matches = bundle.matches || [];

  // 맵 이름 집계
  const mapCount = new Map();
  for (const m of matches) {
    if (!m || m.error) continue;
    const key = m.mapName || 'Unknown';
    mapCount.set(key, (mapCount.get(key) || 0) + 1);
  }
  const maps = Array.from(mapCount.entries()).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // 무기 내부명 집계 (텔레메트리에서 공격자=플레이어인 데미지 이벤트만)
  const targets = matches.filter(m => m.assetUrl && m.my && m.my.name).slice(0, TELEMETRY_LIMIT);
  const wepCount = new Map();
  let parsedTelemetry = 0;
  for (const m of targets) {
    try {
      const resp = await fetch(m.assetUrl);
      if (!resp.ok) continue;
      const events = await resp.json();
      parsedTelemetry += 1;
      for (const ev of events) {
        if (ev?._T === 'LogPlayerTakeDamage' && ev.attacker && ev.attacker.name === bundle.player.name && ev.damage > 0) {
          const key = ev.damageCauserName || ev.damageCauser || ev.damageTypeCategory || 'Unknown';
          wepCount.set(key, (wepCount.get(key) || 0) + ev.damage);
        }
      }
    } catch { }
  }
  const weapons = Array.from(wepCount.entries()).map(([key, damage]) => ({ key, damage: +(+damage).toFixed(1) }))
    .sort((a, b) => b.damage - a.damage || a.key.localeCompare(b.key));

  return {
    player: bundle.player,
    parsed: { matches: matches.length, telemetryFiles: parsedTelemetry },
    maps,
    weapons,
    note: '내부명 수집 결과이며, 보기 좋은 한글/표준 명칭은 별도 매핑 테이블에서 지정하세요.'
  };
}