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
  const searchQuery = [t, artist, '악보'].filter(Boolean).join(' ');

  return { title: t, artist, altTitle, searchQuery };
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
    if (referer) headers.Referer = referer;
    else if (/pstatic\.net|naver\.com|blogfiles\.naver|daumcdn|kakaocdn|tistory|akbotong/i.test(url)) {
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

function scoreImageCandidate(img, songTitle, artist = '') {
  const title = String(img?.title || '');
  const page = String(img?.source || img?.page || '');
  const url = String(img?.url || '');
  const blob = `${title} ${page} ${url}`.toLowerCase().replace(/\s+/g, '');
  const st = String(songTitle || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  let score = 0;

  // 미리보기·유료 워터마크 후보 강하게 배제
  if (
    /preview-v2|\/preview|legal\s*use\s*requires|watermark|미리보기|구매\s*후/i.test(
      `${title} ${page} ${url}`,
    )
  ) {
    score -= 80;
  }
  if (/cdn\.mapianist\.com|mapianist\.com\/sheet/i.test(url + page)) {
    score -= 55;
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

  // 곡명 일치가 핵심
  if (st.length >= 2) {
    if (blob.includes(st)) score += 40;
    else if (st.length >= 4) {
      let hits = 0;
      for (let i = 0; i <= st.length - 3; i++) {
        if (blob.includes(st.slice(i, i + 3))) hits += 1;
      }
      const ratio = hits / Math.max(1, st.length - 2);
      if (ratio >= 0.5) score += 18;
      else score -= 45;
    } else {
      score -= 50;
    }
  }

  if (artist) {
    const a = String(artist).toLowerCase().replace(/\s+/g, '');
    if (a && blob.includes(a)) score += 18;
    if (/welove/i.test(artist) && /위러브|welove/i.test(`${title} ${page}`)) {
      score += 10;
    }
  }

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
    score += 28;
  }
  // 일부·미리보기·잘린 이미지는 감점
  if (
    /1절만|2절만|후렴만|일부|발췌|미리보기|인트로만|하이라이트|썸네일|부분\s*악보|clip|excerpt|preview/i.test(
      `${title} ${page} ${url}`,
    )
  ) {
    score -= 40;
  }

  if (
    /blog\.naver|postfiles\.pstatic|mblogthumb|blogthumb\.pstatic|tistory|kakaocdn|daumcdn|mymusicsheet|worshipmusic|akbobada|cinfonet|akbotong/i.test(
      `${url} ${page}`,
    )
  ) {
    score += 18;
  }
  if (img.provider === 'google') score += 6;
  // 유튜브 썸네일은 한 곡 전체 악보가 아님
  if (/youtube\.com|ytimg\.com|i\.ytimg\.com|pinterest|facebook\.com|lookaside\.fbsbx/i.test(url)) {
    score -= 55;
  }
  if (/emoji|meme|cartoon|스티커|프로필/i.test(title)) score -= 30;

  return score;
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
  if (w0 < 280 || h0 < 360) {
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

  // 하단이 상단보다 훨씬 흐리면(미리보기 블러) 탈락
  if (topEdge > 8 && botEdge / topEdge < 0.42) {
    return {
      ok: false,
      reason: 'bottom-blur',
      score: botEdge / topEdge,
      topEdge,
      botEdge,
    };
  }

  // 전체적으로 너무 흐림
  if (allEdge < 6.5) {
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

  return {
    ok: true,
    reason: 'ok',
    score: allEdge,
    topEdge,
    botEdge,
    darkRatio,
    staffish,
  };
}

/** 메타/URL만으로 바로 스킵할지 */
function shouldSkipCandidate(c) {
  const t = `${c.title || ''} ${c.source || ''} ${c.url || ''}`;
  if (/preview-v2|legal\s*use\s*requires\s*purchase/i.test(t)) return true;
  if (/cdn\.mapianist\.com\/preview/i.test(c.url || '')) return true;
  // 유튜브 썸네일·영상 캡처는 악보 전체가 아님
  if (/ytimg\.com|i\.ytimg\.com|img\.youtube\.com/i.test(c.url || '')) return true;
  if (
    /\b(drum|드럼보|타악보|percussion)\b/i.test(c.title || '') &&
    !/단선|멜로디|코드|가사|피아노/i.test(c.title || '')
  ) {
    return true;
  }
  return false;
}

/** 곡 메타로 악보 이미지 버퍼 확보 */
async function findScoreImageBuffer(metaOrTitle) {
  const meta =
    typeof metaOrTitle === 'string'
      ? extractSongMeta(metaOrTitle)
      : metaOrTitle || {};
  const songTitle = meta.title || '';
  const artist = meta.artist || '';
  const queries = [
    meta.searchQuery,
    songTitle && artist ? `${songTitle} ${artist} 전체 악보` : '',
    songTitle ? `${songTitle} 가사 악보` : '',
    songTitle && artist ? `${songTitle} ${artist} 악보` : '',
    songTitle ? `${songTitle} 단선 악보` : '',
    songTitle ? `${songTitle} 코드 악보` : '',
    songTitle ? `${songTitle} 악보` : '',
    meta.altTitle ? `${meta.altTitle} ${artist} 악보`.trim() : '',
    songTitle && /갈길을 밝히|새벽부터 우리|구주 예수 의지/i.test(songTitle)
      ? `${songTitle} 찬송가 악보`
      : '',
  ].filter(Boolean);

  let candidates = [];
  for (const q of queries) {
    // eslint-disable-next-line no-await-in-loop
    const found = await searchScoreImages(q);
    candidates.push(...found);
    if (candidates.length >= 24) break;
  }

  const seen = new Set();
  candidates = candidates.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    if (shouldSkipCandidate(c)) return false;
    seen.add(c.url);
    return true;
  });

  if (candidates.length === 0) {
    return { buffer: null, meta: null, scoreFound: false };
  }

  const ranked = candidates
    .map((c) => ({ ...c, hit: scoreImageCandidate(c, songTitle, artist) }))
    .sort((a, b) => b.hit - a.hit);

  // 첫 통과가 아니라, 한 곡 전체가 보이는 선명한 악보를 고름
  let best = null;
  for (const c of ranked.slice(0, 16)) {
    if (c.hit < 22) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const buf = await fetchBuffer(c.url, c.source || undefined);
      const sharp = require('sharp');
      // eslint-disable-next-line no-await-in-loop
      const imgMeta = await sharp(buf).metadata();
      if (!imgMeta.width || !imgMeta.height) continue;
      // 가로로 잘린 썸네일/일부 이미지 제외
      if (imgMeta.width / imgMeta.height > 1.45 && c.hit < 60) continue;
      if (imgMeta.height < 480 && c.hit < 70) continue;

      // eslint-disable-next-line no-await-in-loop
      const clarity = await assessImageClarity(buf);
      if (!clarity.ok) {
        console.log(
          `[playlist-score-pdf] skip low-quality (${clarity.reason}) · ${(c.title || '').slice(0, 40)}`,
        );
        continue;
      }
      // 오선이 거의 없으면(사진·썸네일) 한 곡 전체 악보로 보기 어려움
      if ((clarity.staffish || 0) < 2 && c.hit < 85) continue;

      const area = imgMeta.width * imgMeta.height;
      const portraitBonus =
        imgMeta.height / imgMeta.width >= 1.15
          ? 20
          : imgMeta.height / imgMeta.width >= 1.0
            ? 8
            : 0;
      const fitness =
        c.hit +
        portraitBonus +
        Math.min(35, Math.floor(area / 45000)) +
        Math.min(24, (clarity.staffish || 0) * 2);

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
            provider: c.provider,
          },
          scoreFound: true,
          fitness,
        };
      }
      // 충분히 좋은 전체 악보면 조기 종료
      if (fitness >= 120 && (clarity.staffish || 0) >= 6) break;
    } catch {
      /* next */
    }
  }

  if (best) {
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
  if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
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

/** 이미지 검색 (네이버 + Bing + Google, DDG 폴백) */
async function searchScoreImages(query) {
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

  try {
    const settled = await Promise.allSettled([
      searchNaverImages(q, controller.signal),
      searchBingImages(q, controller.signal),
      searchGoogleImages(q, controller.signal),
    ]);
    for (const s of settled) {
      if (s.status === 'fulfilled') pushAll(s.value);
      else console.warn('[playlist-score-pdf] search fail:', s.reason?.message);
    }
    if (merged.length < 10) {
      try {
        pushAll(await searchDdgImages(q, controller.signal));
      } catch (e) {
        console.warn('[playlist-score-pdf] ddg search fail:', e.message);
      }
    }
    if (merged.length) {
      const providers = [...new Set(merged.map((m) => m.provider))].join('+');
      console.log(
        `[playlist-score-pdf] search "${q.slice(0, 40)}" → ${merged.length} · ${providers}`,
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
  const title = escapeXml(song.title || '제목 없음');
  const sub = escapeXml(song.channel || song.videoTitle || '');
  const svg = wrapSvg(
    slotW,
    slotH,
    `
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="16" y="16" width="${slotW - 32}" height="${slotH - 32}" fill="none" stroke="#CCCCCC" stroke-width="2"/>
  <text x="${slotW / 2}" y="${slotH * 0.42}" text-anchor="middle" font-size="56" fill="#999999">𝄞</text>
  <text x="${slotW / 2}" y="${slotH * 0.55}" text-anchor="middle" font-size="28" font-weight="700" fill="#333333">${title}</text>
  <text x="${slotW / 2}" y="${slotH * 0.62}" text-anchor="middle" font-size="16" fill="#777777">${sub}</text>
  <text x="${slotW / 2}" y="${slotH * 0.74}" text-anchor="middle" font-size="15" fill="#999999">악보 이미지를 찾지 못했습니다</text>`,
  );
  return sharp(Buffer.from(svg)).png().toBuffer();
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
    // 여백 조금 두고 칸에 맞춤 (가로·세로 모두 맞춤, 잘림 최소)
    img = await sharp(img)
      .resize(slotW - 8, slotH - 8, {
        fit: 'inside',
        background: '#ffffff',
      })
      .flatten({ background: '#ffffff' })
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
    .jpeg({ quality: 93 })
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

  const songs = await mapPool(videos, 3, async (video, idx) => {
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
      found = await findScoreImageBuffer(meta);
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
