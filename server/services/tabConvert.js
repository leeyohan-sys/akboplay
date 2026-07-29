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
/** 한 곡에서 허용하는 최대 마디 수 (픽업 포함) */
const MAX_MEASURES = 48;

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
    /pdf/i.test(mime || '') ||
    /\.pdf$/i.test(fileName || '') ||
    buffer.slice(0, 4).toString() === '%PDF';

  if (isPdf) {
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo().catch(() => null);
      const total = Math.min(8, Math.max(1, Number(info?.total) || 1));
      const shot = await parser.getScreenshot({
        first: total,
        scale: 1.6,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const images = [];
      for (const page of shot.pages || []) {
        const jpg = await sharp(Buffer.from(page.data))
          .resize({ width: 1800, withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        images.push(jpg);
      }
      return images;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  // 이미지: 작은 음표·18마디 전체를 위해 고해상도 유지
  const jpg = await sharp(buffer)
    .rotate()
    .resize({ width: 1800, withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return [jpg];
}

function parseTabJson(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    // 잘린 JSON에서 measures 배열만이라도 복구
    return recoverPartialScore(body);
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return recoverPartialScore(body);
  }
}

/** 응답이 잘려도 완성된 measure 객체는 최대한 살림 */
function recoverPartialScore(text) {
  const measures = [];
  const re = /\{\s*"events"\s*:\s*\[([\s\S]*?)\]\s*\}/g;
  let m;
  while ((m = re.exec(text)) && measures.length < MAX_MEASURES) {
    try {
      const events = JSON.parse(`[${m[1]}]`);
      if (Array.isArray(events)) measures.push({ events });
    } catch {
      // 이벤트 조각이 깨진 마디는 건너뜀
    }
  }
  if (!measures.length) return null;

  const titleMatch = text.match(/"title"\s*:\s*"([^"\\]*)"/);
  const keyMatch = text.match(/"key"\s*:\s*"([^"\\]*)"/);
  const composerMatch = text.match(/"composer"\s*:\s*"([^"\\]*)"/);
  return {
    title: titleMatch?.[1] || 'Guitar Tab',
    composer: composerMatch?.[1] || '',
    key: keyMatch?.[1] || '',
    timeSignature: '4/4',
    measures,
    partial: true,
  };
}

function normalizeScore(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const measuresIn = Array.isArray(parsed.measures)
    ? parsed.measures
    : Array.isArray(parsed.bars)
      ? parsed.bars
      : [];

  const measures = measuresIn.slice(0, MAX_MEASURES).map((m) => {
    const eventsIn = Array.isArray(m?.events)
      ? m.events
      : Array.isArray(m?.notes)
        ? m.notes
        : [];
    const events = eventsIn
      .map((ev) => ({
        string: Math.max(1, Math.min(6, Number(ev.string ?? ev.s) || 1)),
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
    timeSignature: String(parsed.timeSignature || parsed.meter || '4/4').slice(
      0,
      8,
    ),
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'],
    measures,
    partial: Boolean(parsed.partial),
  };
}

async function scoreToOutputs(score) {
  const svg = buildTabSvg(score);
  const asciiTab = buildAsciiTab(score);
  const png = await svgToPng(svg);
  const pdf = await pngToPdf(png);
  const measureCount = score.measures?.length || 0;
  return {
    title: score.title,
    composer: score.composer || undefined,
    key: score.key || undefined,
    tempo: score.tempo || undefined,
    timeSignature: score.timeSignature,
    measureCount,
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
  const hash = bufferHash(buffer) + ':v2-full';
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

  // 멜로디만·짧은 키로 토큰을 아껴 18~40마디까지 수용
  const prompt = `당신은 기타 편곡가입니다. 첨부된 악보 이미지의 **모든 마디**를 기타 TAB JSON으로 변환하세요.
파일: ${fileName || 'score'}

필수:
- 오선의 **멜로디(보컬 라인)** 만 TAB으로. 코드(E, A, B7 등 빨간 글씨)는 참고만 하고 화음 스택은 넣지 마세요.
- 표준 튜닝. string: 1=고음 e … 6=저음 E.
- beat: 마디 안 박(0부터). 8분음=0.5.
- **마지막 마디·더블바까지 전부** 포함. 픽업(약박)이 있으면 첫 measures[0]에 넣으세요.
- 마디 번호(1,4,7,11,15…)가 보이면 그 순서대로, 보통 15~24마디 분량입니다. **중간에 끊지 마세요.**
- 1·2번 엔딩/도돌이표가 있어도 **악보에 적힌 마디를 순서대로** 모두 넣고, 반복 연주는 펼치지 마세요.
- 쉼표 구간은 events를 비우거나 건너뛰세요. 없는 음을 만들지 마세요.
- 최대 ${MAX_MEASURES}마디.

짧은 키만 사용 (토큰 절약):
{"title":"곡명","composer":"","key":"E","tempo":72,"timeSignature":"4/4","measureCount":18,"measures":[{"events":[{"s":1,"f":0,"b":0},{"s":1,"f":2,"b":0.5}]}]}
- s=string, f=fret, b=beat
- measureCount에는 실제 넣은 마디 수를 적으세요.
설명 없이 JSON만.`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: { mimeType: 'image/jpeg', data: img.toString('base64') },
    })),
  ];

  const timeoutMs = Math.min(150000, 50000 + images.length * 20000);
  console.log(`[tab] Gemini 변환 · pages=${images.length}`);

  const response = await generateContent({
    contents: parts,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16384,
    },
    timeoutMs,
    deadlineMs: 140000,
    throwOnRateLimit: true,
    label: 'tab',
  });

  if (!response?.text) {
    throw new Error('탭 변환 응답이 비었습니다. 잠시 후 다시 시도해 주세요.');
  }

  const parsed = parseTabJson(response.text);
  let score = normalizeScore(parsed);
  if (!score) {
    console.warn(
      '[tab] JSON 파싱 실패, 데모로 폴백:',
      response.text.slice(0, 200),
    );
    score = demoScore();
    score.title = '변환 부분 실패 · 샘플 탭';
  }

  const out = await scoreToOutputs(score);
  out.method = 'gemini';
  out.model = response.model;
  if (score.partial) {
    out.note = `응답이 중간에 잘려 ${out.measureCount}마디만 복구했습니다. 다시 시도하면 더 많이 나올 수 있습니다.`;
  } else if (out.measureCount < 12) {
    out.note = `${out.measureCount}마디만 인식되었습니다. 악보가 더 길면 다시 변환해 보세요.`;
  }
  console.log(
    `[tab] 완료 · measures=${out.measureCount} · model=${response.model}`,
  );
  cacheSet(hash, out);
  return out;
}

module.exports = {
  convertScoreToTab,
  isConfigured,
  MAX_MEASURES,
};
