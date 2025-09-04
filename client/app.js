const form = document.getElementById('form');
const statusEl = document.getElementById('status');
const playerHeaderEl = document.getElementById('playerHeader');
const panelsEl = document.getElementById('panels');
const seasonPanelEl = document.getElementById('seasonPanel');
const mapPanelEl = document.getElementById('mapPanel');
const topTeamPanelEl = document.getElementById('topTeamPanel');   // 추가
const weaponPanelEl = document.getElementById('weaponPanel');     // 추가

let state = {
  platform: null,
  name: null,
  matches: [],
  offset: 0,
  limit: 25,
  hasMore: false,
  player: null,
  aggregates: null,
  seasons: [],
  currentSeasonStats: null,
  selectedSeason: null,
  mapStats: [],
  topTeammates: [],           // 추가
  weaponStats: null           // 추가
};

// 서버 제공 nameMaps.json 캐시 (맵/무기 표준명 매핑)
let nameMapsCache = null; // { maps: { internal: display }, weapons: { internal: display } }

// 로컬 제공 티어 아이콘 (api-assets-master/Assets/Icons/Ranks (v1) [Deprecated])
// 서버에서 /assets/ranks-v1 경로로 서빙됨
const tierImages = {
  Bronze: '/assets/ranks-v1/Rank_Icon_01_bronze_145x145.png',
  Silver: '/assets/ranks-v1/Rank_Icon_02_silver_145x145.png',
  Gold: '/assets/ranks-v1/Rank_Icon_03_gold_145x145.png',
  Platinum: '/assets/ranks-v1/Rank_Icon_04_platinum_145x145.png',
  Diamond: '/assets/ranks-v1/Rank_Icon_05_diamond_145x145.png',
  Elite: '/assets/ranks-v1/Rank_Icon_06_elite_145x145.png',
  Master: '/assets/ranks-v1/Rank_Icon_07_master_145x145.png',
  Grandmaster: '/assets/ranks-v1/Rank_Icon_08_grandmaster_145x145.png',
  Unranked: '/assets/ranks-v1/Rank_Icon_Unranked.png'
};

form.addEventListener('submit', async e => {
  e.preventDefault();
  const platform = document.getElementById('platform').value.trim();
  const name = document.getElementById('name').value.trim();
  const limitInput = Number(document.getElementById('limit').value) || 25;
  if (!name) return;
  resetState(platform, name, limitInput);
  await loadPage(0);
});

function resetState(platform, name, limit) {
  state = {
    platform, name,
    matches: [],
    offset: 0,
    limit,
    hasMore: false,
    player: null,
    aggregates: null,
    seasons: [],
    currentSeasonStats: null,
    selectedSeason: null,
    mapStats: [],
    topTeammates: [],
    weaponStats: null
  };
  playerHeaderEl.innerHTML = '';
  panelsEl.innerHTML = '';
  seasonPanelEl.innerHTML = '';
  mapPanelEl.innerHTML = '';
  topTeamPanelEl.innerHTML = '';  // 추가
  weaponPanelEl.innerHTML = '';   // 추가
  statusEl.textContent = '불러오는 중...';
}

async function loadPage(offset) {
  try {
    const url = `/api/player/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.name)}?limit=${state.limit}&offset=${offset}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (offset === 0) {
      // nameMaps 최초 로드
      try {
        const nmRes = await fetch(`/api/player/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.name)}/nameMaps`);
        if (nmRes.ok) nameMapsCache = await nmRes.json();
      } catch { }
      state.player = data.player;
      state.aggregates = data.aggregates;
      state.seasons = data.seasons || [];
      if (data.currentSeasonStats) {
        state.currentSeasonStats = data.currentSeasonStats;
        state.selectedSeason = data.currentSeasonStats.seasonId;
      }
      state.mapStats = data.mapStats || [];
      state.topTeammates = data.topTeammates || [];
      state.weaponStats = data.weaponStats || null;
    }
    state.matches = state.matches.concat(data.matches);
    state.offset = offset;
    state.hasMore = data.hasMore;
    renderAll();
    statusEl.textContent = data.cached ? '완료 (캐시)' : '완료';
  } catch (e) {
    console.error(e);
    statusEl.textContent = '오류: ' + e.message;
  }
}

function renderAll() {
  renderHeader();
  renderSeasonPanel();
  renderMapStatsPanel();
  renderTeammatesPanel();   // 추가
  renderWeaponPanel();      // 추가
  renderMatchesPanel();
}

function renderHeader() {
  if (!state.player) return;
  const p = state.player;
  const agg = state.aggregates;
  const first = p.name?.[0]?.toUpperCase() || '?';
  const tierBlock = renderRankedTier();
  const avgBlock = agg ? `
    <div style="display:flex; flex-wrap:wrap; gap:14px; margin-top:14px;">
      ${quickStat('평균 순위', agg.avgRank)}
      ${quickStat('평균 Dmg', agg.avgDamage)}
      ${quickStat('평균 KDA', agg.kd)}
      ${quickStat('HS%', agg.hsRate + '%')}
      ${quickStat('승리', `${agg.wins} (${agg.winRate}%)`)}
      ${quickStat('Top10', `${agg.top10} (${agg.top10Rate}%)`)}
    </div>` : '<div style="margin-top:12px;font-size:12px;color:var(--text-dim)">최근 매치 없음</div>';
  playerHeaderEl.innerHTML = `
    <div class="card header">
      <div class="avatar">${first}</div>
      <div style="flex:1; min-width:260px">
        <h2 style="margin:0 0 4px">${p.name}</h2>
        <div style="font-size:12px; color:var(--text-dim)">${p.id}</div>
        ${tierBlock}
        ${avgBlock}
      </div>
    </div>
  `;
}

function renderRankedTier() {
  const cs = state.currentSeasonStats;
  if (!cs) return '<div style="margin-top:10px;font-size:12px;color:var(--text-dim)">시즌 정보 없음</div>';
  const rt = cs.rankedTier;
  const best = cs.bestRankedTier;

  // rankedRaw 기반으로 보정: 모드별 데이터가 있으면 최상 포인트 모드로 티어/포인트/요약 구성
  let derivedTier = null;
  const rankedRaw = cs.rankedRaw && typeof cs.rankedRaw === 'object' ? cs.rankedRaw : null;
  if (rankedRaw) {
    const entries = Object.entries(rankedRaw)
      .filter(([, v]) => v && ((v.roundsPlayed || 0) > 0 || (v.kills || 0) > 0))
      .sort((a, b) => {
        const va = a[1]; const vb = b[1];
        const pa = (va.currentRankPoint ?? va.rankPoint ?? va.currentRankPoints ?? 0);
        const pb = (vb.currentRankPoint ?? vb.rankPoint ?? vb.currentRankPoints ?? 0);
        return pb - pa;
      });
    if (entries.length) {
      const v = entries[0][1];
      const ct = v.currentTier;
      const tier = ct && typeof ct === 'object' ? ct.tier : (v.tier || '');
      const subTier = ct && typeof ct === 'object' ? ct.subTier : (v.subTier || '');
      const points = v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints ?? null;
      // bestTier는 보조 정보로 표시
      const bt = v.bestTier;
      const bestTier = bt && typeof bt === 'object' ? { tier: bt.tier, subTier: bt.subTier || '' } : null;
      const bestPoints = v.bestRankPoint ?? v.bestRankPoints ?? null;
      derivedTier = { tier: tier || null, subTier: subTier || '', points, bestTier, bestPoints };
    }
  }

  // 최종 티어 결정: 서버 계산 → 파생 → 베스트 → 없으면 Unranked 이지만 '내역 없음' 문구는 표시하지 않음
  const tier = rt?.tier || derivedTier?.tier || best?.tier || null;
  const sub = rt?.subTier || derivedTier?.subTier || best?.subTier || '';
  const pts = (rt?.points ?? derivedTier?.points ?? best?.points ?? cs.rankPoints?.best ?? null);
  const img = tier ? tierImages[tier] : '';
  const personal = buildPersonalFromBestRankedMode(rankedRaw) || cs.rankedSummary || null;
  const summary = personal ? `
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; font-size:12px;">
      <span class="badge">KDA ${personal.kda}</span>
      <span class="badge">Avg Dmg ${personal.avgDamage}</span>
      <span class="badge">Win Rate ${personal.winRate ?? cs?.rankedSummary?.winRate ?? 0}%</span>
      <span class="badge">Top 10% ${(personal.top10Rate ?? cs?.rankedSummary?.top10Rate ?? 0)}%</span>
      <span class="badge">평균 순위 ${personal.avgRank ?? cs?.rankedSummary?.avgRank ?? '-'}</span>
    </div>` : '';
  return `
    <div style="display:flex; align-items:center; gap:14px; margin-top:14px;">
      <div style="display:flex; align-items:center; gap:10px;">
        ${tier && img ? `<img src="${img}" alt="${tier}" style="height:52px;width:auto;object-fit:contain;" />` : ''}
        <div>
          <div style="font-weight:600">${tier || 'Unranked'} ${sub}</div>
          <div style="font-size:12px; color:var(--text-dim)">${pts != null ? `Points: ${pts}` : ''}</div>
          ${derivedTier?.bestTier ? `<div style=\"font-size:12px;color:var(--text-dim)\">Best: ${derivedTier.bestTier.tier} ${derivedTier.bestTier.subTier || ''}${derivedTier.bestPoints != null ? ' / ' + derivedTier.bestPoints : ''}</div>` : (best && (best.tier || best.subTier) ? `<div style=\"font-size:12px;color:var(--text-dim)\">Best: ${best.tier} ${best.subTier || ''}${best.points != null ? ' / ' + best.points : ''}</div>` : '')}
        </div>
      </div>
    </div>
    ${summary}
  `;
}

function renderSeasonPanel() {
  if (!state.seasons.length) {
    seasonPanelEl.innerHTML = '';
    return;
  }
  const options = state.seasons.map(s =>
    `<option value="${s.id}" ${s.id === state.selectedSeason ? 'selected' : ''}>
      ${s.id}${s.isCurrent ? ' (현재)' : ''}
     </option>`
  ).join('');
  const cs2 = state.currentSeasonStats;
  // 우선순위: 랭크 모드별 데이터가 있으면, 포인트가 가장 높은 모드로 요약 생성 → 없으면 서버 요약 사용 → 없으면 안내 문구
  const personalBest = buildPersonalFromBestRankedMode(cs2?.rankedRaw);
  const personalFallback = cs2?.rankedSummary;
  const personal = personalBest || personalFallback;
  const personalBlock = personal ? `
    <div style="display:flex; flex-wrap:wrap; gap:14px;">
      ${quickStat('KDA', personal.kda)}
      ${quickStat('Avg Dmg', personal.avgDamage)}
      ${quickStat('Win Rate', (personal.winRate ?? 0) + '%')}
      ${quickStat('Top10%', (personal.top10Rate ?? 0) + '%')}
      ${quickStat('평균 순위', personal.avgRank ?? '-')}
    </div>
  ` : '<div style=\"font-size:12px;color:var(--text-dim)\">이 시즌 경쟁전 플레이 내역이 없습니다.</div>';
  const rankedModesBlock = buildRankedModesTable(cs2?.rankedRaw);
  seasonPanelEl.innerHTML = `
    <div class="card">
      <h3 class="section-title">시즌 선택</h3>
      <select id="seasonSelect" style="width:100%;background:#10151c;border:1px solid #2f3a45;color:var(--text);padding:8px 10px;border-radius:8px;margin-bottom:14px;">
        ${options}
      </select>
      ${renderRankedTier()}
      <div style="margin-top:10px;">${personalBlock}</div>
      ${rankedModesBlock}
    </div>
  `;
  const sel = document.getElementById('seasonSelect');
  sel.onchange = async () => {
    await loadSeason(sel.value);
  };
}

async function loadSeason(seasonId) {
  try {
    const url = `/api/player/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.name)}/season/${encodeURIComponent(seasonId)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.currentSeasonStats = data.season;
    state.selectedSeason = seasonId;
    renderHeader();
    renderSeasonPanel();
  } catch (e) {
    console.error(e);
    statusEl.textContent = '시즌 로드 오류: ' + e.message;
  }
}

