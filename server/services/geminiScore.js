/**
 * Gemini API로 악보 PDF(스캔 이미지)에서 곡 제목을 추출합니다.
 * 키: GEMINI_API_KEY 환경변수 (코드에 하드코딩하지 않음)
 */
const { createHash, randomUUID } = require('crypto');
const { PDFParse } = require('pdf-parse');
const { isPageMarker } = require('./hymnParser');
const { normalizeMusicKey } = require('./musicKey');
const { isConfigured, generateContent } = require('./geminiClient');

/** 동일 PDF 재요청 시 API 호출 생략 */
const pdfResultCache = new Map();
const PDF_CACHE_MAX = 20;

/** Gemini가 준 제목은 junk 필터 없이 수용 (페이지 마커·빈 제목만 제외) */
function acceptGeminiTitle(title) {
  const t = String(title || '').trim();
  return Boolean(t) && !isPageMarker(t);
}

function bufferHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function cacheGet(key) {
  const hit = pdfResultCache.get(key);
  if (!hit) return null;
  // LRU 비슷하게 재삽입
  pdfResultCache.delete(key);
  pdfResultCache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  if (pdfResultCache.has(key)) pdfResultCache.delete(key);
  pdfResultCache.set(key, value);
  while (pdfResultCache.size > PDF_CACHE_MAX) {
    const oldest = pdfResultCache.keys().next().value;
    pdfResultCache.delete(oldest);
  }
}

function parseJsonSongs(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();

  const tryParse = (jsonText) => {
    try {
      const arr = JSON.parse(jsonText);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((item) => {
          if (typeof item === 'string') {
            return {
              title: item.trim(),
              composer: undefined,
              number: undefined,
              key: undefined,
            };
          }
          return {
            title: String(item?.title || '')
              .replace(/\s*\([^)]*입례[^)]*\)\s*$/g, '')
              .replace(/\s+/g, ' ')
              .trim(),
            composer: item?.composer ? String(item.composer).trim() : undefined,
            number: item?.number ? String(item.number).trim() : undefined,
            key: normalizeMusicKey(item?.key || item?.musicKey || ''),
          };
        })
        .filter((s) => acceptGeminiTitle(s.title));
    } catch {
      return [];
    }
  };

  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const parsed = tryParse(body.slice(start, end + 1));
    if (parsed.length) return parsed;
  }

  // JSON이 중간에 잘린 경우 title 필드만이라도 회수
  const titles = [...text.matchAll(/"title"\s*:\s*"([^"\\]+)"/g)].map(
    (m) => m[1].trim(),
  );
  return titles
    .filter((t) => acceptGeminiTitle(t))
    .map((title) => ({
      title,
      composer: undefined,
      number: undefined,
      key: undefined,
    }));
}

/** PDF 전체 페이지를 JPEG로 렌더 (페이지 수 제한 없음) */
async function pdfPagesToJpegs(buffer, { scale = 1.25 } = {}) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [];
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo().catch(() => null);
    const total = Math.max(1, Number(info?.total) || 1);

    const shot = await parser.getScreenshot({
      // 전체 페이지 — first에 총 페이지 수를 넣어 제한 없이 렌더
      first: total,
      scale,
      imageBuffer: true,
      imageDataUrl: false,
    });

    const images = [];
    for (const page of shot.pages || []) {
      const jpg = await sharp(Buffer.from(page.data))
        .resize({ width: 1024, withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer();
      images.push(jpg);
    }
    return images;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Gemini로 곡 목록 추출
 * @returns {Promise<null | { songs: object[], rawText: string }>}
 */
async function extractSongsWithGemini(buffer, fileName) {
  if (!isConfigured()) return null;

  const hash = bufferHash(buffer);
  const cached = cacheGet(hash);
  if (cached?.songs?.length) {
    console.log(`[gemini] 캐시 히트 · ${cached.songs.length}곡`);
    return {
      songs: cached.songs.map((s) => ({ ...s, id: randomUUID() })),
      rawText: cached.rawText,
    };
  }

  // 페이지 수 제한 없이 전체 페이지를 Gemini에 전달
  const images = await pdfPagesToJpegs(buffer, { scale: 1.25 });
  if (images.length === 0) {
    console.warn('[gemini] PDF 페이지 이미지 생성 실패');
    return null;
  }

  const prompt = `교회 찬양/악보 PDF 이미지입니다. 첨부된 **모든 페이지**를 보고 곡 제목·조성(Key)·찬송가 번호를 JSON 배열로 추출하세요.
파일: ${fileName || 'score.pdf'}
규칙:
- 페이지를 빠짐없이 확인하세요. 앞쪽뿐 아니라 마지막 페이지 곡도 포함하세요.
- 곡 제목만. 가사 한 줄·코드나열·페이지번호·"보통으로"·"후렴"은 제외.
- 보이는 곡은 모두 넣고, 추측으로 없는 곡을 만들지 마세요.
- 찬송가 번호(예: 452, 449, 144)가 보이면 number에 넣으세요.
- 영문 원제(Near the Cross, Trust and Obey 등)가 보이면 한국어 정식 제목으로 바꾸세요.
- key는 조성 (G, C, Bb, Em). Capo 숫자만 있으면 "".
- composer/number/key 없으면 "".
출력 예: [{"title":"곡명","composer":"","number":"452","key":"G"}]
설명 없이 JSON만.`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: {
        mimeType: 'image/jpeg',
        data: img.toString('base64'),
      },
    })),
  ];

  // 페이지가 많을수록 여유 시간 부여 (최대 2분)
  const timeoutMs = Math.min(120000, 35000 + images.length * 12000);

  console.log(`[gemini] 인식 준비 · pages=${images.length}`);
  const response = await generateContent({
    contents: parts,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
    },
    timeoutMs,
    label: 'gemini',
  });

  if (!response?.text) return null;

  const rawText = response.text;
  const parsed = parseJsonSongs(rawText);
  if (parsed.length === 0) {
    console.warn('[gemini] 파싱 실패:', rawText.slice(0, 240));
    return null;
  }

  const songs = parsed.map((s) => ({
    id: randomUUID(),
    title: s.title,
    composer: s.composer || undefined,
    number: s.number || undefined,
    key: s.key || undefined,
    confidence: 0.94,
    selected: true,
  }));

  console.log(`[gemini] ${songs.length}곡 인식 · ${response.model}`);
  cacheSet(hash, { songs, rawText });
  return { songs, rawText };
}

module.exports = {
  isConfigured,
  extractSongsWithGemini,
};
