/**
 * API 키 없이 유튜브 검색 → videoId 수집 → 재생목록 URL 생성
 * 우선순위: 한국 대표 워십팀 → 없으면 조회수·인지도 높은 버전
 * (Gemini 미사용 — youtube-sr 검색 + 로컬 랭킹만)
 */
const YouTube = require('youtube-sr').default;
const { formatKeyForSearch } = require('./musicKey');

/** 한국 대표 워십팀 (검색·선호 판별) */
const WORSHIP_TEAMS = [
  { label: '마커스워십', query: '마커스워십' },
  { label: '피아워십', query: '피아워십' },
  { label: '위러브', query: '위러브' },
  { label: '어노인팅', query: '어노인팅' },
];

const PREFERRED_ARTIST_RE =
  /마커스\s*워십|marcus\s*worship|markers\s*worship|\bmarkers\b|피아\s*워십|fia\s*worship|\bf\.?\s*i\.?\s*a\.?\b|위\s*러브|welove|어\s*노인팅|anointing|아이자야|제이어스|예수전도단|마커스워십|피아워십/i;

const SEARCH_TIMEOUT_MS = 7000;

function buildQuery(song) {
  const title = String(song.title || '').trim();
  const parts = [title];
  // 조성 있으면 "곡명 G키" 형태로 검색
  const keyLabel = formatKeyForSearch(song.key);
  if (keyLabel) parts.push(keyLabel);
  if (song.number) parts.push(`${song.number}장`);
  if (
    /하나님|예수|성령|찬송|은혜|나그네|죄악|만지소서|만족/.test(song.title || '') ||
    song.number
  ) {
    parts.push('찬양');
  } else if (song.composer) {
    parts.push(String(song.composer));
  }
  return parts.filter(Boolean).join(' ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeKor(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\w가-힣]/g, '');
}

function viewsOf(video) {
  const n = Number(video?.views);
  return Number.isFinite(n) ? n : 0;
}

function isPreferredArtist(video) {
  const text = `${video?.title || ''} ${video?.channel?.name || ''}`;
  return PREFERRED_ARTIST_RE.test(text);
}

function isTitleRelevant(video, songTitle) {
  const vt = normalizeKor(video?.title);
  const st = normalizeKor(songTitle);
  if (!vt || !st) return false;
  if (vt.includes(st) || st.includes(vt)) return true;

  if (st.length >= 4) {
    let hits = 0;
    const total = st.length - 3;
    for (let i = 0; i < total; i++) {
      if (vt.includes(st.slice(i, i + 4))) hits += 1;
    }
    return hits / total >= 0.35;
  }

  return vt.includes(st);
}

/** 워십팀 우선 → 제목 관련 → 조회수 */
function pickBestVideo(candidates, songTitle) {
  const withId = (candidates || []).filter((v) => v?.id);
  if (withId.length === 0) return null;

  const relevant = withId.filter((v) => isTitleRelevant(v, songTitle));
  const pool = relevant.length > 0 ? relevant : withId;

  const preferred = pool.filter((v) => isPreferredArtist(v));
  const ranked = (preferred.length > 0 ? preferred : pool).slice();

  ranked.sort((a, b) => viewsOf(b) - viewsOf(a));
  return ranked[0];
}

async function searchOne(query, limit = 8) {
  if (!query?.trim()) return [];

  try {
    const results = await Promise.race([
      YouTube.search(query.trim(), { limit, type: 'video' }),
      sleep(SEARCH_TIMEOUT_MS).then(() => {
        const err = new Error('search-timeout');
        err.code = 'TIMEOUT';
        throw err;
      }),
    ]);
    return results || [];
  } catch {
    return [];
  }
}

function dedupeVideos(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const v of list || []) {
      const id = v?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(v);
    }
  }
  return out;
}

/** 곡별 워십팀·일반 검색으로 후보 수집 */
async function searchCandidatesForSong(song) {
  const title = String(song.title || '').trim();
  if (!title) {
    return { song, base: '', candidates: [] };
  }

  const base = buildQuery(song);
  const keyLabel = formatKeyForSearch(song.key);
  const titled = keyLabel ? `${title} ${keyLabel}` : title;

  // 대표 워십팀 + 일반(조회수) 검색을 병렬 실행
  const teamSearches = WORSHIP_TEAMS.map((t) =>
    searchOne(`${titled} ${t.query}`, 6),
  );
  const [teamResults, general] = await Promise.all([
    Promise.all(teamSearches),
    searchOne(base, 10),
  ]);

  const candidates = dedupeVideos([...teamResults, general]);
  return { song, base, candidates };
}

function toResolved(song, best, base) {
  const title = String(song.title || '').trim();
  if (!best?.id) {
    return {
      id: String(song.id || title || 'empty'),
      title: song.title,
      query: base || '',
      videoId: null,
      error: title ? '검색 결과 없음' : '제목 없음',
    };
  }

  return {
    id: String(song.id || best.id),
    title: song.title,
    query: base || '',
    videoId: best.id,
    videoTitle: best.title,
    channel: best.channel?.name,
    channelTitle: best.channel?.name,
    views: viewsOf(best),
    preferredArtist: isPreferredArtist(best),
    url: `https://www.youtube.com/watch?v=${best.id}`,
  };
}

/** 동시에 최대 concurrency곡 처리 */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}

async function resolveVideos(songs) {
  const list = songs.slice(0, 25);

  // 곡별 유튜브 검색 후 워십팀 → 조회수 로컬 랭킹 (Gemini 미사용)
  const pools = await mapPool(list, 2, (song) => searchCandidatesForSong(song));

  return pools.map(({ song, base, candidates }) => {
    const best = pickBestVideo(candidates, song.title);
    return toResolved(song, best, base);
  });
}

function buildWatchPlaylistUrl(videoIds, title) {
  const ids = videoIds.filter(Boolean);
  if (ids.length === 0) return null;

  const url = new URL('https://www.youtube.com/watch_videos');
  url.searchParams.set('video_ids', ids.join(','));
  if (title) url.searchParams.set('title', title);
  return url.toString();
}

async function buildAutoPlaylist({ title, songs }) {
  const list = Array.isArray(songs) ? songs : [];
  if (list.length === 0) {
    const err = new Error('곡 목록이 비어 있습니다.');
    err.code = 'EMPTY';
    throw err;
  }

  const started = Date.now();
  const resolved = await resolveVideos(list);
  const videoIds = resolved.map((r) => r.videoId).filter(Boolean);
  const playlistUrl = buildWatchPlaylistUrl(videoIds, title);

  if (!playlistUrl) {
    const err = new Error('유튜브에서 재생할 영상을 찾지 못했습니다.');
    err.code = 'NO_VIDEOS';
    throw err;
  }

  console.log(
    `[autoPlaylist] ${videoIds.length}/${list.length}곡 · 워십팀 ${resolved.filter((r) => r.preferredArtist).length} · ${Date.now() - started}ms`,
  );

  return {
    title: title || '악보플레이 플레이리스트',
    playlistUrl,
    playlistsUrl: 'https://www.youtube.com/feed/playlists',
    videoCount: videoIds.length,
    preferredCount: resolved.filter((r) => r.preferredArtist).length,
    elapsedMs: Date.now() - started,
    videos: resolved,
  };
}

module.exports = {
  buildAutoPlaylist,
  buildQuery,
  buildWatchPlaylistUrl,
  pickBestVideo,
  isPreferredArtist,
  isTitleRelevant,
  WORSHIP_TEAMS,
};