function renderMapStatsPanel() {
  if (!state.mapStats || state.mapStats.length === 0) {
    mapPanelEl.innerHTML = '';
    return;
  }
  const rows = state.mapStats.slice(0, 8).map(m => `
    <tr>
      <td>${m.map}</td>
      <td>${m.matches}</td>
      <td>${m.wins}</td>
      <td>${m.winRate}%</td>
      <td>${m.avgRank}</td>
      <td>${m.avgKills}</td>
      <td>${m.avgDamage}</td>
    </tr>
  `).join('');
  mapPanelEl.innerHTML = `
    <div class="card">
      <h3 class="section-title">맵별 통계</h3>
      <table class="table" style="font-size:12px;">
        <thead>
          <tr>
            <th>맵</th><th>경기</th><th>승</th><th>승률</th><th>평균순위</th><th>KDA</th><th>Avg Dmg</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">최근 로드된 매치(첫 페이지 기준) 기반</div>
    </div>
  `;
}

// 좌측: 자주 함께한 팀원
function renderTeammatesPanel() {
  const list = state.topTeammates || [];
  if (!list.length) {
    topTeamPanelEl.innerHTML = '';
    return;
  }
  const rows = list.map(t => `
    <tr>
      <td>${t.name}</td>
      <td>${t.games}</td>
      <td>${t.avgRank ?? '-'}</td>
      <td>${t.avgDamage ?? 0}</td>
    </tr>
  `).join('');
  topTeamPanelEl.innerHTML = `
    <div class="card">
      <h3 class="section-title">자주 함께한 팀원</h3>
      <table class="table" style="font-size:12px;">
        <thead><tr><th>닉네임</th><th>함께한 판수</th><th>함께 플레이 시 평균순위</th><th>함께 플레이 시 Avg Dmg</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">최근 ${state.limit}게임 기준</div>
    </div>
  `;
}

// 좌측: 무기별 딜량
function renderWeaponPanel() {
  const ws = state.weaponStats;
  if (!ws || !ws.weapons || ws.weapons.length === 0) {
    weaponPanelEl.innerHTML = '';
    return;
  }
  const rows = ws.weapons.slice(0, 8).map(w => `
    <tr><td>${w.weapon}</td><td>${w.damage}</td></tr>
  `).join('');
  weaponPanelEl.innerHTML = `
    <div class="card">
      <h3 class="section-title">무기별 데미지</h3>
      <table class="table" style="font-size:12px;">
        <thead><tr><th>무기</th><th>누적 데미지</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">텔레메트리 기반 (${ws.note || ''}) 총 ${ws.total} dmg</div>
    </div>
  `;
}

