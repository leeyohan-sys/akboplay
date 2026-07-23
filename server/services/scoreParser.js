/**
 * 악보 PDF에서 곡 제목/작곡가 후보를 추출합니다.
 * - 텍스트 PDF: pdf-parse + 찬송가 지문
 * - 스캔본: Gemini(우선) → Tesseract OCR 폴백
 */
const { PDFParse } = require('pdf-parse');
const { randomUUID } = require('crypto');
const {
  extractHymnsFromText,
  completeKnownWorshipSets,
  isJunkFileName,
  isJunkTitle,
  isPageMarker,
  isThinPdfText,
} = require('./hymnParser');
const {
  isConfigured: isGeminiConfigured,
  extractSongsWithGemini,
} = require('./geminiScore');

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

/** 페이지 이미지를 OCR (스캔본 보강) — Render 무료 플랜 한도 내로 가볍게 */
async function ocrPdfPages(buffer, options = {}) {
  const maxMs = options.maxMs ?? 35000;
  const started = Date.now();
  const timedOut = () => Date.now() - started > maxMs;

  let sharp;
  let Tesseract;
  try {
    sharp = require('sharp');
    Tesseract = require('tesseract.js');
  } catch {
    return '';
  }

  const parser = new PDFParse({ data: buffer });
  let worker;
  try {
    const shot = await parser.getScreenshot({
      first: 3,
      scale: 1.5,
      imageBuffer: true,
      imageDataUrl: false,
    });

    worker = await Tesseract.createWorker('kor+eng', 1, {
      logger: () => undefined,
    });

    const chunks = [];
    for (const page of shot.pages || []) {
      if (timedOut()) {
        console.warn('[analyze] OCR 시간 제한 — 부분 결과 사용');
        break;
      }

      const img = Buffer.from(page.data);
      const meta = await sharp(img).metadata();
      const h = meta.height || 0;
      const w = meta.width || 0;
      if (!h || !w) continue;

      const landscape = w > h;
      // 제목은 보통 상단(가로면 좌·우 각각)에만 있음 — 전체 페이지 OCR은 하지 않음
      const regions = landscape
        ? [
            {
              left: 0,
              top: 0,
              width: Math.floor(w * 0.52),
              height: Math.floor(h * 0.3),
            },
            {
              left: Math.floor(w * 0.48),
              top: 0,
              width: Math.floor(w * 0.52),
              height: Math.floor(h * 0.3),
            },
          ]
        : [
            { left: 0, top: 0, width: w, height: Math.floor(h * 0.24) },
            {
              left: 0,
              top: Math.floor(h * 0.42),
              width: w,
              height: Math.floor(h * 0.22),
            },
          ];

      for (const region of regions) {
        if (timedOut()) break;
        try {
          const crop = await sharp(img)
            .extract(region)
            .resize({ width: 900, withoutEnlargement: false })
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
          const result = await worker.recognize(crop);
          if (result?.data?.text) chunks.push(result.data.text);
        } catch {
          // 개별 영역 실패는 무시
        }
      }

      // 시간 여유 있으면 다음 페이지도 계속 (Render 한도 내)
    }
    return chunks.join('\n');
  } finally {
    if (worker) await worker.terminate().catch(() => undefined);
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

  // 페이지 마커만 있거나 곡이 부족하면 Gemini → OCR
  songs = songs.filter((s) => !isPageMarker(s.title) && !isJunkTitle(s.title));

  const needsVision =
    isThinPdfText(text) ||
    songs.length === 0 ||
    songs.every((s) => s.confidence < 0.7) ||
    (isJunkFileName(fileName) && songs.length === 0);

  if (needsVision) {
    // 1) Gemini (키가 있으면 OCR보다 우선 — 스캔 악보에 강함)
    if (isGeminiConfigured()) {
      try {
        console.log('[analyze] Gemini 인식 시작…');
        const gemini = await extractSongsWithGemini(buffer, fileName);
        if (gemini?.songs?.length) {
          songs = gemini.songs.filter(
            (s) => !isPageMarker(s.title) && !isJunkTitle(s.title),
          );
          text = `${text}\n${gemini.rawText || ''}`;
          method = 'gemini';
          console.log(`[analyze] Gemini 완료 · 후보 ${songs.length}곡`);
        }
      } catch (err) {
        console.warn('[analyze] Gemini 실패:', err.message);
      }
    }

    // 2) Gemini가 비었으면 Tesseract OCR 폴백
    if (songs.length === 0) {
      try {
        console.log('[analyze] OCR 시작…');
        const ocrText = await ocrPdfPages(buffer, { maxMs: 35000 });
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
  }

  // 파일명을 곡으로 쓰지 않음 (Adobe Scan 2026. 7. 17. 등)
  songs = songs.filter(
    (s) => !isJunkFileName(s.title) && !isPageMarker(s.title),
  );

  // 알려진 찬양 세트(헌신예배 등)는 OCR이 일부만 잡아도 보완
  songs = completeKnownWorshipSets(songs, fileName, text);

  // 제목 정규화 후 중복 제거 (예: "예배하는 자 되어 (입례)")
  songs = songs.map((s) => ({
    ...s,
    title: String(s.title || '')
      .replace(/\s*\([^)]*입례[^)]*\)\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
  const seen = new Set();
  songs = songs.filter((s) => {
    const key = s.title.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (songs.length === 0) {
    return {
      fileName,
      method: method === 'ocr' ? 'ocr' : 'heuristic',
      rawTextPreview: text.slice(0, 400),
      note: '곡 제목을 자동으로 찾지 못했습니다. 아래에서 직접 추가해 주세요.',
      songs: [],
    };
  }

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
