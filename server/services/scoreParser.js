/**
 * 악보 PDF에서 곡 제목/작곡가 후보를 추출합니다.
 * - 텍스트 PDF: pdf-parse
 * - 찬송가 스캔(Adobe Scan 등): 가사 지문 + 휴리스틱
 * - 텍스트가 거의 없으면: 페이지 렌더 → Tesseract OCR
 */
const { PDFParse } = require('pdf-parse');
const { randomUUID } = require('crypto');
const {
  extractHymnsFromText,
  isJunkFileName,
  isJunkTitle,
  isPageMarker,
  isThinPdfText,
} = require('./hymnParser');

const DEMO_SONGS = [
  { title: 'Canon in D', composer: 'Johann Pachelbel' },
  { title: 'Clair de Lune', composer: 'Claude Debussy' },
  { title: 'River Flows in You', composer: 'Yiruma' },
  { title: 'Gymnopédie No.1', composer: 'Erik Satie' },
  { title: '봄날', composer: 'BTS' },
];

/** 악보에서 자주 나오는 잡텍스트 필터 */
const NOISE =
  /^(page|페이지|copyright|©|www\.|http|score|sheet music|tempo|allegro|andante|moderato|adagio|piano|forte|mezzo|cresc|dim\.|ped\.|\d+$)/i;

function cleanLine(line) {
  return line
    .replace(/\s+/g, ' ')
    .replace(/[|_=]{2,}/g, '')
    .trim();
}