function renderMatchesPanel() {
  const matchItems = state.matches.map(m => {
    if (m.error) {
      return `<div class="match fail"><div style="grid-column:1 / -1; color:var(--danger)">오류: ${m.error}</div></div>`;
    }
    const win = (m.my?.rank ?? m.my?.winPlace) === 1;
    const ranked = m.my?.rank ?? m.my?.winPlace ?? '-';
    // Metallic tiers
    const dmg = m.my?.damage ?? 0;
    const kills = m.my?.kills ?? 0;
    const r = m.my?.rank ?? m.my?.winPlace;
    const dmgClass = dmg >= 500 ? 'metal metal-gold' : (dmg >= 400 ? 'metal metal-silver' : (dmg >= 300 ? 'metal metal-bronze' : ''));
    const killClass = kills >= 4 ? 'metal metal-gold' : (kills >= 3 ? 'metal metal-silver' : (kills >= 2 ? 'metal metal-bronze' : ''));
    const rankClass = (r === 1) ? 'metal metal-gold' : (r === 2 || r === 3) ? 'metal metal-silver' : '';
    return `
      <div class="match ${win ? 'win' : 'fail'}">
        <div>
          <div class="mode">${m.gameMode}</div>
          <small>${new Date(m.createdAt).toLocaleString()}</small>
        </div>
        <div>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
      <span class="badge-lg ${rankClass}">Rank ${ranked}</span>
      <span class="badge-lg ${killClass}">Kills ${kills}</span>
      <span class="badge-lg ${dmgClass}">Dmg ${dmg}</span>
            <span class="badge-lg">Ast ${m.my?.assists ?? 0}</span>
            <span class="badge-lg">${displayMapName(m.mapName)}</span>
          </div>
        </div>
        <div style="text-align:right; font-size:12px;">
          ${win ? '<span style="color:var(--success); font-weight:600">WIN</span>' : ''}
          <div style="color:var(--text-dim)">${m.id.slice(0, 8)}</div>
          <button class="btnDetails" data-mid="${m.id}" style="margin-top:6px;background:#2b3441;border:1px solid #3a4656;color:#cbd6e2;padding:6px 10px;border-radius:18px;cursor:pointer;">자세히</button>
        </div>
      </div>
      <div class="match-detail" id="detail-${m.id}" style="display:none;"></div>
    `;
  }).join('');

  const loadMoreBtn = state.hasMore
    ? `<button id="loadMoreBtn" style="margin-top:14px;background:var(--accent-grad);border:none;color:#fff;padding:10px 20px;border-radius:30px;cursor:pointer;font-weight:600;">더 보기</button>`
    : `<div style="margin-top:14px;font-size:12px;color:var(--text-dim)">더 이상 매치가 없습니다.</div>`;

  panelsEl.innerHTML = `
    <div class="card">
      <h3 class="section-title">최근 매치 (${state.matches.length}${state.hasMore ? '+' : ''})</h3>
      <div class="matches">${matchItems}</div>
      ${loadMoreBtn}
    </div>
  `;

  if (state.hasMore) {
    document.getElementById('loadMoreBtn').onclick = () => {
      loadPage(state.matches.length);
    };
  }

  // 자세히 보기 버튼 핸들러 (inline toggle)
  document.querySelectorAll('.btnDetails').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const matchId = e.currentTarget.getAttribute('data-mid');
      const container = document.getElementById(`detail-${matchId}`);
      if (!container) return;
      if (container.dataset.loaded === 'true') {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        return;
      }
      container.style.display = 'block';
      await showMatchDetails(matchId, container);
    });
  });
} // <-- renderMatchesPanel

async function showMatchDetails(matchId, mountEl) {
  const detailEl = mountEl;
  detailEl.innerHTML = `<div class="card"><div>불러오는 중...</div></div>`;
  try {
    const url = `/api/player/${encodeURIComponent(state.platform)}/${encodeURIComponent(state.name)}/match/${encodeURIComponent(matchId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('match detail fetch failed');
    const data = await res.json();
    detailEl.innerHTML = renderMatchDetails(data);
    detailEl.dataset.loaded = 'true';
    wireMatchDetailInteractions(detailEl);
  } catch (e) {
    detailEl.innerHTML = `<div class=\"card\"><div style=\"color:var(--danger)\">오류: ${e.message}</div></div>`;
  }
}

function renderMatchDetails(d) {
  if (!d) return '';
  // Tabs: 개요 / 킬·사망 정보 (개요=팀 요약+플레이어 표 통합, 2열 카드)
  const overviewCombined = renderOverviewCombined(d);
  const killdeath = buildKillDeathComposite(d);
  const rawTab = renderRawKillLogs(d);
  const overview = overviewCombined;
  return `
    <div class="card popup">
      <div class="tab-nav">
        <button class="tab-btn active" data-tab="overview">개요</button>
        <button class="tab-btn" data-tab="kd">킬/사망 정보</button>
        <button class="tab-btn" data-tab="raw">원본 로그</button>
      </div>
      <div class="tab-panels">
        <div class="tab-panel active" data-tab="overview">
          <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">${new Date(d.createdAt).toLocaleString()} • ${displayMapName(d.mapName)}</div>
          ${overview}
        </div>
        <div class="tab-panel" data-tab="kd">
          ${killdeath}
        </div>
        <div class="tab-panel" data-tab="raw">
          ${rawTab}
        </div>
      </div>
    </div>`;
}

