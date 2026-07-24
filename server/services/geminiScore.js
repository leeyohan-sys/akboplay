/**
 * Gemini API로 악보 PDF(스캔 이미지)에서 곡 제목을 추출합니다.
 * 키: GEMINI_API_KEY 환경변수 (코드에 하드코딩하지 않음)
 */
const { randomUUID } = require('crypto');
const { PDFParse } = require('pdf-parse');
const { isJunkTitle, isPageMarker } = require('./hymnParser');
const { normalizeMusicKey } = require('./musicKey');

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
        .filter(
          (s) => s.title && !isJunkTitle(s.title) && !isPageMarker(s.title),
        );
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
    .filter((t) => t && !isJunkTitle(t) && !isPageMarker(t))
    .map((title) => ({
      title,
      composer: undefined,
      number: undefined,
      key: undefined,
    }));
}

/** PDF 앞 페이지를 JPEG로 렌더 (토큰/쿼터 절약) */
async function pdfPagesToJpegs(buffer, { first = 3, scale = 1.25 } = {}) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [];
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const shot = await parser.getScreenshot({
      first,
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

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const apiKey = process.env.GEMINI_API_KEY.trim();
  const genAI = new GoogleGenerativeAI(apiKey);

  // 사용 가능한 모델 우선순위 (쿼터/지역에 따라 다를 수 있음)
  const modelNames = [
    'gemini-flash-latest',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.5-flash',
  ];

  const images = await pdfPagesToJpegs(buffer, { first: 3, scale: 1.25 });
  if (images.length === 0) {
    console.warn('[gemini] PDF 페이지 이미지 생성 실패');
    return null;
  }

  const prompt = `교회 찬양/악보 PDF 이미지입니다. 곡 제목·조성(Key)·찬송가 번호를 JSON 배열로 추출하세요.
파일: ${fileName || 'score.pdf'}
규칙:
- 곡 제목만. 가사 한 줄·코드나열·페이지번호·"보통으로"·"후렴"은 제외.
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

  let lastError = null;
  for (const modelName of modelNames) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        });

        console.log(
          `[gemini] 요청 · model=${modelName} · pages=${images.length} · try=${attempt + 1}`,
        );
        const result = await Promise.race([
          model.generateContent({ contents: [{ role: 'user', parts }] }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('gemini-timeout')), 40000),
          ),
        ]);

        const rawText = result?.response?.text?.() || '';
        const parsed = parseJsonSongs(rawText);
        if (parsed.length === 0) {
          console.warn('[gemini] 파싱 실패:', rawText.slice(0, 240));
          break; // 다음 모델
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

        console.log(`[gemini] ${songs.length}곡 인식 · ${modelName}`);
        return { songs, rawText };
      } catch (err) {
        lastError = err;
        const msg = String(err.message || err);
        console.warn(`[gemini] ${modelName} 실패:`, msg.slice(0, 180));
        if (/429|quota|rate/i.test(msg) && attempt === 0) {
          await sleep(3000);
          continue;
        }
        break;
      }
    }
  }

  if (lastError) {
    console.warn('[gemini] 최종 실패:', String(lastError.message || lastError).slice(0, 200));
  }
  return null;
}

module.exports = {
  isConfigured,
  extractSongsWithGemini,
};
