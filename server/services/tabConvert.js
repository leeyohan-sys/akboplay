/**
 * 악보 이미지/PDF → 기타 TAB 변환 (Gemini Vision)
 * Soundslice / Flat 스타일: 표준 튜닝 6선 탭으로 재구성
 */
const { createHash } = require('crypto');
const { PDFParse } = require('pdf-parse');
const { isConfigured, generateContent } = require('./geminiClient');
const {
  buildTabSvg,
  buildAsciiTab,
  svgToPng,
  pngToPdf,
  demoScore,
} = require('./tabRender');

const cache = new Map();
const CACHE_MAX = 12;

function bufferHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function toJpegPages(buffer, mime, fileName) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [];
  }

  const isPdf =
    /pdf/i.test(mime || '') || /\.pdf$/i.test(fileName || '') || buffer.slice(0, 4).toString() === '%PDF';

  if (isPdf) {
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo().catch(() => null);
      const total = Math.min(6, Math.max(1, Number(info?.total) || 1));
      const shot = await parser.getScreenshot({
        first: total,
        scale: 1.4,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const images = [];
      for (const page of shot.pages || []) {
        const jpg = await sharp(Buffer.from(page.data))
          .resize({ width: 1280, withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toBuffer();
        images.push(jpg);
      }
      return images;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  // 이미지
  const jpg = await sharp(buffer)
    .rotate()
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return [jpg];
}

function parseTabJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeScore(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const measuresIn = Array.isArray(parsed.measures)
    ? parsed.measures
    : Array.isArray(parsed.bars)
      ? parsed.bars
      : [];

  const measures = measuresIn.slice(0, 32).map((m) => {
    const eventsIn = Array.isArray(m?.events)
      ? m.events
      : Array.isArray(m?.notes)
        ? m.notes
        : [];
    const events = eventsIn
      .map((ev) => ({
        string: Math.max(1, Math.min(6, Number(ev.string) || 1)),
        fret: Math.max(0, Math.min(24, Number(ev.fret ?? ev.f) || 0)),
        beat: Math.max(0, Number(ev.beat ?? ev.b) || 0),
      }))
      .filter((ev) => Number.isFinite(ev.fret));
    return { events };
  });

  if (measures.every((m) => m.events.length === 0)) return null;

  return {
    title: String(parsed.title || 'Guitar Tab').slice(0, 80),
    composer: parsed.composer ? String(parsed.composer).slice(0, 60) : '',
    key: parsed.key ? String(parsed.key).slice(0, 12) : '',
    tempo: parsed.tempo ? Number(parsed.tempo) : undefined,
    timeSignature: String(parsed.timeSignature || parsed.meter || '4/4').slice(0, 8),
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'],
    measures,
  };
}

async function scoreToOutputs(score) {
  const svg = buildTabSvg(score);
  const asciiTab = buildAsciiTab(score);
  const png = await svgToPng(svg);
  const pdf = await pngToPdf(png);
  return {
    title: score.title,
    composer: score.composer || undefined,
    key: score.key || undefined,
    tempo: score.tempo || undefined,
    timeSignature: score.timeSignature,
    asciiTab,
    svg,
    pngBase64: png.toString('base64'),
    pdfBase64: pdf.toString('base64'),
    mimePng: 'image/png',
    mimePdf: 'application/pdf',
  };
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string} [mime]
 */
async function convertScoreToTab(buffer, fileName, mime) {
  const hash = bufferHash(buffer);
  const cached = cacheGet(hash);
  if (cached) {
    console.log('[tab] 캐시 히트');
    return { ...cached, cached: true };
  }

  if (!isConfigured()) {
    console.warn('[tab] GEMINI_API_KEY 없음 → 데모 탭');
    const out = await scoreToOutputs(demoScore());
    out.method = 'demo';
    out.note =
      'Gemini API 키가 없어 데모 탭을 표시합니다. 서버에 GEMINI_API_KEY를 설정하면 실제 악보를 변환합니다.';
    return out;
  }

  const images = await toJpegPages(buffer, mime, fileName);
  if (!images.length) {
    throw new Error('이미지/PDF를 읽지 못했습니다. 다른 파일을 시도해 주세요.');
  }

  const prompt = `당신은 기타 편곡가입니다. 첨부된 악보(오선보·코드·멜로디)를 **기타 타블라처(TAB)** 로 변환하세요.
파일: ${fileName || 'score'}

규칙:
- 표준 튜닝 (E A D G B E). string: 1=고음 e현(탭 맨 위), 6=저음 E현(맨 아래).
- 멜로디/테마를 우선. 화음이면 동시에 여러 string 이벤트를 같은 beat에 넣으세요.
- beat는 마디 안 박자 위치(0부터, 4/4면 0~3.75). 8분음=0.5 단위 권장.
- 최대 16마디. 보이면 있는 음만, 없는 음을 지어내지 마세요.
- 읽을 수 없으면 빈 measures [].

반드시 JSON만:
{
  "title":"곡명",
  "composer":"",
  "key":"G",
  "tempo":90,
  "timeSignature":"4/4",
  "measures":[
    {"events":[{"string":1,"fret":3,"beat":0},{"string":2,"fret":0,"beat":1}]}
  ]
}`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: { mimeType: 'image/jpeg', data: img.toString('base64') },
    })),
  ];

  const timeoutMs = Math.min(120000, 40000 + images.length * 15000);
  console.log(`[tab] Gemini 변환 · pages=${images.length}`);

  const response = await generateContent({
    contents: parts,
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 8192,
    },
    timeoutMs,
    deadlineMs: 100000,
    throwOnRateLimit: true,
    label: 'tab',
  });

  if (!response?.text) {
    throw new Error('탭 변환 응답이 비었습니다. 잠시 후 다시 시도해 주세요.');
  }

  const parsed = parseTabJson(response.text);
  let score = normalizeScore(parsed);
  if (!score) {
    console.warn('[tab] JSON 파싱 실패, 데모로 폴백:', response.text.slice(0, 200));
    score = demoScore();
    score.title = '변환 부분 실패 · 샘플 탭';
  }

  const out = await scoreToOutputs(score);
  out.method = 'gemini';
  out.model = response.model;
  cacheSet(hash, out);
  return out;
}

module.exports = {
  convertScoreToTab,
  isConfigured,
};