// 개요 통합: 팀 요약 + 플레이어 표를 하나의 작은 카드에 담고, 2열 그리드로 배치
function renderOverviewCombined(d) {
  const allPlayers = d.teams.flatMap(t => t.players);
  const maxDmg = Math.max(1, ...allPlayers.map(p => p.damage || 0));
  // 내 팀 탐지: 우선 d.my.teamId, 없으면 닉네임으로 탐색
  let myTeamId = (d.my && d.my.teamId != null) ? d.my.teamId : null;
  if (myTeamId == null && state && state.name) {
    const myName = String(state.name).toLowerCase();
    const hit = d.teams.find(t => (t.players || []).some(p => String(p.name || '').toLowerCase() === myName));
    if (hit) myTeamId = hit.teamId;
  }
  const cards = d.teams.map(t => {
    const sorted = [...t.players].sort((a, b) => (b.damage || 0) - (a.damage || 0));
    const rows = sorted.map(p => `
      <tr>
        <td>${p.name}</td>
        <td>${p.kills}/${p.deaths}/${p.assists}</td>
        <td>${p.damage.toFixed(2)}</td>
        <td>${p.DBNOs}</td>
      </tr>
    `).join('');
    const isMyTeam = (myTeamId != null) ? (t.teamId === myTeamId) : false;
    const highlight = isMyTeam ? 'border:2px solid #20d7c7; box-shadow: 0 0 0 2px rgba(32,215,199,0.12);' : '';
    return `
      <div class="mini-card" style="padding:10px; ${highlight}">
        <div style="display:flex;justify-content:space-between;align-items:center; margin-bottom:6px;">
          <div style="font-weight:600;">팀 ${t.teamId}</div>
          <div class="badge">순위 ${t.rank ?? '-'}</div>
        </div>
        <div class="note" style="margin:0 0 8px; font-size:11px;">합계: 킬 ${t.totals.kills}, 기절 ${t.totals.DBNOs}, 딜 ${t.totals.damage}</div>
        <div style="overflow:auto;">
          <table class="table team-table" data-team="${t.teamId}" style="font-size:12px; min-width:260px;">
            <thead>
              <tr>
                <th>플레이어</th>
                <th>K/D/A</th>
                <th>딜</th>
                <th>DBNO</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
  return `<div class="team-grid" style="display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:12px;">${cards}</div>`;
}

function renderOverviewTab(d) {
  // 팀 순위/딜량 요약, 2열 그리드로 배치
  const cards = d.teams.map(t => {
    return `
      <div class="mini-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><strong>팀 ${t.teamId}</strong></div>
          <div class="badge">순위 ${t.rank ?? '-'}</div>
        </div>
        <div class="note">킬 ${t.totals.kills} • 기절 ${t.totals.DBNOs} • 딜 ${t.totals.damage}</div>
      </div>
    `;
  }).join('');
  return `<div class="team-grid" style="display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:12px;">${cards}</div>`;
}

function renderPlayersTab(d) {
  const allPlayers = d.teams.flatMap(t => t.players);
  const maxDmg = Math.max(1, ...allPlayers.map(p => p.damage || 0));
  const teamBlocks = d.teams.map(t => {
    const sorted = [...t.players].sort((a, b) => (b.damage || 0) - (a.damage || 0));
    const rows = sorted.map(p => {
      const pct = Math.min(100, Math.round((p.damage || 0) / maxDmg * 100));
      return `
        <tr>
          <td>${p.name}</td>
          <td>${p.kills}/${p.deaths}/${p.assists}</td>
            <td>${p.damage.toFixed(2)}</td>
          <td>${p.DBNOs}</td>
          <td style="min-width:140px">
            <div class="progress-bar"><span style="width:${pct}%"></span></div>
          </td>
        </tr>
      `;
    }).join('');
    return `
      <div class="card" style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div><strong>팀 ${t.teamId}</strong> ${t.rank ? `(순위 ${t.rank})` : ''}</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:12px;color:var(--text-dim)">합계: 킬 ${t.totals.kills}, 기절 ${t.totals.DBNOs}, 딜 ${t.totals.damage}</div>
            <label style="font-size:12px;color:var(--text-dim)">정렬
              <select class="team-sort" data-team="${t.teamId}" style="margin-left:6px;background:#10151c;border:1px solid #2f3a45;color:#cbd6e2;padding:3px 6px;border-radius:6px;">
                <option value="damage" selected>딜 내림차순</option>
                <option value="kills">킬 내림차순</option>
                <option value="dbno">DBNO 내림차순</option>
                <option value="name">이름 오름차순</option>
              </select>
            </label>
          </div>
        </div>
        <div style="overflow:auto;">
          <table class="table team-table" data-team="${t.teamId}" style="font-size:12px; min-width:520px;">
            <thead>
              <tr>
                <th>플레이어</th>
                <th>K/D/A</th>
                <th>딜</th>
                <th>DBNO</th>
                <th>딜량</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
  return teamBlocks;
}

function wireMatchDetailInteractions(container) {
  // Tab switching (개요 / 킬/사망 정보)
  const tabButtons = container.querySelectorAll('.tab-btn');
  if (tabButtons && tabButtons.length) {
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        container.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.getAttribute('data-tab') === tab));
      });
    });
  }

  // Sorting per team
  container.querySelectorAll('.team-sort').forEach(sel => {
    sel.addEventListener('change', () => {
      const teamId = sel.getAttribute('data-team');
      const table = container.querySelector(`.team-table[data-team="${teamId}"]`);
      if (!table) return;
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const by = sel.value;
      function parseK(row) {
        const txt = row.children[1]?.textContent || '0/0/0';
        const m = txt.match(/(\d+)\/(\d+)\/(\d+)/);
        return m ? { k: +m[1], d: +m[2], a: +m[3] } : { k: 0, d: 0, a: 0 };
      }
      function numAt(idx) { return (row) => +((row.children[idx]?.textContent || '0').replace(/[^\d.\-]/g, '')) || 0; }
      let cmp;
      if (by === 'damage') cmp = (r1, r2) => numAt(2)(r2) - numAt(2)(r1);
      else if (by === 'kills') cmp = (r1, r2) => parseK(r2).k - parseK(r1).k;
      else if (by === 'dbno') cmp = (r1, r2) => numAt(3)(r2) - numAt(3)(r1);
      else if (by === 'name') cmp = (r1, r2) => (r1.children[0]?.textContent || '').localeCompare(r2.children[0]?.textContent || '');
      rows.sort(cmp);
      rows.forEach(r => tbody.appendChild(r));
    });
  });

  // 지도 팬/줌 버튼 동작 보장: DOM 삽입 후 핸들러 연결
  container.querySelectorAll('.mapwrap').forEach(wrap => {
    if (wrap.id) enablePanZoom(wrap.id);
  });

  // Kill/Death log filter buttons
  const logBox = container.querySelector('.kd-log-box');
  if (logBox) {
    const buttons = logBox.querySelectorAll('.kd-log-tabs button');
    const list = logBox.querySelector('#kdLogList');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        const mode = btn.getAttribute('data-kdf');
        if (!list) return;
        list.querySelectorAll('.kd-log-item').forEach(li => {
          if (mode === 'all') li.style.display = '';
          else if (mode === 'kill') li.style.display = li.classList.contains('kill') ? '' : 'none';
          else if (mode === 'death') li.style.display = li.classList.contains('death') ? '' : 'none';
        });
      });
    });
  }
}

function mapNameToAssetKey(mapName) {
  // 서버의 nameMaps.json(maps)을 사용해 내부명을 표시명으로 먼저 변환한 뒤, 파일 키 규칙에 맞춰 후처리
  const raw = mapName || '';
  const maps = (nameMapsCache && nameMapsCache.maps) ? nameMapsCache.maps : null;
  // nameMaps의 값은 표시명(예: "Erangel", "Miramar"); 파일 키는 보통 {InternalKey}_... 또는 {Display}_Main 형식
  // 안전한 전략: 내부키가 파일 네이밍에 가장 직접적이므로, 내부키에서 _Main을 유지하고, 필요 시 표시명 기반으로 보정
  if (!raw) return raw;
  // 내부키가 nameMaps에 있으면 '표시명_Main'으로 변환 (예: Baltic_Main -> Erangel_Main)
  if (maps && maps[raw]) {
    return `${maps[raw]}_Main`;
  }
  // raw가 이미 표시명 또는 내부키로서 _Main을 포함하면 그대로 사용
  if (/_Main$/.test(raw)) return raw;
  // 그 외에는 표시명으로 가정하고 _Main 접미사 부여
  return `${raw}_Main`;
}

// 사용자 친화적 맵 표시명으로 변환 (nameMaps.json 활용)
function displayMapName(mapName) {
  const maps = (nameMapsCache && nameMapsCache.maps) ? nameMapsCache.maps : null;
  if (!mapName) return '';
  return (maps && maps[mapName]) ? maps[mapName] : mapName;
}

function weaponCodeToIcon(weaponCode) {
  if (!weaponCode) return null;
  // WeapHK416_C -> Item_Weapon_HK416_C.png (Main)
  if (weaponCode.startsWith('Weap')) {
    const suffix = weaponCode.substring(4);
    return `/assets/Item/Weapon/Main/Item_Weapon_${suffix}.png`;
  }
  // Known special cases in Weapon/Main
  const map = {
    'PanzerFaust100M_Projectile_C': '/assets/Item/Weapon/Main/Item_Weapon_PanzerFaust100M_C.png',
    'WeapPanzerFaust100M1_C': '/assets/Item/Weapon/Main/Item_Weapon_PanzerFaust100M_C.png'
  };
  if (map[weaponCode]) return map[weaponCode];
  // Vehicles (use vehicle icon)
  if (/Uaz_|Dacia_|Mirado|PickupTruck|Rony|Niva|Van_A_|Buggy|Scooter|Motor|CoupeRB|PonyCoupe|Porter|BRDM|Boat|PG117|AquaRail|Motorglider|Snowmobile|Snowbike/i.test(weaponCode)) {
    const file = Object.keys(vehicleIconAliases).find(k => weaponCode.includes(k)) || null;
    if (file) return `/assets/Vehicle/${vehicleIconAliases[file]}`;
  }
  return null;
}

// vehicle code to asset filename aliases (subset)
const vehicleIconAliases = {
  'Dacia_A_00_v2_C': 'Dacia_A_00_v2_C.png',
  'Uaz_': 'Uaz_A_00_C.png',
  'Mirado': 'BP_Mirado_A_00_C.png',
  'PickupTruck': 'BP_PickupTruck_A_00_C.png',
  'Rony': 'BP_M_Rony_A_00_C.png',
  'Niva': 'BP_Niva_00_C.png',
  'Van_A_00': 'BP_Van_A_00_C.png',
  'Buggy': 'Buggy_A_00_C.png',
  'Scooter': 'BP_Scooter_00_A_C.png',
  'Motorbike_00_SideCar': 'BP_Motorbike_00_SideCar_C.png',
  'Motorbike_00': 'BP_Motorbike_00_C.png',
  'CoupeRB': 'BP_CoupeRB_C.png',
  'PonyCoupe': 'BP_PonyCoupe_C.png',
  'Porter': 'BP_Porter_C.png',
  'BRDM': 'BP_BRDM_C.png',
  'Boat_PG117_C': 'Boat_PG117_C.png',
  'AquaRail': 'AquaRail_A_00_C.png',
  'Motorglider': 'BP_Motorglider_C.png',
  'Snowmobile': 'BP_Snowmobile_00_C.png',
  'Snowbike': 'BP_Snowbike_00_C.png'
};