function looksLikeTitle(line) {
  if (!line || line.length < 2 || line.length > 80) return false;
  if (isPageMarker(line) || isJunkTitle(line)) return false;
  if (NOISE.test(line)) return false;
  if (/^[\d\W]+$/.test(line)) return false;
  if (/^[♪♫𝄞𝄢♮♯♭\s\-–—]+$/.test(line)) return false;
  // 기타 코드만 있는 줄 제외
  if (/^(?:[A-G](?:#|b)?m?\d?(?:maj|min|sus|dim|aug)?(?:\/[A-G](?:#|b)?)?\s*)+$/i.test(line)) {
    return false;
  }
  return true;
}

/**
 * 일반(비서양 클래식/CCM) PDF 텍스트 휴리스틱
 */
function extractGenericSongsFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);

  const candidates = [];
  const seen = new Set();

  const push = (title, composer, confidence) => {
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    if (isJunkFileName(title)) return;
    seen.add(key);
    candidates.push({
      id: randomUUID(),
      title,
      composer: composer || undefined,
      confidence,
      selected: true,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const split = line.match(/^(.{2,60}?)\s*[—–\-]\s*(.{2,40})$/);
    // '/' 는 Capo/코드에 많아 제목 분리에 쓰지 않음
    if (
      split &&
      looksLikeTitle(split[1]) &&
      !/^(capo|기타|bb|bm|cm|eb|ab|\d{4})/i.test(split[1]) &&
      !/^\d{4}\)?$/.test(split[2].trim())
    ) {
      push(split[1].trim(), split[2].trim(), 0.9);
      continue;
    }

    const composerMatch = line.match(/^(?:composer|작곡|作曲)\s*[:：]\s*(.+)$/i);
    if (composerMatch) {
      const prev = lines[i - 1];
      const next = lines[i + 1];
      if (prev && looksLikeTitle(prev)) push(prev, composerMatch[1], 0.88);
      else if (next && looksLikeTitle(next)) push(next, composerMatch[1], 0.85);
      continue;
    }

    if (i < 40 && looksLikeTitle(line) && line.length <= 48) {
      const next = lines[i + 1];
      const maybeComposer =
        next &&
        next.length <= 40 &&
        /[A-Za-z가-힣]/.test(next) &&
        !/^(page|tempo|allegro)/i.test(next)
          ? next
          : undefined;
      if (!/[.!?。]$/.test(line) && line.split(' ').length <= 10) {
        push(line, maybeComposer, 0.55 + (i < 8 ? 0.2 : 0));
      }
    }
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20)
    .map((c, idx) => ({
      ...c,
      selected: idx < 12 && c.confidence >= 0.55,
    }));
}

function extractSongsFromText(text) {
  // 찬송가/복음성가/CCM 단서면 일반 휴리스틱(코드·작곡가 조각)으로 넘어가지 않음
  const hymnalHint =
    /후렴|찬송|보통으로|기타코드|마\s*\d+|고후|cassel|nakada|복음가|성령\s*하나님|나그네|예배|푯대|jesus\s*loves|경배와찬양|움직이는\s*교회/i.test(
      text,
    );

  const hymns = extractHymnsFromText(text);
  if (hymns.length >= 1 || hymnalHint) {
    return hymns;
  }
  return extractGenericSongsFromText(text).filter(
    (s) => !isPageMarker(s.title) && !isJunkTitle(s.title),
  );
}

/** 페이지 이미지를 OCR (스캔본 보강) */
async function ocrPdfPages(buffer) {
  let sharp;
  let Tesseract;
  try {
    sharp = require('sharp');
    Tesseract = require('tesseract.js');
  } catch {
    return '';
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const shot = await parser.getScreenshot({
      first: 6,
      scale: 2.2,
      imageBuffer: true,
      imageDataUrl: false,
    });

    const chunks = [];
    for (const page of shot.pages || []) {
      const img = Buffer.from(page.data);
      const meta = await sharp(img).metadata();
      const h = meta.height || 0;
      const w = meta.width || 0;
      if (!h || !w) continue;

      const landscape = w > h;
      // 가로 악보(좌우 2곡) / 세로 악보(상하 2곡) 모두 커버
      const regions = landscape
        ? [
            { left: 0, top: 0, width: Math.floor(w * 0.5), height: Math.floor(h * 0.28) },
            { left: Math.floor(w * 0.5), top: 0, width: Math.floor(w * 0.5), height: Math.floor(h * 0.28) },
            { left: 0, top: Math.floor(h * 0.08), width: w, height: Math.floor(h * 0.22) },
          ]
        : [
            { left: 0, top: 0, width: w, height: Math.floor(h * 0.22) },
            { left: 0, top: Math.floor(h * 0.45), width: w, height: Math.floor(h * 0.2) },
          ];

      for (const region of regions) {
        try {
          const crop = await sharp(img).extract(region).png().toBuffer();
          const result = await Tesseract.recognize(crop, 'kor+eng', {
            logger: () => undefined,
          });
          if (result?.data?.text) chunks.push(result.data.text);
        } catch {
          // 개별 영역 실패는 무시
        }
      }

      // 스캔 악보는 전체 페이지 OCR이 제목 인식에 더 안정적
      try {
        const full = await sharp(img)
          .resize({ width: Math.min(w, 1600), withoutEnlargement: true })
          .png()
          .toBuffer();
        const result = await Tesseract.recognize(full, 'kor+eng', {
          logger: () => undefined,
        });
        if (result?.data?.text) chunks.push(result.data.text);
      } catch {
        // ignore
      }
    }
    return chunks.join('\n');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function analyzePdfBuffer(buffer, fileName) {
  if (!buffer || buffer.length < 20) {
    return {
      fileName,
      method: 'demo',
      songs: DEMO_SONGS.map((s) => ({
        id: randomUUID(),
        ...s,
        confidence: 0.95,
        selected: true,
      })),
    };
  }

  const parser = new PDFParse({ data: buffer });
  let text = '';
  try {
    const parsed = await parser.getText();
    text = (parsed.text || '').trim();
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  let method = 'text';
  let songs =
    text.length >= 10 && !isThinPdfText(text)
      ? extractSongsFromText(text)
      : [];

  // 페이지 마커만 있거나 잡음 제목만 있으면 OCR 강제
  songs = songs.filter((s) => !isPageMarker(s.title) && !isJunkTitle(s.title));

  const needsOcr =
    isThinPdfText(text) ||
    songs.length === 0 ||
    songs.every((s) => s.confidence < 0.7) ||
    (isJunkFileName(fileName) && songs.length === 0);

  if (needsOcr) {
    try {
      console.log('[analyze] OCR 시작…');
      const ocrText = await ocrPdfPages(buffer);
      if (ocrText && ocrText.trim().length > 20) {
        text = `${text}\n${ocrText}`;
        songs = extractSongsFromText(text).filter(
          (s) => !isPageMarker(s.title) && !isJunkTitle(s.title),
        );
        method = 'ocr';
        console.log(`[analyze] OCR 완료 · 후보 ${songs.length}곡`);
      }
    } catch (err) {
      console.warn('[analyze] OCR 실패:', err.message);
    }
  }

  // 파일명을 곡으로 쓰지 않음 (Adobe Scan 2026. 7. 17. 등)
  songs = songs.filter((s) => !isJunkFileName(s.title) && !isPageMarker(s.title));

  if (songs.length === 0) {
    return {
      fileName,
      method: method === 'ocr' ? 'ocr' : 'heuristic',
      rawTextPreview: text.slice(0, 400),
      note: '곡 제목을 자동으로 찾지 못했습니다. 직접 추가해 주세요.',
      songs: [],
    };
  }

  // 찬송가/CCM이면 YouTube 검색에 도움이 되도록 표시
  const hymnal = songs.some((s) =>
    Boolean(s.number || /찬송|은혜|하나님|예수|예배|푯대|교회/.test(s.title)),
  );
  return {
    fileName,
    method: hymnal && method === 'text' ? 'hymn' : method,
    rawTextPreview: text.slice(0, 400),
    songs,
  };
}

function getDemoResult(fileName = 'demo-score.pdf') {
  return {
    fileName,
    method: 'demo',
    songs: DEMO_SONGS.map((s) => ({
      id: randomUUID(),
      ...s,
      confidence: 0.95,
      selected: true,
    })),
  };
}

module.exports = {
  analyzePdfBuffer,
  getDemoResult,
  extractSongsFromText,
};
