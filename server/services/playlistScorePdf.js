/**
 * 유튜브 재생목록 → 곡별 악보 이미지 검색 → 한 페이지 2곡 PDF
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const YouTube = require('youtube-sr').default;
const { randomUUID } = require('crypto');

const MAX_SONGS = 24;
const SEARCH_TIMEOUT_MS = 20000;
const FETCH_TIMEOUT_MS = 12000;
/** 후보 평가·흰 배경 보정 전 긴 변 상한 (PDF 칸 ~850px, 여유 있게) */
const SCORE_MAX_SIDE = 2200;
/** 곡당 악보 탐색 상한 — 한 곡이 전체를 붙잡지 않게 */
const SONG_SEARCH_TIMEOUT_MS = 70000;
/** 후보 다운로드·품질검사 최대 개수 (실패 포함 상위 N개 시도) */
const MAX_CANDIDATES_TO_TRY = 18;
/** A4 가로(landscape) ~150dpi — 한 페이지에 좌·우 2곡 */
const PAGE_W = 1754;
const PAGE_H = 1240;
const MARGIN = 28;
const GAP = 18;
/** PDF 포인트 (A4 landscape) */
const PDF_PAGE_W = 842;
const PDF_PAGE_H = 595;

const FONT_DIR = path.join(__dirname, '../assets/fonts');
const FONT_REG = path.join(FONT_DIR, 'NotoSansKR-Regular.otf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSansKR-Bold.otf');

/** fontconfig(~/.fonts)에도 복사 — Render Linux SVG 텍스트용 */
function ensureFontsRegistered() {
  try {
    const homeFonts = path.join(os.homedir(), '.fonts');
    fs.mkdirSync(homeFonts, { recursive: true });
    for (const src of [FONT_REG, FONT_BOLD]) {
      if (!fs.existsSync(src)) continue;
      const dest = path.join(homeFonts, path.basename(src));
      if (
        !fs.existsSync(dest) ||
        fs.statSync(dest).size !== fs.statSync(src).size
      ) {
        fs.copyFileSync(src, dest);
      }
    }
  } catch (err) {
    console.warn('[playlist-score-pdf] 폰트 등록 실패:', err.message);
  }
}
ensureFontsRegistered();

/** SVG @font-face (file://) — 용량 큰 base64 대신 디스크 참조 */
let cachedFontCss = null;
function koreanFontCss() {
  if (cachedFontCss != null) return cachedFontCss;
  const faces = [];
  try {
    if (fs.existsSync(FONT_REG)) {
      faces.push(
        `@font-face{font-family:'NotoSansKR';src:url('${pathToFileURL(FONT_REG).href}');font-weight:400;font-style:normal;}`,
      );
    }
    if (fs.existsSync(FONT_BOLD)) {
      faces.push(
        `@font-face{font-family:'NotoSansKR';src:url('${pathToFileURL(FONT_BOLD).href}');font-weight:700;font-style:normal;}`,
      );
    }
  } catch (err) {
    console.warn('[playlist-score-pdf] 폰트 CSS 실패:', err.message);
  }
  cachedFontCss = faces.join('\n');
  if (!cachedFontCss) {
    console.warn(
      '[playlist-score-pdf] 한글 폰트 없음 — placeholder 글자가 깨질 수 있습니다',
    );
  } else {
    console.log('[playlist-score-pdf] 한글 폰트 준비 완료');
  }
  return cachedFontCss;
}

/** 한글 안전 SVG 래퍼 */
function wrapSvg(width, height, body) {
  const css = koreanFontCss();
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style type="text/css"><![CDATA[
${css}
text { font-family: 'NotoSansKR', 'Noto Sans KR', 'Malgun Gothic', sans-serif; }
]]></style>
  </defs>
${body}
</svg>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 재생목록 ID 추출 */
function extractPlaylistId(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (/^PL[\w-]{10,}$/i.test(text) || /^UU[\w-]{10,}$/i.test(text)) {
    return text;
  }

  try {
    const url = new URL(text);
    const list = url.searchParams.get('list');
    if (list) return list;
  } catch {
    /* plain text */
  }

  const m = text.match(/[?&]list=([\w-]+)/i);
  return m ? m[1] : null;
}

/** ytInitialData 트리에서 재생목록 영상 수집 (신형 lockupViewModel 포함) */
function collectPlaylistVideosFromData(data) {
  const videos = [];
  let playlistTitle = null;

  function walk(o, depth = 0) {
    if (!o || depth > 45) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    if (typeof o !== 'object') return;

    // 신형 UI
    const lv = o.lockupViewModel;
    if (lv?.contentId && String(lv.contentType || '').includes('VIDEO')) {
      const title =
        lv.metadata?.lockupMetadataViewModel?.title?.content ||
        lv.metadata?.title?.content ||
        null;
      const channel =
        lv.metadata?.lockupMetadataViewModel?.metadata
          ?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]
          ?.text?.content || null;
      videos.push({
        id: lv.contentId,
        title: title || lv.contentId,
        channel: { name: channel || '' },
      });
    }

    // 구형 UI
    const pv = o.playlistVideoRenderer;
    if (pv?.videoId) {
      videos.push({
        id: pv.videoId,
        title:
          pv.title?.runs?.map((r) => r.text).join('') ||
          pv.title?.simpleText ||
          pv.videoId,
        channel: {
          name: pv.shortBylineText?.runs?.map((r) => r.text).join('') || '',
        },
      });
    }

    if (!playlistTitle) {
      if (o.playlistMetadataRenderer?.title) {
        playlistTitle = o.playlistMetadataRenderer.title;
      } else if (o.playlistSidebarPrimaryInfoRenderer?.title?.runs) {
        playlistTitle = o.playlistSidebarPrimaryInfoRenderer.title.runs
          .map((r) => r.text)
          .join('');
      } else if (o.playlistSidebarPrimaryInfoRenderer?.title?.simpleText) {
        playlistTitle = o.playlistSidebarPrimaryInfoRenderer.title.simpleText;
      }
    }

    for (const v of Object.values(o)) walk(v, depth + 1);
  }

  walk(data);

  const seen = new Set();
  const unique = [];
  for (const v of videos) {
    if (!v?.id || seen.has(v.id)) continue;
    seen.add(v.id);
    unique.push(v);
  }
  return { title: playlistTitle, videos: unique };
}

/**
 * YouTube HTML(ytInitialData)에서 재생목록 파싱
 * youtube-sr가 신형 UI를 못 읽는 경우 대비
 */