function renderKillMap(d) {
  const key = mapNameToAssetKey(d.mapName);
  const hi = `/assets/Maps/converted-webp-4096/${key}_High_Res.webp`;
  // 1) 이벤트 수집 (id 부여)
  const killEvents = (d.kills || []).slice(0, 200).map((k, i) => ({
    type: 'kill',
    id: 'k' + i,
    nx: k.nx, ny: k.ny,
    raw: k,
    title: `${k.victim} • ${k.weapon}${k.headshot ? ' • HS' : ''}${k.distance ? ' • ' + Math.round(k.distance) + 'm' : ''}${(typeof k.timeSec === 'number') ? ' • ' + formatMMSS(k.timeSec) : (k.time ? ' • ' + new Date(k.time).toLocaleTimeString() : '')}`
  }));
  const deathEvents = (d.deaths || []).slice(0, 50).map((k, i) => ({
    type: 'death',
    id: 'd' + i,
    nx: k.nx, ny: k.ny,
    raw: k,
    title: `☠ by ${k.attacker} • ${k.weapon}${k.headshot ? ' • HS' : ''}${k.distance ? ' • ' + Math.round(k.distance) + 'm' : ''}${(typeof k.timeSec === 'number') ? ' • ' + formatMMSS(k.timeSec) : (k.time ? ' • ' + new Date(k.time).toLocaleTimeString() : '')}`
  }));
  const allEvents = [...killEvents, ...deathEvents].filter(e => e.nx != null && e.ny != null);
  // 2) 클러스터 계산
  const clusters = computePinClusters(allEvents, 0.015); // 약 1.5% 거리
  const clusteredIds = new Set(clusters.flatMap(c => c.ids));
  // 3) 기본 핀 생성 (클러스터에 속한 것은 hidden)
  const basePins = allEvents.map(ev => buildPin({
    id: ev.id,
    nx: ev.nx,
    ny: ev.ny,
    left: ev.nx * 100,
    top: ev.ny * 100,
    icon: weaponCodeToIcon(ev.raw.weaponCode),
    color: ev.type === 'kill' ? 'rgba(80,140,255,.95)' : 'rgba(255,80,80,.9)',
    title: ev.title,
    hidden: clusteredIds.has(ev.id),
    extraClass: (clusteredIds.has(ev.id) ? 'cluster-member' : '') + ' pin-base pin-' + ev.type
  })).join('');
  // 4) 클러스터 핀 생성
  const clusterPins = clusters.map((c, idx) => {
    // 단순 총 개수만 표시
    const label = c.ids.length;
    const listHtml = c.ids.map(cid => {
      const ev = allEvents.find(e => e.id === cid);
      if (!ev) return '';
      return `<div class="cluster-item" data-target="${cid}" style="padding:4px 6px;cursor:pointer;display:flex;gap:4px;align-items:center;">` +
        `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ev.type === 'kill' ? '#508cff' : '#ff5050'}"></span>` +
        `<span style="font-size:11px;">${escapeHtml(ev.raw.timeSec != null ? formatMMSS(ev.raw.timeSec) : '')} ${escapeHtml(ev.type === 'kill' ? (ev.raw.victim || '') : (ev.raw.attacker || ''))}</span>` +
        `</div>`;
    }).join('');
    const title = `클러스터 ${label}`;
    return `
      <div class="pin cluster-pin" data-cluster="1" data-members="${c.ids.join(',')}" style="left:${c.cx * 100}%;top:${c.cy * 100}%;background:#ffd247;color:#1a1d21;font-weight:700;border:1px solid #d9b200;width:8px;height:8px;">
        <span style="font-size:9px;line-height:1;">${label}</span>
        <div class="pop cluster-pop" style="position:absolute; left:12px; top:-4px; background:rgba(15,18,25,.97); border:1px solid #3a4660; color:#d6e2ef; font-size:11px; padding:6px 8px; border-radius:6px; display:none; max-height:180px; overflow:auto; min-width:140px;">
          <div style="font-weight:600;margin-bottom:4px;">이벤트</div>
          ${listHtml}
          <div style="border-top:1px solid #2d3643;margin-top:4px;padding-top:4px;font-size:10px;color:#7d8b9b;">하나 선택 → 확장</div>
        </div>
      </div>`;
  }).join('');
  const content = basePins + clusterPins;
  const id = `map-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div id="${id}" class="mapwrap" style="position:relative; width:100%; max-width:820px; aspect-ratio:1; background:#0e131a; border:1px solid #2f3a45; border-radius:10px; overflow:hidden; margin-bottom:12px; touch-action:none;">
      <div class="map-canvas" style="position:absolute; inset:0; transform-origin: 0 0;">
        <img class="map-img" src="${hi}" alt="map" style="position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover; filter:contrast(1.05) saturate(1.05);"/>
        <div class="pins" style="position:absolute; left:0; top:0; width:100%; height:100%;">
          ${content}
        </div>
      </div>
  <div class="cluster-overlay" style="position:absolute;inset:0;z-index:60;pointer-events:none;"></div>
      <div class="map-controls" style="position:absolute; right:8px; bottom:8px; display:flex; gap:6px;">
        <button data-zoom="in" style="background:#2b3441;border:1px solid #3a4656;color:#cbd6e2;padding:6px 9px;border-radius:8px;cursor:pointer;">+</button>
        <button data-zoom="out" style="background:#2b3441;border:1px solid #3a4656;color:#cbd6e2;padding:6px 9px;border-radius:8px;cursor:pointer;">-</button>
        <button data-zoom="reset" style="background:#2b3441;border:1px solid #3a4656;color:#cbd6e2;padding:6px 9px;border-radius:8px;cursor:pointer;">Reset</button>
      </div>
    </div>
  `;
}

// 간단한 O(n^2) 근접 클러스터링 (이벤트 수가 많지 않으므로 허용)
function computePinClusters(events, thresholdNorm = 0.015) {
  const visited = new Set();
  const clusters = [];
  for (let i = 0; i < events.length; i++) {
    if (visited.has(events[i].id)) continue;
    const e = events[i];
    const group = [e];
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j];
      if (visited.has(f.id)) continue;
      const dx = (e.nx - f.nx);
      const dy = (e.ny - f.ny);
      if ((dx * dx + dy * dy) <= thresholdNorm * thresholdNorm) {
        group.push(f);
      }
    }
    if (group.length >= 2) {
      group.forEach(g => visited.add(g.id));
      const cx = group.reduce((s, g) => s + g.nx, 0) / group.length;
      const cy = group.reduce((s, g) => s + g.ny, 0) / group.length;
      clusters.push({ ids: group.map(g => g.id), cx, cy });
    }
  }
  return clusters;
}

// 새: 지도 + 로그 콤포지트
function buildKillDeathComposite(d) {
  const mapHtml = renderKillMap(d);
  const logHtml = buildKillDeathLog(d);
  return `<div class="kd-grid">${mapHtml}<div class="kd-log-box">${logHtml}</div></div>`;
}

