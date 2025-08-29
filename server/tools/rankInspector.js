import 'dotenv/config';
import fetch from 'node-fetch';

const API_KEY = process.env.PUBG_API_KEY;
const BASE_URL = 'https://api.pubg.com/shards';

function headers() {
    return {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/vnd.api+json'
    };
}

async function getJsonSafe(url) {
    const started = Date.now();
    try {
        const r = await fetch(url, { headers: headers() });
        const text = await r.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        const ms = Date.now() - started;
        return { ok: r.ok, status: r.status, retryAfter: r.headers.get('retry-after'), durationMs: ms, json, rawText: text.slice(0, 500) };
    } catch (e) {
        return { ok: false, status: -1, error: e.message };
    }
}

function summarizeRankedObj(obj) {
    const modes = obj ? Object.keys(obj) : [];
    let kills = 0, assists = 0, deaths = 0, damage = 0, rounds = 0;
    modes.forEach(m => {
        const v = obj[m] || {};
        kills += v.kills || 0;
        assists += v.assists || 0;
        deaths += v.deaths || 0;
        damage += v.damageDealt || 0;
        rounds += v.roundsPlayed || 0;
    });
    return { modes, kills, assists, deaths, damage, rounds };
}

export async function inspectRanked({ platform, playerName, seasonId }) {
    // 1) 플레이어 ID 조회
    const playerUrl = `${BASE_URL}/${platform}/players?filter[playerNames]=${encodeURIComponent(playerName)}`;
    const p = await getJsonSafe(playerUrl);
    if (!p.ok) return { step: 'player', player: p };
    const player = p.json?.data?.[0];
    if (!player) return { step: 'player', error: 'Player not found in API response', api: p };
    const playerId = player.id;

    // 2) 후보 엔드포인트
    const urls = {
        playerSeason: `${BASE_URL}/${platform}/players/${playerId}/seasons/${seasonId}`,
        ranked1: `${BASE_URL}/${platform}/players/${playerId}/seasons/${seasonId}/ranked`,
        ranked2: `${BASE_URL}/${platform}/seasons/${seasonId}/ranked/players/${playerId}`,
        ranked3: `${BASE_URL}/${platform}/ranked/seasons/${seasonId}/players/${playerId}`
    };

    const res = {};
    for (const [k, url] of Object.entries(urls)) {
        res[k] = await getJsonSafe(url);
    }

    // 3) 요약
    const playerSeasonAttr = res.playerSeason.json?.data?.attributes || {};
    const psRanked = playerSeasonAttr.rankedGameModeStats || {};
    const psGms = playerSeasonAttr.gameModeStats || {};
    const s1 = summarizeRankedObj(psRanked);

    const r1Ranked = res.ranked1.json?.data?.attributes?.rankedGameModeStats || {};
    const r2Ranked = res.ranked2.json?.data?.attributes?.rankedGameModeStats || {};
    const r3Ranked = res.ranked3.json?.data?.attributes?.rankedGameModeStats || {};
    const s2 = summarizeRankedObj(r1Ranked);
    const s3 = summarizeRankedObj(r2Ranked);
    const s4 = summarizeRankedObj(r3Ranked);

    return {
        player: { id: playerId, name: player.attributes?.name, shard: player.attributes?.shardId },
        seasonId,
        endpoints: {
            playerSeason: { status: res.playerSeason.status, retryAfter: res.playerSeason.retryAfter, keys: Object.keys(playerSeasonAttr || {}) },
            ranked1: { status: res.ranked1.status, retryAfter: res.ranked1.retryAfter },
            ranked2: { status: res.ranked2.status, retryAfter: res.ranked2.retryAfter },
            ranked3: { status: res.ranked3.status, retryAfter: res.ranked3.retryAfter }
        },
        dataPresence: {
            playerSeason_rankedModes: s1.modes,
            playerSeason_rankedSums: { kills: s1.kills, assists: s1.assists, deaths: s1.deaths, damage: s1.damage, rounds: s1.rounds },
            ranked1_modes: s2.modes,
            ranked1_sums: { kills: s2.kills, assists: s2.assists, deaths: s2.deaths, damage: s2.damage, rounds: s2.rounds },
            ranked2_modes: s3.modes,
            ranked2_sums: { kills: s3.kills, assists: s3.assists, deaths: s3.deaths, damage: s3.damage, rounds: s3.rounds },
            ranked3_modes: s4.modes,
            ranked3_sums: { kills: s4.kills, assists: s4.assists, deaths: s4.deaths, damage: s4.damage, rounds: s4.rounds },
            bestRankPoint: playerSeasonAttr.bestRankPoint ?? null
        },
        rawSamples: {
            playerSeason_attr: playerSeasonAttr,
            ranked1_attr: res.ranked1.json?.data?.attributes || null,
            ranked2_attr: res.ranked2.json?.data?.attributes || null,
            ranked3_attr: res.ranked3.json?.data?.attributes || null
        }
    };
}

export default inspectRanked;