async function fetchPlaylistViaHtml(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(
    playlistId,
  )}&hl=ko`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`재생목록 페이지 HTTP ${res.status}`);
    }
    const html = await res.text();
    const match =
      html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ||
      html.match(/var ytInitialData = (\{.+?\});\s*<\/script>/s);
    if (!match) {
      throw new Error('재생목록 데이터(ytInitialData)를 찾지 못했습니다.');
    }
    const data = JSON.parse(match[1]);
    return collectPlaylistVideosFromData(data);
  } finally {
    clearTimeout(timer);
  }
}

/** youtube-sr → HTML 폴백 순으로 재생목록 로드 */
async function loadPlaylist(playlistId) {
  // 1) youtube-sr 시도
  try {
    const playlist = await YouTube.getPlaylist(playlistId, {
      fetchAll: true,
      limit: MAX_SONGS,
    });
    const videos = (playlist?.videos || []).filter((v) => v?.id);
    if (videos.length > 0) {
      return {
        title: playlist?.title || playlist?.name || null,
        videos,
        source: 'youtube-sr',
      };
    }
  } catch (e) {
    console.warn(
      '[playlist-score-pdf] youtube-sr 실패:',
      String(e.message || e).slice(0, 120),
    );
  }

  // 2) HTML 직접 파싱 (신형 lockupViewModel)
  const htmlPl = await fetchPlaylistViaHtml(playlistId);
  return {
    title: htmlPl.title,
    videos: htmlPl.videos.slice(0, MAX_SONGS),
    source: 'html',
  };
}

/** 팀/아티스트명만 있는지 */
function isLikelyArtistName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (
    /^(WELOVE|위러브|마커스|피아|FIA|어노인팅|예람|YERAM|제이어스|아이자야|마커스워십|피아워십|예람워십)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/워십|worship|creative\s*team/i.test(t) && t.length <= 24) return true;
  if (/^[A-Z][A-Z0-9.\s]{1,20}$/.test(t) && t.length <= 16) return true;
  return false;
}

/**
 * 유튜브 제목 → 곡명·아티스트
 * 예: "WELOVE - [입례 入禮] (예배하는 자 되어)" → 입례 / WELOVE
 */
function extractSongMeta(raw) {
  const original = String(raw || '').trim();
  if (!original) {
    return { title: '', artist: '', altTitle: '', searchQuery: '' };
  }

  const bracketTitles = [];
  for (const m of original.matchAll(/\[([^\[\]]+)\]/g)) {
    const inner = String(m[1] || '')
      .replace(/入禮/g, '')
      .replace(/\b(MR|Inst|Instrumental|Live|Official)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[가-힣]{2,}/.test(inner)) bracketTitles.push(inner);
  }
  for (const m of original.matchAll(/\(([^()]+)\)/g)) {
    const inner = String(m[1] || '').trim();
    if (
      /[가-힣]{2,}/.test(inner) &&
      !/(ver\.?|버전|전조|key|코드|\d{4}\.\d{1,2})/i.test(inner)
    ) {
      bracketTitles.push(inner);
    }
  }

  let t = original
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/（[^）]*）/g, ' ');

  let artist = '';
  const dash = t
    .split(/\s*[-–—|｜]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (dash.length >= 2) {
    const left = dash[0];
    const right = dash.slice(1).join(' ').trim();
    if (isLikelyArtistName(left) && right.length >= 2) {
      artist = left;
      t = right;
    } else if (isLikelyArtistName(right) && left.length >= 2) {
      artist = right;
      t = left;
    } else if (isLikelyArtistName(left) && (!right || right.length < 2)) {
      artist = left;
      t = '';
    } else if (right.length > left.length + 4) {
      // 긴쪽이 곡명 (예: 홀리원 - 우리는 주의 움직이는 교회)
      artist = left;
      t = right;
    } else if (left.length > right.length + 4) {
      artist = right;
      t = left;
    } else {
      t = left.length >= 2 ? left : right;
    }
  } else if (dash.length === 1) {
    t = dash[0];
  }

  t = t
    .replace(
      /\b(official|mv|m\/v|live|lyrics|audio|piano|cover|full|hd|4k|remastered)\b/gi,
      ' ',
    )
    .replace(
      /(공식|라이브|커버|피아노|기타|연주|뮤직비디오|자막|가사영상|악보영상)/gi,
      ' ',
    )
    // "곡명_인도자" 형태에서 인도자 제거
    .replace(/[_/]\s*[가-힣A-Za-z]+(?:\s*(?:전도사|목사|사모|간사|선생님))?$/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 한/영 병기 제목이면 한글 쪽을 검색 우선
  if (t.includes('/')) {
    const parts = t
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
    const ko = parts.find((p) => /[가-힣]{2,}/.test(p));
    const en = parts.find((p) => /[A-Za-z]{3,}/.test(p) && !/[가-힣]/.test(p));
    if (ko) {
      t = ko;
      if (en) bracketTitles.push(en);
    }
  }

  if ((!t || isLikelyArtistName(t)) && bracketTitles.length > 0) {
    if (!artist && isLikelyArtistName(t)) artist = t;
    const sorted = [...bracketTitles].sort((a, b) => a.length - b.length);
    t = sorted[0];
  }

  if (!artist) {
    if (/WELOVE|위러브/i.test(original)) artist = 'WELOVE';
    else if (/예람|YERAM/i.test(original)) artist = '예람워십';
    else if (/피아|F\.?I\.?A/i.test(original)) artist = '피아워십';
    else if (/마커스/i.test(original)) artist = '마커스워십';
  }

  t = t.slice(0, 80);
  const altTitle =
    bracketTitles.find((b) => b !== t && /[가-힣]{2,}/.test(b)) || '';
  // 검색은 곡명만 사용 (워십팀/아티스트 제외)
  const searchQuery = [t, '악보'].filter(Boolean).join(' ');

  return { title: t, artist, altTitle, searchQuery };
}

/** 긴 한글 곡명에서 검색용 핵심 구절 뽑기 */
function hangulSearchCores(title) {
  const hangul = String(title || '')
    .replace(/[^가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!hangul) return [];
  const cores = new Set([hangul]);
  const words = hangul.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2) {
    cores.add(words.slice(-2).join(' '));
    cores.add(words.slice(-3).join(' '));
  }
  // 조사 비슷한 짧은 토큰 제거한 압축형
  const compact = words
    .filter((w) => !/^(우리는|나는|너의|나의|그|이|저|또|및)$/.test(w))
    .join(' ');
  if (compact && compact !== hangul) cores.add(compact);
  return [...cores].filter((c) => c.replace(/\s/g, '').length >= 4);
}

function cleanSongTitle(raw) {
  return extractSongMeta(raw).title;
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchBuffer(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    };
    // fetch Header는 ByteString — 한글 페이지 제목/비ASCII Referer면 즉시 throw
    let safeReferer = null;
    if (referer && /^https?:\/\//i.test(String(referer))) {
      try {
        const u = new URL(String(referer));
        safeReferer = `${u.protocol}//${u.host}/`;
      } catch {
        safeReferer = null;
      }
    }
    if (safeReferer) {
      headers.Referer = safeReferer;
    } else if (
      /pstatic\.net|naver\.com|blogfiles\.naver|daumcdn|kakaocdn|tistory|akbotong/i.test(
        url,
      )
    ) {
      headers.Referer = 'https://blog.naver.com/';
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !/image|octet-stream|binary/i.test(ct) && !/pdf/i.test(ct)) {
      throw new Error(`not image: ${ct}`);
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length < 4000) throw new Error('too small');
    return buf;
  } catch (err) {
    // https 실패 시 네이버 블로그 원본은 http로 재시도
    const msg = String(err?.message || err);
    if (
      /^https:\/\//i.test(url) &&
      /blogfiles\.naver\.net|postfiles\d*\.pstatic\.net/i.test(url) &&
      /fetch failed|ECONN|certificate|SSL|TLS|aborted/i.test(msg)
    ) {
      const httpUrl = `http://${url.slice(8)}`;
      clearTimeout(timer);
      return fetchBuffer(httpUrl, referer);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 네이버 등 썸네일 URL을 원본에 가깝게 */
function upgradeImageUrl(url) {
  let u = String(url || '');
  if (!u) return u;

  // daum/kakao 썸네일 → fname 원본
  const fname = u.match(/[?&]fname=([^&]+)/i);
  if (fname && /daumcdn|kakaocdn|pstatic/i.test(u)) {
    try {
      const decoded = decodeURIComponent(fname[1]);
      if (/^https?:\/\//i.test(decoded)) u = decoded;
    } catch {
      /* keep */
    }
  }

  u = u.replace(/type=w\d+/i, 'type=w966');
  u = u.replace(/type=ff640_640/i, 'type=w966');
  u = u.replace(/type=a340/i, 'type=w966');
  u = u.replace(/\/thumb\/C\d+x\d+[^/]*/i, '/thumb/R0x0');
  return u;
}

function scoreImageCandidate(img, songTitle, artist = '', opts = {}) {
  const title = String(img?.title || '');
  const page = String(img?.source || img?.page || '');
  const url = String(img?.url || '');
  const blob = `${title} ${page} ${url}`.toLowerCase().replace(/\s+/g, '');
  const st = String(songTitle || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  const isHymn = Boolean(opts.isHymn);
  const hymnNo = String(opts.hymnNo || '');
  let score = 0;

  // 미리보기·유료 워터마크 후보 강하게 배제
  if (
    /preview-v2|\/preview|legal\s*use\s*requires|watermark|미리보기|구매\s*후/i.test(
      `${title} ${page} ${url}`,
    )
  ) {
    score -= 80;
  }
  // PPT/슬라이드·편곡 일부는 한 곡 전체가 아닌 경우가 많음
  if (/\bPPT\b|피피티|슬라이드|powerpoint/i.test(`${title} ${page}`)) {
    score -= 70;
  }
  if (/상상건반|편곡악보|연주용\s*악보|반주만/i.test(title) && !/단선|멜로디|코드\s*악보|가사\s*악보|전체/i.test(title)) {
    score -= 35;
  }
  if (/cdn\.mapianist\.com|mapianist\.com\/sheet/i.test(url + page)) {
    // 미리보기 CDN만 강하게 감점, 제목 매칭된 본문 글은 약하게
    if (/preview/i.test(url + page)) score -= 55;
    else score -= 18;
  }
  // 드럼/타악만 보이는 악보 배제 (멜로디 악보 선호)
  if (
    /drum|드럼|타악|percussion|open\s*h\.?h|인터루드.*드럼/i.test(title) &&
    !/단선|멜로디|코드\s*악보|가사/.test(title)
  ) {
    score -= 40;
  }

  if (/악보|코드악보|가사악보|피아노악보|sheet|chord|단선/.test(title)) score += 45;
  if (/ppt/i.test(title) && /악보/.test(title)) score += 8;

  // 찬송가: 새찬송가/통일찬송가 버전만 강하게 선호
  if (isHymn) {
    const ccmArranged =
      /예람|피아|welove|위러브|마커스|토브|워십|ccm|코드\s*악보|편곡|상상건반/i.test(
        title,
      );
    const hymnBook =
      /새찬송가|통일찬송가/i.test(`${title} ${page}`) ||
      (/찬송가\s*\d{2,3}\s*장/i.test(`${title} ${page}`) && !ccmArranged);
    if (hymnBook) score += 70;
    if (hymnNo && new RegExp(`${hymnNo}\\s*장`).test(`${title} ${page}`)) {
      score += 50;
    }
    // CCM·워십 편곡/코드 악보는 찬송가 버전으로 보지 않음
    if (ccmArranged && !/새찬송가|통일찬송가/i.test(title)) {
      score -= 80;
    }
  } else if (/찬송가\s*\d{2,3}\s*장|새찬송가\s*\d{2,3}/i.test(title)) {
    score += 20;
  }

  // 곡명 일치 — 한글/영문 분리 매칭 (한영 병기 제목 대응)
  const hangul = String(songTitle || '')
    .replace(/[^가-힣\s]/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
  const latin = String(songTitle || '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
  const artistKey = String(artist || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  let titleHit = false;
  if (st.length >= 2 && blob.includes(st)) {
    score += 40;
    titleHit = true;
  } else {
    const hangulHit = hangul.length >= 2 && blob.includes(hangul);
    const latinHit = latin.length >= 4 && blob.includes(latin);
    if (hangulHit && latinHit) {
      // 한영 모두 일치 — CCM 한영 병기 곡
      score += 48;
      titleHit = true;
    } else if (latinHit) {
      score += 30;
      titleHit = true;
    } else if (hangulHit && latin.length >= 4) {
      // 한글만 맞고 영문 곡명(GrowingCloser 등)이 없으면 동명곡 오탐 → 강한 감점
      score -= 45;
    } else if (hangulHit) {
      score += 38;
      titleHit = true;
    }
    if (!titleHit && hangul.length >= 2) {
      let hits = 0;
      for (let i = 0; i <= hangul.length - 2; i++) {
        if (blob.includes(hangul.slice(i, i + 2))) hits += 1;
      }
      const ratio = hits / Math.max(1, hangul.length - 1);
      if (ratio >= 0.55) {
        score += latin.length >= 4 ? 8 : 22;
        titleHit = latin.length < 4;
      }
      // 긴 곡명: 앞/뒤 핵심 구간만 있어도 인정 (우리는주의움직이는교회)
      if (!titleHit && hangul.length >= 8) {
        const head = hangul.slice(0, 6);
        const mid = hangul.slice(Math.floor(hangul.length / 2) - 3, Math.floor(hangul.length / 2) + 3);
        const tail = hangul.slice(-6);
        if (blob.includes(head) || blob.includes(mid) || blob.includes(tail)) {
          score += 28;
          titleHit = true;
        }
      }
    }
    if (!titleHit) score -= 35;
  }
  // 알려진 워십팀명이 후보에 있으면 가산 (동명곡·다른 편곡 구분)
  const artistBlobHit = (() => {
    if (artistKey.length >= 2 && blob.includes(artistKey)) return true;
    // 팀명 별칭 (FIA ↔ 피아워십 등)
    if (/피아|fia/i.test(artistKey) && /fia|피아|f\.?\s*i\.?\s*a/i.test(blob)) {
      return true;
    }
    if (/예람|yeram/i.test(artistKey) && /예람|yeram/i.test(blob)) return true;
    if (/welove|위러브/i.test(artistKey) && /welove|위러브/i.test(blob)) {
      return true;
    }
    if (/마커스|marcus/i.test(artistKey) && /마커스|marcus/i.test(blob)) {
      return true;
    }
    return false;
  })();
  if (artistBlobHit) {
    score += 40;
  } else if (
    artistKey.length >= 2 &&
    /예람|welove|위러브|피아|fia|마커스|yeram/i.test(artistKey) &&
    /김연우|아이유|성시경|버스커|악동/i.test(`${title} ${page}`)
  ) {
    // 유명 대중곡 아티스트면 감점
    score -= 50;
  }

  // MR·반주 음원 페이지는 악보가 아님
  if (/\bMR\b|반주\s*음원|inst(?:rumental)?\b/i.test(title) && !/악보|sheet|chord/i.test(title)) {
    score -= 60;
  }

  // 검색 소스 우선순위: 네이버 > 구글 > 빙
  if (img.provider === 'naver') score += 12;
  else if (img.provider === 'google') score += 8;
  else if (img.provider === 'bing') score += 3;

  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w > 0 && h > 0) {
    // 한 곡 전체가 한 장에 들어가는 세로형 악보 선호
    if (h / w >= 1.2) score += 28;
    else if (h / w >= 1.0) score += 14;
    else if (w / h >= 1.5) score -= 28;
    if (h >= 900) score += 12;
    else if (h >= 700) score += 6;
    if (w * h >= 700_000) score += 10;
  }

  // 한 곡 전체 악보 신호
  if (
    /전체\s*악보|가사\s*(악보|포함)|단선\s*(멜로디)?\s*악보|코드\s*악보|멜로디\s*악보|피아노\s*악보|한\s*장|full\s*score|lead\s*sheet/i.test(
      `${title} ${page}`,
    )
  ) {
    score += isHymn ? 10 : 28;
  }
  // 일부·미리보기·잘린 이미지는 감점
  if (
    /1절만|2절만|후렴만|일부|발췌|미리보기|인트로만|하이라이트|썸네일|부분\s*악보|clip|excerpt|preview/i.test(
      `${title} ${page} ${url}`,
    )
  ) {
    score -= 40;
  }
  // Intro만 있는 피아노 편곡(가사·단선 없음)은 CCM 예배용으로 약함
  if (
    /<Intro>|\[Intro\]|\bIntro\b|인트로/i.test(`${title} ${page}`) &&
    !/가사|단선|멜로디|코드\s*악보|Verse|후렴|1절/i.test(`${title} ${page}`)
  ) {
    score -= 35;
  }
  // 기타/인도용은 단선·코드·가사 악보를 피아노 Intro보다 선호
  if (/단선|멜로디\s*악보|코드\s*악보|가사\s*악보|lead\s*sheet/i.test(`${title} ${page}`)) {
    score += 22;
  }
  if (/피아노\s*악보|piano\s*(score|sheet)/i.test(`${title} ${page}`) &&
      !/단선|멜로디|코드\s*악보|가사/i.test(`${title} ${page}`)) {
    score -= 12;
  }
  // 흰 배경·인쇄용 표현 가산 / 어두운·빈티지 감점
  if (/흰\s*배경|화이트|인쇄용|고화질|clean|white\s*bg/i.test(`${title} ${page}`)) {
    score += 12;
  }
  if (/어두운|블랙|black\s*bg|night|세피아|빈티지|크로마/i.test(`${title} ${page}`)) {
    score -= 20;
  }

  if (
    /blog\.naver|postfiles\.pstatic|mblogthumb|blogthumb\.pstatic|tistory|kakaocdn|daumcdn|mymusicsheet|worshipmusic|akbobada|cinfonet|akbotong/i.test(
      `${url} ${page}`,
    )
  ) {
    score += 18;
  }
  // 유튜브 썸네일은 한 곡 전체 악보가 아님
  if (/youtube\.com|ytimg\.com|i\.ytimg\.com|pinterest|facebook\.com|lookaside\.fbsbx/i.test(url)) {
    score -= 55;
  }
  if (/emoji|meme|cartoon|스티커|프로필/i.test(title)) score -= 30;

  return score;
}

/**
 * 하단 블러 미리보기 → 상단만 잘라 재검사 (유료 사이트 미리보기 대응)
 * @returns {{ buffer: Buffer, clarity: object } | null}
 */
async function trySalvageBottomBlur(buf) {
  const sharp = require('sharp');
  try {
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w < 280 || h < 400) return null;
    // 하단 28~35%를 잘라 오선이 보이는 상단만 사용
    const keepH = Math.floor(h * 0.68);
    if (keepH < 320) return null;
    const cropped = await sharp(buf)
      .extract({ left: 0, top: 0, width: w, height: keepH })
      .png()
      .toBuffer();
    const clarity = await assessImageClarity(cropped);
    if (!clarity.ok) return null;
    return { buffer: cropped, clarity };
  } catch {
    return null;
  }
}

/**
 * 다운로드한 악보 이미지가 실제로 읽히는지 검사
 * - 하단만 흐린 미리보기
 * - PREVIEW 워터마크(어두운 대각선 밴드)
 * - 전체적으로 너무 흐린 이미지
 */
async function assessImageClarity(buf) {
  const sharp = require('sharp');
  const meta = await sharp(buf).metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  if (w0 < 220 || h0 < 280) {
    return { ok: false, reason: 'too-small', score: 0 };
  }

  const { data, info } = await sharp(buf)
    .greyscale()
    .resize(360, 480, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const n = w * h;

  // 인접 픽셀 차분(에지 강도) — 선명할수록 큼
  const edgeAt = (y0, y1) => {
    let sum = 0;
    let cnt = 0;
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const dx = Math.abs(data[i] - data[i - 1]);
        const dy = Math.abs(data[i] - data[i - w]);
        sum += dx + dy;
        cnt += 1;
      }
    }
    return cnt ? sum / cnt : 0;
  };

  const mid = Math.floor(h / 2);
  const topEdge = edgeAt(0, mid);
  const botEdge = edgeAt(mid, h);
  const allEdge = edgeAt(0, h);

  // 하단이 상단보다 훨씬 흐리면(미리보기 블러) 탈락 — 비율을 더 엄격히
  if (topEdge > 7 && botEdge / topEdge < 0.55) {
    return {
      ok: false,
      reason: 'bottom-blur',
      score: botEdge / topEdge,
      topEdge,
      botEdge,
    };
  }
  // 하단 1/3만 따로 봐도 너무 흐리면 탈락
  const botThird = edgeAt(Math.floor((h * 2) / 3), h);
  if (topEdge > 8 && botThird / topEdge < 0.48) {
    return {
      ok: false,
      reason: 'bottom-third-blur',
      score: botThird / topEdge,
      topEdge,
      botEdge: botThird,
    };
  }

  // 전체적으로 너무 흐림
  if (allEdge < 7.2) {
    return { ok: false, reason: 'too-blurry', score: allEdge };
  }

  // 어두운 픽셀 비율 — PREVIEW 워터마크는 검정 글자가 많음
  let dark = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] < 55) dark += 1;
  }
  const darkRatio = dark / n;
  if (darkRatio > 0.22 && allEdge > 18) {
    // 진한 워터마크 + 강한 에지(글자 오버레이)
    return {
      ok: false,
      reason: 'heavy-dark-overlay',
      score: darkRatio,
      allEdge,
    };
  }

  // 가로 줄무늬(오선) 존재 여부 — 악보답지 않으면 감점만
  let staffish = 0;
  for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.85); y += 3) {
    let rowDark = 0;
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] < 140) rowDark += 1;
    }
    if (rowDark / w > 0.35 && rowDark / w < 0.85) staffish += 1;
  }

  // 배경(밝은 픽셀) 밝기 — 흰색 용지 악보 선호
  const samples = [];
  const step = Math.max(1, Math.floor(n / 6000));
  for (let i = 0; i < n; i += step) samples.push(data[i]);
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] || 0;
  const p85 = samples[Math.floor(samples.length * 0.85)] || 0;
  const bright = samples.filter((v) => v >= p50);
  const paper =
    bright.reduce((a, b) => a + b, 0) / Math.max(1, bright.length);

  // 전체적으로 어두운 배경(회색·밤·스캔 그림자)은 탈락
  if (paper < 168) {
    return {
      ok: false,
      reason: 'dark-background',
      score: paper,
      paper,
      p85,
      staffish,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    score: allEdge,
    topEdge,
    botEdge,
    darkRatio,
    staffish,
    paper,
    p85,
  };
}