function buildKillDeathLog(d) {
  const kills = Array.isArray(d.kills) ? d.kills : [];
  const deaths = Array.isArray(d.deaths) ? d.deaths : [];
  // 통합 타임라인: 시간(초) 기준 정렬 (없으면 time 문자열에서 Date parse)
  const events = [];
  kills.forEach(k => {
    events.push({
      kind: 'kill',
      timeSec: (typeof k.timeSec === 'number' ? k.timeSec : (k.time ? Date.parse(k.time) : null)),
      rawTime: k.time,
      victim: k.victim,
      weapon: k.weapon,
      weaponCode: k.weaponCode,
      headshot: k.headshot,
      distance: k.distance,
      inferred: false
    });
  });
  deaths.forEach(k => {
    events.push({
      kind: 'death',
      timeSec: (typeof k.timeSec === 'number' ? k.timeSec : (k.time ? Date.parse(k.time) : null)),
      rawTime: k.time,
      attacker: k.attacker,
      weapon: k.weapon,
      weaponCode: k.weaponCode,
      headshot: k.headshot,
      distance: k.distance,
      inferred: !!k.inferred
    });
  });
  events.sort((a, b) => (a.timeSec ?? 0) - (b.timeSec ?? 0));
  const itemHtml = events.map(ev => {
    const tLabel = (typeof ev.timeSec === 'number' && ev.timeSec < 60 * 60) ? formatMMSS(ev.timeSec) : (ev.rawTime ? new Date(ev.rawTime).toLocaleTimeString() : '-');
    const dist = (ev.distance != null && isFinite(ev.distance)) ? `<span class="dist">${Math.round(ev.distance)}m</span>` : '';
    const head = ev.headshot ? '<span class="dist" style="color:#ff9dc2">HS</span>' : '';
    const weapon = ev.weapon ? `<span class="weapon">${ev.weapon}</span>` : '';
    const infer = ev.inferred ? '<span class="inferred">추정</span>' : '';
    if (ev.kind === 'kill') {
      return `<li class="kd-log-item kill"><time>${tLabel}</time><span class="etype">킬</span><span class="who">${escapeHtml(ev.victim || 'Unknown')}</span>${weapon}${dist}${head}${infer}</li>`;
    } else {
      return `<li class="kd-log-item death"><time>${tLabel}</time><span class="etype">사망</span><span class="who">${escapeHtml(ev.attacker || 'Unknown')}</span>${weapon}${dist}${head}${infer}</li>`;
    }
  }).join('');
  const empty = '<div class="kd-log-empty">킬/사망 이벤트가 없습니다.</div>';
  const list = itemHtml ? `<ul class="kd-log-list" id="kdLogList">${itemHtml}</ul>` : empty;
  const tabs = `<div class="kd-log-tabs"><button class="kdflt active" data-kdf="all">전체</button><button data-kdf="kill">킬</button><button data-kdf="death">사망</button></div>`;
  return `${tabs}${list}`;
}

function buildPin({ id, nx, ny, left, top, icon, color, title, hidden, extraClass }) {
  const style = `left:${left}%;top:${top}%;background:${color};${hidden ? 'display:none;' : ''}`;
  const safeTitle = title?.replace(/["<>]/g, '') || '';
  const cls = 'pin ' + (extraClass || '');
  return `
  <div class="${cls}" data-id="${id || ''}" style="${style}" tabindex="0" aria-label="${safeTitle}" data-nx="${(nx ?? '').toString()}" data-ny="${(ny ?? '').toString()}">
      ${icon ? `<img src="${icon}" alt=""/>` : '<span></span>'}
      <div class="pop" style="position:absolute; left:12px; top:-4px; background:rgba(10,12,16,.95); border:1px solid #2e3845; color:#c9d4e0; font-size:11px; padding:5px 8px; border-radius:6px; white-space:nowrap; display:none;">${safeTitle}</div>
    </div>
  `;
}

function enablePanZoom(rootId) {
  const root = document.getElementById(rootId);
  if (!root) return;
  if (root.dataset.pzWired === '1') return;
  const canvas = root.querySelector('.map-canvas');
  const btnIn = root.querySelector('[data-zoom="in"]');
  const btnOut = root.querySelector('[data-zoom="out"]');
  const btnReset = root.querySelector('[data-zoom="reset"]');
  // 원점 토글 제거: 항상 BL 기준
  let scale = 1, tx = 0, ty = 0;
  let dragging = false, sx = 0, sy = 0;
  function apply() { canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; }
  // scale 값을 dataset에 노출 (클러스터 팝업 위치/보정 등 추가 기능 대비)
  function applyWithDataset() { apply(); root.dataset.scale = String(scale); }
  // apply 교체
  function applyWrapper() { applyWithDataset(); }
  // 최초 dataset 설정
  root.dataset.scale = String(scale);
  function clampScale(s) { return Math.min(4, Math.max(1, s)); }
  // Mouse wheel zoom
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    const prev = scale;
    scale = clampScale(scale * (delta < 0 ? 1.1 : 0.9));
    // keep centered roughly
    const rect = root.getBoundingClientRect();
    const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
    const k = scale / prev - 1;
    tx -= (cx - tx) * k; ty -= (cy - ty) * k;
    applyWithDataset();
  }, { passive: false });
  // Drag
  root.addEventListener('pointerdown', (e) => {
    // 버튼/컨트롤/팝오버 클릭 시 드래그 시작 방지
    const t = e.target;
    if (t.closest && (t.closest('.map-controls') || t.closest('button') || t.closest('.pin'))) return;
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => { if (!dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; applyWithDataset(); });
  root.addEventListener('pointerup', (e) => { dragging = false; root.releasePointerCapture(e.pointerId); });
  btnIn && (btnIn.onclick = () => { scale = clampScale(scale * 1.2); applyWithDataset(); });
  btnOut && (btnOut.onclick = () => { scale = clampScale(scale / 1.2); applyWithDataset(); });
  btnReset && (btnReset.onclick = () => { scale = 1; tx = 0; ty = 0; applyWithDataset(); });
  // 원점 토글 없음
  // Pin popovers - 줌에 상관없이 일정한 크기로 표시
  root.querySelectorAll('.pin').forEach(pin => {
    const pop = pin.querySelector('.pop');
    if (!pop) return;

    // 기존 팝업을 완전히 비활성화
    pop.style.display = 'none !important';
    pop.style.visibility = 'hidden';
    pop.style.opacity = '0';
    pop.style.pointerEvents = 'none';

    pin.addEventListener('mouseenter', () => {
      if (pop && !pin.classList.contains('cluster-pin')) {
        showPinOverlayPopup(root, pin, pop);
      }
    });
    pin.addEventListener('mouseleave', () => {
      if (!pin.classList.contains('cluster-pin')) {
        hidePinOverlayPopup(root);
      }
    });
    pin.addEventListener('focus', () => {
      if (pop && !pin.classList.contains('cluster-pin')) {
        showPinOverlayPopup(root, pin, pop);
      }
    });
    pin.addEventListener('blur', () => {
      if (!pin.classList.contains('cluster-pin')) {
        hidePinOverlayPopup(root);
      }
    });
  });
  setupClusterInteractions(root);
  root.dataset.pzWired = '1';
}

function setupClusterInteractions(root) {
  const mapCanvas = root.querySelector('.map-canvas');
  if (!mapCanvas) return;
  const overlay = root.querySelector('.cluster-overlay');
  // 클러스터 핀 hover 시 팝 표시 (기본 pop 로직 이미 있음)
  root.querySelectorAll('.cluster-pin').forEach(cp => {
    const pop = cp.querySelector('.cluster-pop');
    if (!pop) return;
    // hover 시 overlay에 고정 팝업 생성 (줌 배율 무관)
    cp.addEventListener('mouseenter', () => {
      if (root.dataset.clusterExpanded === '1') return;
      showClusterOverlayPopup(root, cp, pop, overlay);
    });
    // 클러스터 오리지널 pop 내부 클릭 바인딩은 overlay 복제본에서만 처리 (중복 제거)
  });
  // 바깥 클릭 복원
  root.addEventListener('click', (e) => {
    if (root.dataset.clusterExpanded === '1') {
      // 핀 또는 팝 클릭이면 무시
      if (e.target.closest('.pin') || e.target.closest('.cluster-popup-fixed')) return;
      restoreClusters(root);
      hideClusterOverlayPopup(root);
    } else {
      // 확장 전 상태에서 클러스터 아이템 클릭은 허용
      if (e.target.closest('.cluster-item')) {
        return;
      }
      // 핀 외부 클릭 시 팝업 닫기
      if (!e.target.closest('.cluster-pin') && !e.target.closest('.cluster-popup-fixed')) {
        hideClusterOverlayPopup(root);
      }
    }
  });
}

function showPinOverlayPopup(root, pin, popOriginal) {
  const overlay = root.querySelector('.cluster-overlay');
  if (!overlay || !popOriginal) return;

  // 기존 팝업 제거
  hidePinOverlayPopup(root);

  // 기존 팝업 숨기기
  popOriginal.style.display = 'none';

  const rectRoot = root.getBoundingClientRect();
  const rectPin = pin.getBoundingClientRect();
  const div = document.createElement('div');
  div.className = 'pin-popup-fixed';
  div.style.position = 'absolute';
  div.style.left = (rectPin.left - rectRoot.left + 12) + 'px';
  div.style.top = (rectPin.top - rectRoot.top - 4) + 'px';
  div.style.background = 'rgba(10,12,16,.95)';
  div.style.border = '1px solid #2e3845';
  div.style.color = '#c9d4e0';
  div.style.fontSize = '11px';
  div.style.padding = '5px 8px';
  div.style.borderRadius = '6px';
  div.style.whiteSpace = 'nowrap';
  div.style.pointerEvents = 'none';
  div.style.zIndex = '9998';
  div.innerHTML = popOriginal.innerHTML;
  overlay.appendChild(div);
}

function hidePinOverlayPopup(root) {
  const overlay = root.querySelector('.cluster-overlay');
  if (!overlay) return;
  overlay.querySelectorAll('.pin-popup-fixed').forEach(el => el.remove());

  // 모든 일반 핀의 기존 팝업도 숨기기
  root.querySelectorAll('.pin:not(.cluster-pin) .pop').forEach(pop => {
    pop.style.display = 'none';
  });
}

function showClusterOverlayPopup(root, clusterPin, popOriginal, overlay) {
  if (!overlay || !popOriginal) return;
  // 기존 팝업 제거
  hideClusterOverlayPopup(root);
  // 오버레이가 클릭을 받을 수 있도록 활성화
  overlay.style.pointerEvents = 'auto';
  const rectRoot = root.getBoundingClientRect();
  const rectPin = clusterPin.getBoundingClientRect();
  const div = document.createElement('div');
  div.className = 'cluster-popup-fixed';
  div.style.position = 'absolute';
  div.style.left = (rectPin.left - rectRoot.left + 12) + 'px';
  div.style.top = (rectPin.top - rectRoot.top - 4) + 'px';
  div.style.background = 'rgba(15,18,25,.97)';
  div.style.border = '1px solid #3a4660';
  div.style.color = '#d6e2ef';
  div.style.fontSize = '11px';
  div.style.padding = '6px 8px';
  div.style.borderRadius = '6px';
  div.style.maxHeight = '180px';
  div.style.overflow = 'auto';
  div.style.minWidth = '140px';
  div.style.pointerEvents = 'auto';
  div.style.zIndex = '9999'; // 매우 높은 z-index
  div.innerHTML = popOriginal.innerHTML; // 복제
  // 내부 아이템 클릭 재바인딩 - 이벤트 캐처링 사용
  div.addEventListener('click', (e) => {
    // 클릭된 요소가 cluster-item이거나 그 내부 요소인지 확인
    const clusterItem = e.target.closest('.cluster-item');
    if (clusterItem) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // 추가: 다른 핸들러도 차단
      const targetId = clusterItem.getAttribute('data-target');
      hideClusterOverlayPopup(root);
      expandCluster(clusterPin, targetId, root);
    }
  }, true); // 캐처링 모드 사용

  // 디버깅을 위한 개별 바인딩도 유지
  div.querySelectorAll('.cluster-item').forEach((item, index) => {
    // mousedown에서 직접 처리 (click이 차단되는 문제 해결)
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const targetId = item.getAttribute('data-target');
      hideClusterOverlayPopup(root);
      expandCluster(clusterPin, targetId, root);
    });
  });
  overlay.appendChild(div);
}

