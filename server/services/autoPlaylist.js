/**
 * API 키 없이 유튜브 검색 → videoId 수집 → 재생목록 URL 생성
 * 우선순위: (제목 관련) 마커스워십/피아워십 → 재생수 많은 영상
 * 속도: 곡별 검색 병렬 + 곡 동시 2개 처리
 */
const YouTube = require('youtube-sr').default;

const PREFERRED_ARTIST_RE =
  /마커스\s*워십|marcus\s*worship|markers\s*worship|\bmarkers\b|피아\s*워십|fia\s*worship|\bf\.?\s*i\.?\s*a\.?\b|마커스워십|피아워십/i;

const SEARCH_TIMEOUT_MS = 7000;

function buildQuery(song) {
  const parts = [String(song.title || '').trim()];
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

function pickBestVideo(candidates, songTitle) {
  const relevant = candidates.filter(
    (v) => v?.id && isTitleRelevant(v, songTitle),
  );
  if (relevant.length === 0) return null;

  const preferred = relevant.filter(isPreferredArtist);
  const finalPool = preferred.length > 0 ? preferred : relevant;
  finalPool.sort((a, b) => viewsOf(b) - viewsOf(a));
  return finalPool[0];
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

async function resolveOneSong(song) {
  const title = String(song.title || '').trim();
  if (!title) {
    return {
      id: String(song.id || 'empty'),
      title: song.title,
      query: '',
      videoId: null,
      error: '제목 없음',
    };
  }

  const base = buildQuery(song);

  // 3개 검색을 동시에 실행 (속도 개선)
  const [marcus, fia, general] = await Promise.all([
    searchOne(`${title} 마커스워십`, 8),
    searchOne(`${title} 피아워십`, 8),
    searchOne(base, 8),
  ]);

  let best = pickBestVideo([...marcus, ...fia, ...general], title);

  // 관련 영상 없으면 일반 검색에서 재생수 최다
  if (!best) {
    const loose = [...general, ...marcus, ...fia]
      .filter((v) => v?.id)
      .sort((a, b) => viewsOf(b) - viewsOf(a))[0];
    best = loose || null;
  }

  if (!best?.id) {
    return {
      id: String(song.id || title),
      title: song.title,
      query: base,
      videoId: null,
      error: '검색 결과 없음',
    };
  }

  return {
    id: String(song.id || best.id),
    title: song.title,
    query: base,
    videoId: best.id,
    videoTitle: best.title,
    channel: best.channel?.name,
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
  // 동시 2곡 → 전체 시간 약 1/2
  return mapPool(list, 2, (song) => resolveOneSong(song));
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
    `[autoPlaylist] ${videoIds.length}/${list.length}곡 · ${Date.now() - started}ms`,
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
};