/**
 * 다운로드 직후 축소·정규화 — 이후 sharp/whitening 메모리 폭주 방지
 */
async function normalizeScoreBuffer(buf) {
  const sharp = require('sharp');
  return sharp(buf)
    .rotate()
    .resize(SCORE_MAX_SIDE, SCORE_MAX_SIDE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha()
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/**
 * 크림/회색 용지 배경을 흰색에 가깝게 맞춤 (오선·음표는 유지)
 * — 축소본에서 통계만 뽑고 sharp.linear로 보정 (JS 전픽셀 루프 금지)
 */
async function whitenScoreBackground(buf) {
  const sharp = require('sharp');
  const base = sharp(buf)
    .rotate()
    .resize(SCORE_MAX_SIDE, SCORE_MAX_SIDE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha();

  // 작은 샘플로 용지/잉크 기준점만 계산
  const { data, info } = await base
    .clone()
    .greyscale()
    .resize(320, 320, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  const samples = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) samples.push(data[i]);
  samples.sort((a, b) => a - b);
  const blackPoint = Math.min(
    70,
    Math.max(18, samples[Math.floor(samples.length * 0.08)] || 30),
  );
  const paperPoint = Math.max(
    blackPoint + 40,
    samples[Math.floor(samples.length * 0.88)] || 220,
  );

  // 이미 충분히 흰면 JPEG로만 정규화
  if (paperPoint >= 248) {
    return base.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  }

  // linear: out = in * a + b  → (v - black) / span * 255
  const span = Math.max(1, paperPoint - blackPoint);
  const a = 255 / span;
  const b = (-blackPoint * 255) / span;
  return base.linear(a, b).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/** 메타/URL만으로 바로 스킵할지 */
function shouldSkipCandidate(c, opts = {}) {
  const t = `${c.title || ''} ${c.source || ''} ${c.url || ''}`;
  if (/preview-v2|legal\s*use\s*requires\s*purchase/i.test(t)) return true;
  if (/cdn\.mapianist\.com\/preview/i.test(c.url || '')) return true;
  // 유튜브 썸네일·영상 캡처는 악보 전체가 아님
  if (/ytimg\.com|i\.ytimg\.com|img\.youtube\.com/i.test(c.url || '')) return true;
  // PPT/슬라이드 악보는 한 장에 곡 일부가 잘리는 경우가 많음
  if (/\bPPT\b|피피티|슬라이드|powerpoint/i.test(c.title || '')) return true;
  // MR·반주 음원은 악보 이미지가 아님
  if (/\bMR\b|반주\s*음원/i.test(c.title || '')) return true;
  if (
    /상상건반/i.test(c.title || '') &&
    /편곡|PPT|피피티/i.test(c.title || '')
  ) {
    return true;
  }
  if (
    /\b(drum|드럼보|타악보|percussion)\b/i.test(c.title || '') &&
    !/단선|멜로디|코드|가사|피아노/i.test(c.title || '')
  ) {
    return true;
  }
  // 찬송가 곡: CCM·워십 편곡은 제외 (새찬송가/통일찬송가만)
  // 주의: "C코드/G키"만 있는 찬송가 원본 다운로드 글은 스킵하지 않음
  if (opts.isHymn) {
    const official = /새찬송가|통일찬송가/i.test(c.title || '');
    const ccm =
      /예람|피아|welove|위러브|마커스|토브|워십|코드\s*악보|편곡|상상건반/i.test(
        c.title || '',
      );
    if (ccm && !official) return true;
  }
  return false;
}

/** 잘 알려진 찬송가 번호 힌트 (전체 악보 검색용) */
function hymnNumberHint(title) {
  const t = String(title || '');
  if (/새벽부터\s*우리/.test(t)) return '496';
  if (/갈길을\s*밝히|갈\s*길을\s*밝히/.test(t)) return '524';
  if (/구주\s*예수\s*의지/.test(t)) return '542';
  if (/이\s*몸의\s*소망/.test(t)) return '540';
  return '';
}

/** 영상 제목 등에서 찬송가 여부·장 번호 추출 */
function resolveHymnInfo(meta) {
  const title = String(meta?.title || '');
  const videoTitle = String(meta?.videoTitle || '');
  const blob = `${title} ${videoTitle}`;
  let hymnNo = hymnNumberHint(title);
  if (!hymnNo) {
    const m =
      blob.match(/(?:새)?찬송가\s*(\d{2,3})\s*장/) ||
      blob.match(/(\d{2,3})\s*장/);
    if (m) hymnNo = m[1];
  }
  const isHymn =
    Boolean(hymnNo) ||
    /찬송가|새찬송가|통일찬송가|찬송가랑/i.test(blob);
  return { hymnNo, isHymn };
}

/** 곡 메타로 악보 이미지 버퍼 확보 */
async function findScoreImageBuffer(metaOrTitle) {
  const meta =
    typeof metaOrTitle === 'string'
      ? extractSongMeta(metaOrTitle)
      : metaOrTitle || {};
  const songTitle = meta.title || '';
  const artist = meta.artist || '';
  const { hymnNo, isHymn } = resolveHymnInfo(meta);

  // 찬송가: 새찬송가/찬송가 장 번호 버전만 우선 검색
  // 일반곡: 곡명(+악보)만 검색 — 워십팀명은 넣지 않음
  const hangulTitle = String(songTitle || '')
    .replace(/[^가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const latinOnly = String(songTitle || '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cores = hangulSearchCores(songTitle);
  // 네이버/구글에서 잘 되는 붙여쓰기형 (예: 우리는주의움직이는교회 악보)
  const gluedTitle = hangulTitle.replace(/\s+/g, '');
  const altTitle = String(meta.altTitle || '')
    .replace(/[^가-힣A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 입례처럼 2~3글자 곡명은 동명이 많아 부제·아티스트를 앞에 둠
  const shortHangul = hangulTitle.replace(/\s+/g, '').length > 0
    && hangulTitle.replace(/\s+/g, '').length <= 3;
  const queries = isHymn
    ? [
        hymnNo ? `새찬송가 ${hymnNo}장 ${hangulTitle || songTitle} 악보` : '',
        hymnNo ? `찬송가 ${hymnNo}장 ${hangulTitle || songTitle} 악보` : '',
        hymnNo ? `새찬송가 ${hymnNo}장 악보` : '',
        hymnNo ? `통일찬송가 ${hymnNo}장 ${hangulTitle || songTitle}` : '',
        `${hangulTitle || songTitle} 새찬송가 악보`,
        `${hangulTitle || songTitle} 찬송가 악보`,
        hymnNo ? `찬송가 ${hymnNo}장 가사 악보` : '',
      ].filter(Boolean)
    : [
        // 짧은 곡명: 부제·아티스트 먼저 (입례 → 예배하는 자 되어)
        shortHangul && altTitle ? `${altTitle} 악보` : '',
        shortHangul && altTitle && hangulTitle
          ? `${hangulTitle} ${altTitle} 악보`
          : '',
        shortHangul && artist && hangulTitle
          ? `${artist} ${hangulTitle} 악보`
          : '',
        shortHangul && artist && altTitle ? `${artist} ${altTitle} 악보` : '',
        // 곡명만 먼저 — 팀명 때문에 검색이 비는 경우 방지
        songTitle ? `${songTitle} 악보` : '',
        hangulTitle ? `${hangulTitle} 악보` : '',
        // 붙여쓰기형 (스크린샷과 동일 패턴)
        gluedTitle && gluedTitle.length >= 4 ? `${gluedTitle} 악보` : '',
        gluedTitle && gluedTitle.length >= 4 ? `${gluedTitle}코드악보` : '',
        hangulTitle ? `${hangulTitle} 코드 악보` : '',
        hangulTitle ? `${hangulTitle} 단선 악보` : '',
        hangulTitle ? `${hangulTitle} 가사 악보` : '',
        hangulTitle ? `${hangulTitle} 멜로디 악보` : '',
        gluedTitle && gluedTitle.length >= 4 ? `${gluedTitle} 단선 악보` : '',
        hangulTitle ? `${hangulTitle} 피아노 악보` : '',
        ...cores.map((c) => `${c} 악보`),
        ...cores.map((c) => `${c.replace(/\s+/g, '')} 악보`),
        ...cores.map((c) => `${c} 코드 악보`),
        ...cores.map((c) => `${c} 단선 악보`),
        artist && songTitle ? `${songTitle} ${artist} 악보` : '',
        artist && hangulTitle ? `${hangulTitle} ${artist} 악보` : '',
        hangulTitle && latinOnly.length >= 3
          ? `${hangulTitle} ${latinOnly} 악보`
          : '',
        meta.searchQuery,
        !shortHangul && altTitle ? `${altTitle} 악보` : '',
        altTitle && hangulTitle ? `${hangulTitle}(${altTitle}) 악보` : '',
        songTitle ? `${songTitle} sheet music` : '',
      ].filter(Boolean);

  // 중복 쿼리 제거 (순서 유지)
  const uniqQueries = [];
  const seenQ = new Set();
  for (const q of queries) {
    const key = q.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seenQ.has(key)) continue;
    seenQ.add(key);
    uniqQueries.push(q);
  }

  const seen = new Set();
  let best = null;

  /** 후보 목록에서 최적 악보 선택 (이미 best가 있으면 갱신만) */
  async function evaluateCandidates(list) {
    const ranked = list
      .map((c) => ({
        ...c,
        hit: scoreImageCandidate(c, songTitle, artist, { isHymn, hymnNo }),
      }))
      .sort((a, b) => b.hit - a.hit);

    for (const c of ranked.slice(0, MAX_CANDIDATES_TO_TRY)) {
      if (c.hit < 16) continue;
      // 찬송가는 찬송가/새찬송가 표기가 있는 후보만
      if (
        isHymn &&
        !/새찬송가|통일찬송가|찬송가\s*\d{2,3}\s*장/i.test(c.title || '')
      ) {
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        let buf = await fetchBuffer(c.url, c.source || undefined);
        // eslint-disable-next-line no-await-in-loop
        buf = await normalizeScoreBuffer(buf);
        const sharp = require('sharp');
        // eslint-disable-next-line no-await-in-loop
        let imgMeta = await sharp(buf).metadata();
        if (!imgMeta.width || !imgMeta.height) continue;
        // 일반 CCM은 가로형·짧은 이미지도 허용폭을 조금 넓힘
        if (imgMeta.width / imgMeta.height > 1.55 && c.hit < (isHymn ? 60 : 45)) {
          continue;
        }
        if (imgMeta.height < (isHymn ? 400 : 320) && c.hit < 70) continue;
        if (
          imgMeta.width >= imgMeta.height &&
          imgMeta.height < (isHymn ? 700 : 480) &&
          c.hit < (isHymn ? 110 : 70)
        ) {
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        let clarity = await assessImageClarity(buf);
        if (!clarity.ok && /bottom-blur|bottom-third-blur/i.test(clarity.reason || '')) {
          // eslint-disable-next-line no-await-in-loop
          const salvaged = await trySalvageBottomBlur(buf);
          if (salvaged) {
            buf = salvaged.buffer;
            clarity = { ...salvaged.clarity, reason: `salvaged-${clarity.reason}` };
            // eslint-disable-next-line no-await-in-loop
            const m2 = await sharp(buf).metadata();
            if (m2.width && m2.height) {
              imgMeta = m2;
            }
            console.log(
              `[playlist-score-pdf] salvage bottom-blur · ${(c.title || '').slice(0, 40)}`,
            );
          }
        }
        if (!clarity.ok) {
          console.log(
            `[playlist-score-pdf] skip low-quality (${clarity.reason}) · ${(c.title || '').slice(0, 40)}`,
          );
          continue;
        }
        if ((clarity.staffish || 0) < 1 && c.hit < 85) continue;

        const paper = Number(clarity.paper) || 0;
        if (paper < (isHymn ? 195 : 175) && c.hit < 95) continue;

        const area = imgMeta.width * imgMeta.height;
        const portraitBonus =
          imgMeta.height / imgMeta.width >= 1.15
            ? 20
            : imgMeta.height / imgMeta.width >= 1.0
              ? 8
              : 0;
        const whiteBonus =
          paper >= 235 ? 30 : paper >= 220 ? 18 : paper >= 205 ? 6 : -20;
        const hymnBookBonus = isHymn
          ? /새찬송가|통일찬송가/i.test(c.title || '') ||
            (/찬송가\s*\d{2,3}\s*장/i.test(c.title || '') &&
              !/예람|피아|코드\s*악보|편곡|워십/i.test(c.title || ''))
            ? 45
            : -40
          : 0;
        const fitness =
          c.hit +
          portraitBonus +
          whiteBonus +
          hymnBookBonus +
          Math.min(35, Math.floor(area / 45000)) +
          Math.min(24, (clarity.staffish || 0) * 2);

        const candTitle = c.title || '';
        const candPartial =
          /<Intro>|\[Intro\]|인트로만/i.test(candTitle) ||
          (/피아노\s*악보|piano\s*(score|sheet|악보)?/i.test(candTitle) &&
            !/단선|멜로디|코드\s*악보|가사\s*악보|전체/i.test(candTitle));
        const candComplete =
          /단선|멜로디|코드\s*악보|가사\s*악보|lead\s*sheet|전체\s*악보/i.test(
            candTitle,
          );
        const bestPartial =
          best &&
          (/<Intro>|\[Intro\]|인트로만/i.test(best.meta?.title || '') ||
            (/피아노\s*악보|piano/i.test(best.meta?.title || '') &&
              !/단선|멜로디|코드\s*악보|가사\s*악보|전체/i.test(
                best.meta?.title || '',
              )));
        const bestComplete =
          best &&
          /단선|멜로디|코드\s*악보|가사\s*악보|lead\s*sheet|전체\s*악보/i.test(
            best.meta?.title || '',
          );
        // 부분(Intro/피아노) 후보보다 단선·코드 악보를 우선
        const preferComplete =
          bestPartial && candComplete && fitness >= (best.fitness || 0) - 55;
        // 이미 단선/코드가 있으면 Intro·피아노만으로 덮어쓰지 않음
        const keepComplete =
          bestComplete && candPartial && fitness < (best.fitness || 0) + 45;
        if (
          !keepComplete &&
          (!best || fitness > best.fitness || preferComplete)
        ) {
          best = {
            buffer: buf,
            meta: {
              title: c.title,
              url: c.url,
              source: c.source,
              hit: c.hit,
              fitness,
              clarity: clarity.reason,
              paper,
              provider: c.provider,
              hymnNo: hymnNo || undefined,
            },
            scoreFound: true,
            fitness,
          };
        }

        const hymnOk =
          !isHymn ||
          /새찬송가|통일찬송가/i.test(c.title || '') ||
          (/찬송가\s*\d{2,3}\s*장/i.test(c.title || '') &&
            !/예람|피아|코드\s*악보|편곡|워십/i.test(c.title || ''));
        // Intro-only·순수 피아노는 후보로만 보관하고, 단선/코드 검색을 더 돌림
        const looksPartialScore = candPartial;
        if (
          fitness >= 130 &&
          (clarity.staffish || 0) >= 6 &&
          paper >= 220 &&
          hymnOk &&
          !looksPartialScore
        ) {
          return true; // 충분히 좋음 → 조기 종료
        }
      } catch (e) {
        const msg = String(e.message || e);
        // 흔한 CDN 차단은 조용히 스킵, 그 외만 로그
        if (!/fetch failed|HTTP 403|HTTP 404|aborted|too small/i.test(msg)) {
          console.warn(
            `[playlist-score-pdf] candidate fail:`,
            msg.slice(0, 100),
          );
        }
      }
    }
    return Boolean(best && best.fitness >= 130);
  }

  // 쿼리×검색엔진 순차: 네이버 → 구글 → Bing. 좋은 후보 있으면 이후 스킵
  const providerChain = [
    { name: 'naver', run: searchNaverImages },
    { name: 'google', run: searchGoogleImages },
    { name: 'bing', run: searchBingImages },
  ];

  outer: for (const q of uniqQueries) {
    for (const p of providerChain) {
      // eslint-disable-next-line no-await-in-loop
      const found = await searchScoreImages(q, { providers: [p] });
      const batch = [];
      for (const c of found) {
        if (!c.url || seen.has(c.url)) continue;
        if (shouldSkipCandidate(c, { isHymn, hymnNo })) continue;
        seen.add(c.url);
        batch.push(c);
      }
      if (batch.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      const goodEnough = await evaluateCandidates(batch);
      if (goodEnough) break outer;
    }
    // 쓸 만한 단선/코드 악보면 추가 쿼리 생략. Intro·피아노만이면 계속 검색
    if (best && best.fitness >= (isHymn ? 130 : 110)) {
      const t = String(best.meta?.title || '');
      const partial =
        /<Intro>|\[Intro\]|인트로만/i.test(t) ||
        (/피아노\s*악보|piano/i.test(t) &&
          !/단선|멜로디|코드\s*악보|가사\s*악보|전체/i.test(t));
      if (!partial) break;
    }
  }

  // 1차 실패 시: 문턱을 낮춰 한 번 더 (긴 CCM 곡명·블로그 악보 대응)
  if (!best && !isHymn && uniqQueries.length) {
    console.log(
      `[playlist-score-pdf] relaxed retry · "${(songTitle || '').slice(0, 40)}"`,
    );
    const softEvaluate = async (list) => {
      const ranked = list
        .map((c) => ({
          ...c,
          hit: scoreImageCandidate(c, songTitle, artist, { isHymn, hymnNo }),
        }))
        .sort((a, b) => b.hit - a.hit);
      for (const c of ranked.slice(0, MAX_CANDIDATES_TO_TRY)) {
        if (c.hit < 12) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          let buf = await fetchBuffer(c.url, c.source || undefined);
          // eslint-disable-next-line no-await-in-loop
          buf = await normalizeScoreBuffer(buf);
          const sharp = require('sharp');
          // eslint-disable-next-line no-await-in-loop
          const imgMeta = await sharp(buf).metadata();
          if (!imgMeta.width || !imgMeta.height) continue;
          if (imgMeta.height < 280) continue;
          // eslint-disable-next-line no-await-in-loop
          let clarity = await assessImageClarity(buf);
          if (!clarity.ok && /bottom-blur|bottom-third-blur/i.test(clarity.reason || '')) {
            // eslint-disable-next-line no-await-in-loop
            const salvaged = await trySalvageBottomBlur(buf);
            if (salvaged) {
              buf = salvaged.buffer;
              clarity = salvaged.clarity;
            }
          }
          if (!clarity.ok) continue;
          if ((clarity.staffish || 0) < 1 && c.hit < 40) continue;
          const paper = Number(clarity.paper) || 0;
          if (paper < 160) continue;
          const area = imgMeta.width * imgMeta.height;
          const fitness =
            c.hit +
            Math.min(30, Math.floor(area / 50000)) +
            Math.min(20, (clarity.staffish || 0) * 2) +
            (paper >= 210 ? 12 : 0);
          if (!best || fitness > best.fitness) {
            best = {
              buffer: buf,
              meta: {
                title: c.title,
                url: c.url,
                source: c.source,
                hit: c.hit,
                fitness,
                clarity: clarity.reason,
                paper,
                provider: c.provider,
                relaxed: true,
              },
              scoreFound: true,
              fitness,
            };
          }
          if (fitness >= 90) return true;
        } catch {
          /* skip */
        }
      }
      return Boolean(best);
    };

    for (const q of uniqQueries.slice(0, 8)) {
      // eslint-disable-next-line no-await-in-loop
      const found = await searchScoreImages(q, {
        providers: [{ name: 'naver', run: searchNaverImages }],
      });
      const batch = [];
      for (const c of found) {
        if (!c.url || seen.has(c.url)) continue;
        if (shouldSkipCandidate(c, { isHymn, hymnNo })) continue;
        seen.add(c.url);
        batch.push(c);
      }
      if (!batch.length) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await softEvaluate(batch)) break;
    }
  }

  if (best) {
    try {
      best.buffer = await whitenScoreBackground(best.buffer);
    } catch (e) {
      console.warn(
        '[playlist-score-pdf] whiten fail — 원본 사용:',
        String(e.message || e).slice(0, 100),
      );
    }
    return {
      buffer: best.buffer,
      meta: best.meta,
      scoreFound: true,
    };
  }

  return { buffer: null, meta: null, scoreFound: false };
}

/** 검색 결과 URL 정리 */
function normalizeCandidateUrl(url) {
  let u = upgradeImageUrl(url);
  if (!u) return '';
  // blogfiles.naver.net 은 https 핸드셰이크가 실패하는 경우가 많음 → http 유지
  const keepHttp =
    /^http:\/\/(?:[^/]*\.)?(?:blogfiles\.naver\.net|postfiles\d*\.pstatic\.net|blogfiles\.pstatic\.net)/i.test(
      u,
    );
  if (!keepHttp && u.startsWith('http://')) {
    u = `https://${u.slice(7)}`;
  }
  return u
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

/** DuckDuckGo 이미지 검색 */
async function searchDdgImages(query, signal) {
  const home = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    {
      signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    },
  );
  const html = await home.text();
  const vqd =
    (html.match(/vqd=(["']?)([\d-]+)/) ||
      html.match(/vqd\\":\\"([^\\"]+)/) ||
      [])[2];
  if (!vqd) return [];

  const api = `https://duckduckgo.com/i.js?l=kr-kr&o=json&q=${encodeURIComponent(
    query,
  )}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`;
  const res = await fetch(api, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://duckduckgo.com/',
      Accept: 'application/json,text/javascript,*/*',
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) => ({
      title: r.title || '',
      url: normalizeCandidateUrl(r.image || r.thumbnail || ''),
      thumb: r.thumbnail || '',
      width: r.width,
      height: r.height,
      source: r.url || '',
      provider: 'ddg',
    }))
    .filter((r) => r.url);
}

/** Bing 이미지(async) — Render에서 DDG가 막힐 때 대비 */
async function searchBingImages(query, signal) {
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(
    query,
  )}&first=0&count=35&relp=35&lostate=r&mmasync=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Referer: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
      Accept: 'text/html,*/*',
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const blocks = html.split(/murl&quot;:&quot;/);
  for (const block of blocks.slice(1, 40)) {
    const rawUrl = block.split('&quot;')[0] || '';
    const title =
      (block.match(/t&quot;:&quot;([\s\S]*?)&quot;/) || [])[1] ||
      (block.match(/title&quot;:&quot;([\s\S]*?)&quot;/) || [])[1] ||
      '';
    const page =
      (block.match(/purl&quot;:&quot;([\s\S]*?)&quot;/) || [])[1] || '';
    const img = normalizeCandidateUrl(rawUrl);
    if (!img) continue;
    out.push({
      title: title.replace(/&amp;/g, '&'),
      url: img,
      thumb: '',
      width: 0,
      height: 0,
      source: normalizeCandidateUrl(page) || page,
      provider: 'bing',
    });
  }
  return out;
}

/** 네이버 이미지 검색 — 한국어 찬양 악보에 강함 */
async function searchNaverImages(query, signal) {
  const url = `https://search.naver.com/search.naver?where=image&sm=tab_jum&query=${encodeURIComponent(
    query,
  )}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const chunks = html.split('"type":"image"');
  for (const chunk of chunks.slice(1, 40)) {
    const title = (chunk.match(/"title":"((?:\\.|[^"\\])*)"/) || [])[1] || '';
    const link = (chunk.match(/"link":"((?:\\.|[^"\\])*)"/) || [])[1] || '';
    const originalUrl =
      (chunk.match(/"originalUrl":"((?:\\.|[^"\\])*)"/) || [])[1] || '';
    const thumb = (chunk.match(/"thumb":"((?:\\.|[^"\\])*)"/) || [])[1] || '';
    const w = Number((chunk.match(/"orgWidth":(\d+)/) || [])[1] || 0);
    const h = Number((chunk.match(/"orgHeight":(\d+)/) || [])[1] || 0);
    const img = normalizeCandidateUrl(originalUrl || thumb);
    if (!img) continue;
    out.push({
      title: title
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/\\"/g, '"'),
      url: img,
      thumb: normalizeCandidateUrl(thumb),
      width: w,
      height: h,
      source: normalizeCandidateUrl(link) || link,
      provider: 'naver',
    });
  }
  return out;
}

/** 구글 이미지 검색 (async JSON) — 한 곡 전체 악보 후보 보강 */
async function searchGoogleImages(query, signal) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(
    query,
  )}&tbm=isch&hl=ko&gl=kr&asearch=isch&async=_fmt:json,p:1,ijn:0`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Accept: '*/*',
      Referer: 'https://www.google.com/',
    },
  });
  if (!res.ok) return [];
  let text = await res.text();
  text = text.replace(/^\)\]\}'\n?/, '');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const meta = data?.ischj?.metadata;
  if (!Array.isArray(meta)) return [];

  return meta
    .map((m) => {
      const oi = m.original_image || {};
      const result = m.result || {};
      return {
        title: result.page_title || result.site_title || '',
        url: normalizeCandidateUrl(oi.url || ''),
        thumb: normalizeCandidateUrl(m.thumbnail?.url || ''),
        width: Number(oi.width) || 0,
        height: Number(oi.height) || 0,
        source: result.referrer_url || '',
        provider: 'google',
      };
    })
    .filter((r) => r.url);
}

/** 이미지 검색 — 네이버 → 구글 → Bing 순차 (충분하면 이후 스킵) */
async function searchScoreImages(query, { providers } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const merged = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const item of list || []) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
    }
  };

  // 기본: 네이버→구글→Bing. 호출측에서 일부만 지정 가능
  const chain = providers || [
    { name: 'naver', run: searchNaverImages },
    { name: 'google', run: searchGoogleImages },
    { name: 'bing', run: searchBingImages },
  ];

  try {
    for (const p of chain) {
      try {
        // eslint-disable-next-line no-await-in-loop
        pushAll(await p.run(q, controller.signal));
      } catch (e) {
        console.warn(`[playlist-score-pdf] ${p.name} fail:`, e.message);
      }
      // 후보가 충분하면 다음 엔진은 생략 (순차 조기 종료)
      if (merged.length >= 18) break;
    }
    // 최후 보루 — 앞 엔진이 거의 비었을 때만 DDG
    if (merged.length < 6) {
      try {
        pushAll(await searchDdgImages(q, controller.signal));
      } catch (e) {
        console.warn('[playlist-score-pdf] ddg search fail:', e.message);
      }
    }
    if (merged.length) {
      const names = [...new Set(merged.map((m) => m.provider))].join('+');
      console.log(
        `[playlist-score-pdf] search "${q.slice(0, 40)}" → ${merged.length} · ${names}`,
      );
    }
    return merged;
  } catch {
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

/** 악보를 못 찾았을 때 플레이스홀더 카드 */
async function renderPlaceholderCard(song, slotW, slotH) {
  const sharp = require('sharp');
  const title = String(song.title || '제목 없음').slice(0, 40);
  const sub = String(song.channel || song.videoTitle || '').slice(0, 48);
  const msg = '악보 이미지를 찾지 못했습니다';

  // SVG 텍스트는 Linux에서 한글 폰트가 없으면 깨지므로 sharp text+fontfile 우선
  const layers = [
    {
      input: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${slotW}" height="${slotH}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="16" y="16" width="${slotW - 32}" height="${slotH - 32}" fill="none" stroke="#CCCCCC" stroke-width="2"/>
</svg>`,
      ),
      top: 0,
      left: 0,
    },
  ];

  const tryText = async (text, dpi, topY) => {
    try {
      const opts = {
        text,
        font: 'sans',
        dpi,
        rgba: true,
        align: 'center',
        width: Math.max(80, slotW - 64),
      };
      if (fs.existsSync(FONT_BOLD)) opts.fontfile = FONT_BOLD;
      else if (fs.existsSync(FONT_REG)) opts.fontfile = FONT_REG;
      const buf = await sharp({
        text: opts,
      })
        .png()
        .toBuffer();
      const meta = await sharp(buf).metadata();
      const left = Math.max(0, Math.floor((slotW - (meta.width || 0)) / 2));
      layers.push({ input: buf, top: topY, left });
      return true;
    } catch (e) {
      console.warn(
        '[playlist-score-pdf] placeholder text fail:',
        String(e.message || e).slice(0, 80),
      );
      return false;
    }
  };

  await tryText(title, 180, Math.floor(slotH * 0.4));
  if (sub) await tryText(sub, 120, Math.floor(slotH * 0.52));
  await tryText(msg, 130, Math.floor(slotH * 0.66));

  // 폰트 렌더 실패 시 ASCII 안내라도 표시
  if (layers.length === 1) {
    const svg = wrapSvg(
      slotW,
      slotH,
      `
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="16" y="16" width="${slotW - 32}" height="${slotH - 32}" fill="none" stroke="#CCCCCC" stroke-width="2"/>
  <text x="${slotW / 2}" y="${slotH * 0.45}" text-anchor="middle" font-size="22" fill="#333333">${escapeXml(title)}</text>
  <text x="${slotW / 2}" y="${slotH * 0.55}" text-anchor="middle" font-size="14" fill="#777777">${escapeXml(sub)}</text>
  <text x="${slotW / 2}" y="${slotH * 0.68}" text-anchor="middle" font-size="14" fill="#999999">Score image not found</text>`,
    );
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  return sharp({
    create: {
      width: slotW,
      height: slotH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * 참고 PDF처럼: 흰 배경 + 악보 이미지만 (좌/우 칸)
 * 좌상단에 빨간 원 번호
 */
async function buildSongSlot(song, slotW, slotH) {
  const sharp = require('sharp');
  let img = song.imageBuffer;

  if (!img) {
    img = await renderPlaceholderCard(song, slotW, slotH);
  } else {
    // 칸을 최대한 채우도록 맞춤 — 너무 작은 원본은 확대해서 가독성 확보
    img = await sharp(img)
      .resize(slotW - 12, slotH - 12, {
        fit: 'inside',
        withoutEnlargement: false,
        background: '#ffffff',
      })
      .flatten({ background: '#ffffff' })
      .sharpen({ sigma: 0.6 })
      .png()
      .toBuffer();
  }

  const meta = await sharp(img).metadata();
  const iw = meta.width || slotW;
  const ih = meta.height || slotH;
  const left = Math.max(0, Math.floor((slotW - iw) / 2));
  const top = Math.max(0, Math.floor((slotH - ih) / 2));

  const num = String(song.index || '');
  const badgeR = 22;
  const badgeSvg = wrapSvg(
    badgeR * 2 + 4,
    badgeR * 2 + 4,
    `
  <circle cx="${badgeR + 2}" cy="${badgeR + 2}" r="${badgeR}" fill="none" stroke="#D32F2F" stroke-width="3"/>
  <text x="${badgeR + 2}" y="${badgeR + 9}" text-anchor="middle" font-size="26" font-weight="700" fill="#D32F2F">${escapeXml(num)}</text>`,
  );

  return sharp({
    create: {
      width: slotW,
      height: slotH,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([
      { input: img, top, left },
      { input: Buffer.from(badgeSvg), top: 6, left: 6 },
    ])
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
}

/** 가로 A4 · 왼쪽/오른쪽 각 1곡 (페이지당 2곡) */
async function composePage(songsOnPage) {
  const sharp = require('sharp');
  const slotW = Math.floor((PAGE_W - MARGIN * 2 - GAP) / 2);
  const slotH = PAGE_H - MARGIN * 2;

  const layers = [
    {
      input: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}">
  <rect width="100%" height="100%" fill="#ffffff"/>
</svg>`,
      ),
      top: 0,
      left: 0,
    },
  ];

  for (let i = 0; i < songsOnPage.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const slot = await buildSongSlot(songsOnPage[i], slotW, slotH);
    layers.push({
      input: slot,
      top: MARGIN,
      left: MARGIN + i * (slotW + GAP),
    });
  }

  return sharp({
    create: {
      width: PAGE_W,
      height: PAGE_H,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(layers)
    .jpeg({ quality: 93 })
    .toBuffer();
}

/**
 * 여러 JPEG 페이지 → 멀티페이지 PDF (A4 포인트)
 */
function jpegsToPdf(pages) {
  const pageW = PDF_PAGE_W;
  const pageH = PDF_PAGE_H;
  const chunks = [];
  const push = (b) => chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
  const offsets = [];

  push('%PDF-1.4\n');

  const writeObj = (num, bodyBuf) => {
    offsets[num] = Buffer.concat(chunks).length;
    push(`${num} 0 obj\n`);
    push(bodyBuf);
    push('\nendobj\n');
  };

  const pageCount = pages.length;
  const kids = [];
  let objNum = 3;

  const pageObjs = [];
  for (let i = 0; i < pageCount; i++) {
    const pageObj = objNum++;
    const contentObj = objNum++;
    const imageObj = objNum++;
    pageObjs.push({ pageObj, contentObj, imageObj, jpeg: pages[i] });
    kids.push(`${pageObj} 0 R`);
  }

  writeObj(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  writeObj(
    2,
    Buffer.from(
      `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
    ),
  );

  for (const p of pageObjs) {
    const imgW = PAGE_W;
    const imgH = PAGE_H;
    const stream = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;

    writeObj(
      p.pageObj,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents ${p.contentObj} 0 R /Resources << /XObject << /Im0 ${p.imageObj} 0 R >> >> >>`,
      ),
    );
    writeObj(
      p.contentObj,
      Buffer.concat([
        Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n`),
        Buffer.from(stream),
        Buffer.from('endstream'),
      ]),
    );
    writeObj(
      p.imageObj,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
        ),
        p.jpeg,
        Buffer.from('\nendstream'),
      ]),
    );
  }

  const xrefStart = Buffer.concat(chunks).length;
  const maxObj = objNum - 1;
  let xref = `xref\n0 ${maxObj + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= maxObj; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return Buffer.concat(chunks);
}

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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  );
  return results;
}

/**
 * @param {string} playlistUrl
 * @param {{ onProgress?: (p: { stage: string, message: string, current?: number, total?: number }) => void }} [opts]
 */
async function buildPlaylistScorePdf(playlistUrl, opts = {}) {
  const onProgress =
    typeof opts.onProgress === 'function' ? opts.onProgress : () => undefined;

  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    const err = new Error(
      '유튜브 재생목록 URL이 올바르지 않습니다. list=... 가 포함된 주소를 넣어 주세요.',
    );
    err.code = 'BAD_URL';
    throw err;
  }

  onProgress({
    stage: 'playlist',
    message: '재생목록을 불러오는 중…',
  });
  console.log(`[playlist-score-pdf] playlist=${playlistId}`);

  let loaded;
  try {
    loaded = await loadPlaylist(playlistId);
  } catch (e) {
    const err = new Error(
      `재생목록을 불러오지 못했습니다: ${e.message || e}`,
    );
    err.code = 'PLAYLIST_FETCH';
    throw err;
  }

  const videos = (loaded.videos || []).filter((v) => v?.id).slice(0, MAX_SONGS);
  if (videos.length === 0) {
    const err = new Error(
      '재생목록에 영상이 없거나, 비공개/삭제된 재생목록일 수 있습니다. URL을 확인해 주세요.',
    );
    err.code = 'EMPTY';
    throw err;
  }

  console.log(
    `[playlist-score-pdf] ${videos.length}곡 로드 · source=${loaded.source}`,
  );

  const playlistTitle = loaded.title || '악보플레이 재생목록';
  const total = videos.length;
  let doneCount = 0;

  const songs = await mapPool(videos, 2, async (video, idx) => {
    const meta = extractSongMeta(video.title || '');
    const title = meta.title || video.title || `곡 ${idx + 1}`;
    let imageBuffer = null;
    let scoreFound = false;
    let scoreImageTitle = null;
    let scoreImageUrl = null;
    let found = null;

    onProgress({
      stage: 'search',
      message: `악보 검색 중… (${idx + 1}/${total}) ${title}`,
      current: idx + 1,
      total,
    });

    try {
      found = await Promise.race([
        findScoreImageBuffer({
          ...meta,
          videoTitle: video.title || '',
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('곡 검색 시간 초과')),
            SONG_SEARCH_TIMEOUT_MS,
          ),
        ),
      ]);
      if (found.scoreFound && found.buffer) {
        imageBuffer = found.buffer;
        scoreFound = true;
        scoreImageTitle = found.meta?.title || null;
        scoreImageUrl = found.meta?.url || null;
      }
      console.log(
        `[playlist-score-pdf] #${idx + 1} title="${title}" artist="${meta.artist}" query="${meta.searchQuery}" found=${scoreFound} hit=${found?.meta?.hit || '-'} img="${(scoreImageTitle || '').slice(0, 40)}"`,
      );
    } catch (e) {
      console.warn(
        `[playlist-score-pdf] ${title} 실패:`,
        String(e.message || e).slice(0, 120),
      );
    }

    doneCount += 1;
    onProgress({
      stage: 'search',
      message: `악보 검색 ${doneCount}/${total} 완료`,
      current: doneCount,
      total,
    });

    return {
      id: randomUUID(),
      index: idx + 1,
      title,
      artist: meta.artist || '',
      videoTitle: video.title,
      channel: video.channel?.name || video.channel?.title || '',
      sourceVideoId: video.id,
      scoreVideoId: null,
      scoreVideoTitle: scoreImageTitle,
      scoreImageUrl,
      scoreFound,
      imageBuffer,
    };
  });

  onProgress({
    stage: 'compose',
    message: 'PDF 페이지를 만드는 중…',
    current: total,
    total,
  });

  const pages = [];
  for (let i = 0; i < songs.length; i += 2) {
    const pair = songs.slice(i, i + 2);
    // eslint-disable-next-line no-await-in-loop
    pages.push(await composePage(pair));
    // 페이지 합성 후 원본 이미지 버퍼 해제 (메모리)
    for (const s of pair) s.imageBuffer = null;
  }

  const pdf = jpegsToPdf(pages);
  const safeName = String(playlistTitle)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .slice(0, 40);

  onProgress({
    stage: 'done',
    message: 'PDF 생성 완료',
    current: total,
    total,
  });

  return {
    fileName: `${safeName || 'akboplay'}-악보.pdf`,
    playlistTitle,
    playlistId,
    pageCount: pages.length,
    songCount: songs.length,
    foundCount: songs.filter((s) => s.scoreFound).length,
    // pdfBase64는 동기 API 호환용 — jobs는 pdfBuffer만 보관
    pdfBase64: pdf.toString('base64'),
    pdfBuffer: pdf,
    mimePdf: 'application/pdf',
    songs: songs.map((s) => ({
      index: s.index,
      title: s.title,
      videoTitle: s.videoTitle,
      channel: s.channel,
      scoreFound: s.scoreFound,
      scoreVideoTitle: s.scoreVideoTitle,
      sourceVideoId: s.sourceVideoId,
      scoreVideoId: s.scoreVideoId,
      scoreImageUrl: s.scoreImageUrl,
    })),
  };
}

module.exports = {
  buildPlaylistScorePdf,
  extractPlaylistId,
  cleanSongTitle,
  extractSongMeta,
  loadPlaylist,
};