function hideClusterOverlayPopup(root) {
  const overlay = root.querySelector('.cluster-overlay');
  if (!overlay) return;
  overlay.querySelectorAll('.cluster-popup-fixed').forEach(el => el.remove());
  overlay.querySelectorAll('.pin-popup-fixed').forEach(el => el.remove());
  // 팝업이 없으면 다시 통과시켜 hover 가능
  overlay.style.pointerEvents = 'none';
}

function expandCluster(clusterPin, focusId, root) {
  if (root.dataset.clusterExpanded === '1') return; // 중복 방지

  // 클러스터 핀들의 원래 HTML을 저장 (복원용)
  if (!root.dataset.originalClusterHtml) {
    const clusterPins = root.querySelectorAll('.cluster-pin');
    root.dataset.originalClusterHtml = Array.from(clusterPins).map(cp => cp.outerHTML).join('');
  }

  const members = (clusterPin.getAttribute('data-members') || '').split(',').filter(Boolean);
  const pins = members.map(id => root.querySelector(`.pin[data-id="${id}"]`)).filter(Boolean);

  if (!pins.length) return;

  // 숨겨진 개별 핀 표시
  pins.forEach(p => { p.style.display = 'block'; });
  // 모든 기본 핀 중 선택된 것 제외하고 반투명 처리
  root.querySelectorAll('.pin.pin-base').forEach(p => {
    const pid = p.getAttribute('data-id');
    if (pid === focusId) {
      p.style.opacity = '1';
      p.style.zIndex = '20';
    } else {
      p.style.opacity = '0.5'; // 0.75에서 0.5로 변경
      p.style.zIndex = members.includes(pid) ? '10' : '1';
    }
    if (pid !== focusId) p.style.transform = 'translate(-50%, -50%)'; // 원래 중앙 정렬로 복원
  });
  // 선택 핀 강조
  const sel = root.querySelector(`.pin[data-id="${focusId}"]`);
  if (sel) {
    sel.style.transform = 'translate(-50%, -50%) scale(1.1)'; // 중앙 정렬 유지하면서 확대
    // sel.style.boxShadow = '0 0 0 3px rgba(255,255,255,0.25)'; // 흰색 테두리 제거
    sel.style.zIndex = '20';
  }
  // 클러스터 핀 숨김
  clusterPin.style.display = 'none';
  // 다른 클러스터 핀 숨김
  root.querySelectorAll('.cluster-pin').forEach(cp => { if (cp !== clusterPin) cp.style.display = 'none'; });
  root.dataset.clusterExpanded = '1';
}

function restoreClusters(root) {
  // 원래 클러스터 HTML이 저장되어 있다면 완전히 복원
  if (root.dataset.originalClusterHtml) {
    // 기존 클러스터 핀들 제거
    root.querySelectorAll('.cluster-pin').forEach(cp => cp.remove());

    // 원래 HTML 복원
    const mapCanvas = root.querySelector('.map-canvas');
    if (mapCanvas) {
      mapCanvas.insertAdjacentHTML('beforeend', root.dataset.originalClusterHtml);

      // 복원된 클러스터 핀들에 이벤트 다시 바인딩
      setupClusterInteractions(root);
    }

    // 저장된 HTML 삭제
    delete root.dataset.originalClusterHtml;
  } else {
    // 기본 복원 방식 (fallback)
    root.querySelectorAll('.cluster-pin').forEach(cp => {
      cp.style.display = 'block';
      cp.style.removeProperty('opacity');
      cp.style.removeProperty('transform');
      cp.style.removeProperty('box-shadow');
      cp.style.removeProperty('z-index');
      cp.style.removeProperty('position');
      const pop = cp.querySelector('.cluster-pop');
      if (pop) pop.style.display = 'none';
    });
  }

  // 클러스터 멤버 개별 핀 다시 숨김
  root.querySelectorAll('.pin.cluster-member').forEach(p => {
    p.style.display = 'none';
    p.style.opacity = '1';
    p.style.removeProperty('transform');
    // p.style.removeProperty('box-shadow'); // 박스섀도우 제거됨
    p.style.removeProperty('z-index');
  });
  // 나머지 기본 핀 원복
  root.querySelectorAll('.pin.pin-base').forEach(p => {
    if (!p.classList.contains('cluster-member')) {
      p.style.opacity = '1';
      p.style.removeProperty('transform');
      // p.style.removeProperty('box-shadow'); // 박스섀도우 제거됨
      p.style.removeProperty('z-index');
    }
  });
  root.dataset.clusterExpanded = '0';
}

function renderRawKillLogs(d) {
  const arr = Array.isArray(d.rawKillLogs) ? d.rawKillLogs : [];
  if (!arr.length) return '<div class="note">원본 텔레메트리 로그가 없습니다.</div>';
  const pretty = JSON.stringify(arr.slice(0, 200), null, 2);
  return `
    <div style="max-height:420px; overflow:auto; background:#0e131a; border:1px solid #2f3a45; border-radius:8px; padding:10px;">
      <pre style="margin:0; font-size:11px; color:#bcd0e0;">${escapeHtml(pretty)}</pre>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// quickStat 함수가 위에서 사용되므로 여기서 정의 (누락 복구)
function quickStat(label, value) {
  return `<div class="stat"><label>${label}</label><value>${value}</value></div>`;
}

// 125 -> "2:05" 형식으로 표시
function formatMMSS(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// 모드별 Ranked 상세 표 생성
function buildRankedModesTable(rankedRaw) {
  const modes = rankedRaw && typeof rankedRaw === 'object' ? Object.keys(rankedRaw) : [];
  if (!modes.length) return '';
  const rows = modes
    .map(k => ({ key: k, v: rankedRaw[k] }))
    .filter(x => x && x.v && ((x.v.roundsPlayed || 0) > 0 || (x.v.kills || 0) > 0))
    .sort((a, b) => (b.v.roundsPlayed || 0) - (a.v.roundsPlayed || 0))
    .map(({ key, v }) => {
      const ct = v.currentTier;
      const tier = ct && typeof ct === 'object' ? ct.tier : (v.tier || '');
      const sub = ct && typeof ct === 'object' ? ct.subTier : (v.subTier || '');
      const best = v.bestTier && typeof v.bestTier === 'object' ? `${v.bestTier.tier} ${v.bestTier.subTier || ''}` : '';
      const pts = v.currentRankPoint ?? v.rankPoint ?? v.currentRankPoints ?? '';
      const rounds = v.roundsPlayed ?? 0;
      const wins = v.wins ?? 0;
      const winRatio = v.winRatio != null ? +(v.winRatio * 100).toFixed(1) : (rounds ? +((wins / rounds) * 100).toFixed(1) : 0);
      const top10 = v.top10Ratio != null ? +(v.top10Ratio * 100).toFixed(1) : null;
      const avgRank = v.avgRank != null ? +(+v.avgRank).toFixed(2) : '';
      const kda = v.kda != null ? +(+v.kda).toFixed(2) : (v.deaths > 0 ? +(((v.kills || 0) + (v.assists || 0)) / v.deaths).toFixed(2) : (v.kills || 0) + (v.assists || 0));
      const kills = v.kills ?? 0;
      const dmgTotal = v.damageDealt != null ? +(+v.damageDealt).toFixed(1) : 0;
      const avgDmg = rounds > 0 ? +(dmgTotal / rounds).toFixed(1) : 0;
      const hsPct = v.headshotKillRatio != null
        ? +(v.headshotKillRatio * 100).toFixed(1)
        : (kills > 0 ? +(((v.headshotKills || 0) / kills) * 100).toFixed(1) : 0);
      return `
        <tr>
          <td style="text-transform:uppercase">${key}</td>
          <td>${tier ? `${tier} ${sub || ''}` : '-'}</td>
          <td>${pts || '-'}</td>
          <td>${rounds}</td>
          <td>${wins} (${winRatio}%)</td>
          <td>${top10 != null ? top10 + '%' : '-'}</td>
          <td>${avgRank || '-'}</td>
          <td>${kda}</td>
          <td>${kills}</td>
      <td>${avgDmg}</td>
          <td>${hsPct}%</td>
          <td>${best || '-'}</td>
        </tr>
      `;
    })
    .join('');
  if (!rows) return '';
  return `
    <div style="margin-top:16px;">
      <h3 class="section-title">모드별 경쟁전 상세</h3>
      <table class="table" style="font-size:12px;">
        <thead>
          <tr>
            <th>모드</th>
            <th>티어</th>
            <th>포인트</th>
            <th>판수</th>
            <th>승 (승률)</th>
            <th>Top10%</th>
            <th>Avg Rank</th>
            <th>KDA</th>
            <th>최다 Kill</th>
            <th>Avg Dmg</th>
            <th>헤드샷%</th>
            <th>최고티어</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="note">PUBG Ranked 전용 엔드포인트 기반</div>
    </div>
  `;
}

// 포인트가 가장 높은 랭크 모드 기준으로 개인 요약 생성
function buildPersonalFromBestRankedMode(rankedRaw) {
  if (!rankedRaw || typeof rankedRaw !== 'object') return null;
  const entries = Object.entries(rankedRaw)
    .filter(([, v]) => v && ((v.roundsPlayed || 0) > 0 || (v.kills || 0) > 0));
  if (!entries.length) return null;
  // currentRankPoint(우선) → rankPoint → currentRankPoints 순으로 포인트 사용
  entries.sort((a, b) => {
    const va = a[1]; const vb = b[1];
    const pa = (va.currentRankPoint ?? va.rankPoint ?? va.currentRankPoints ?? 0);
    const pb = (vb.currentRankPoint ?? vb.rankPoint ?? vb.currentRankPoints ?? 0);
    return pb - pa;
  });
  const best = entries[0][1];
  const kills = best.kills || 0;
  const assists = best.assists || 0;
  const deaths = best.deaths || 0;
  const damage = best.damageDealt || 0;
  const rounds = best.roundsPlayed || 0;
  const head = typeof best.headshotKills === 'number' ? best.headshotKills : 0;
  // headshot % 추정: ratio가 있으면 ratio*100, 없으면 headshotKills/kills
  const hsRate = kills > 0
    ? (typeof best.headshotKillRatio === 'number' ? best.headshotKillRatio * 100 : ((head / kills) * 100))
    : 0;
  // 일부 모드에서 longest/mostKills가 비어있는 경우, 전체 랭크 데이터에서 최대값을 사용
  let longest = best.longestKill || 0;
  if (!longest) {
    longest = entries.reduce((mx, [, v]) => Math.max(mx, v?.longestKill || 0), 0);
  }
  let mostKills = (best.roundMostKills ?? best.mostKillsInAGame ?? best.maxKills) || 0;
  if (!mostKills) {
    mostKills = entries.reduce((mx, [, v]) => {
      const candidate = (v?.roundMostKills ?? v?.mostKillsInAGame ?? v?.maxKills);
      const safe = (candidate == null ? 0 : candidate);
      return Math.max(mx, safe);
    }, 0);
  }
  const kda = deaths > 0 ? (kills + assists) / deaths : (kills + assists);
  const avgDamage = rounds > 0 ? (damage / rounds) : 0;
  // 승률/탑10/평균순위
  const wins = best.wins ?? 0;
  const winRate = (best.winRatio != null) ? +(best.winRatio * 100).toFixed(1)
    : (rounds ? +(((wins / rounds) * 100)).toFixed(1) : 0);
  const top10Rate = (best.top10Ratio != null) ? +(best.top10Ratio * 100).toFixed(1) : undefined;
  const avgRank = (best.avgRank != null) ? +(+best.avgRank).toFixed(2) : undefined;
  return {
    kda: +kda.toFixed(2),
    avgDamage: +avgDamage.toFixed(1),
    headshotRate: +hsRate.toFixed(2),
    longestKill: +(+longest).toFixed(2),
    mostKillsGame: mostKills,
    winRate,
    top10Rate,
    avgRank
  };
}
