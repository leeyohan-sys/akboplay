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
const {
  remapScoreToKeyPosition,
  positionPromptBlock,
  getPositionForKey,
} = require('./tabPositions');

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
      .map((ev) => {
        const string = Number(ev.string ?? ev.s);
        const fret = Number(ev.fret ?? ev.f);
        const beat = Math.max(0, Number(ev.beat ?? ev.b) || 0);
        const pitch = ev.pitch ?? ev.note ?? ev.n ?? ev.midi;
        const out = { beat };
        if (Number.isFinite(string) && string >= 1) {
          out.string = Math.max(1, Math.min(6, string));
        }
        if (Number.isFinite(fret) && fret >= 0) {
          out.fret = Math.max(0, Math.min(24, fret));
        }
        if (pitch != null && pitch !== '') out.pitch = pitch;
        // string/fret 또는 pitch 중 하나는 있어야 함
        if (out.string == null && out.pitch == null) return null;
        if (out.fret == null && out.pitch == null) out.fret = 0;
        if (out.string == null) out.string = 1;
        if (out.fret == null) out.fret = 0;
        return out;
      })
      .filter(Boolean);
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
    positionLabel: score.positionLabel || undefined,
    asciiTab,
    svg,
    pngBase64: png.toString('base64'),
    pdfBase64: pdf.toString('base64'),
    mimePng: 'image/png',
    mimePdf: 'application/pdf',
  };
}

function cacheDelete(key) {
  cache.delete(key);
}

async function finalizeScore(score, { model, method, fromCache }) {
  const remapped = remapScoreToKeyPosition(score);
  const pos = getPositionForKey(remapped.key);
  console.log(
    `[tab] 포지션 ${pos.label} · key=${remapped.key} · measures=${remapped.measures.length}${fromCache ? ' · fromCache' : ''}`,
  );

  const out = await scoreToOutputs(remapped);
  out.method = method || 'gemini';
  if (model) out.model = model;
  out.cached = Boolean(fromCache);
  if (remapped.partial) {
    out.note = `응답이 중간에 잘려 ${out.measureCount}마디만 복구 · ${pos.label}`;
  } else if (out.measureCount < 12) {
    out.note = `${out.measureCount}마디 인식 · ${pos.label}`;
  } else {
    out.note = pos.label;
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string} [mime]
 * @param {{ force?: boolean }} [opts] force=true 이면 Gemini까지 재호출
 */
async function convertScoreToTab(buffer, fileName, mime, opts = {}) {
  // v5: 원본 스코어만 캐시 → 매번 포지션 운지 재적용
  const hash = bufferHash(buffer) + ':v5-raw';
  const force = Boolean(opts.force);

  if (force) {
    cacheDelete(hash);
    console.log('[tab] 강제 재변환 · 캐시 삭제');
  } else {
    const cached = cacheGet(hash);
    // rawScore가 있으면 Gemini 생략, 운지만 최신 로직으로 다시 그림
    if (cached?.rawScore?.measures?.length) {
      console.log('[tab] 원본 캐시 히트 · 포지션 재렌더');
      return finalizeScore(cached.rawScore, {
        model: cached.model,
        method: cached.method || 'gemini',
        fromCache: true,
      });
    }
  }

  if (!isConfigured()) {
    console.warn('[tab] GEMINI_API_KEY 없음 → 데모 탭');
    const out = await finalizeScore(demoScore(), {
      method: 'demo',
      fromCache: false,
    });
    out.note =
      'Gemini API 키가 없어 데모 탭을 표시합니다. 서버에 GEMINI_API_KEY를 설정하면 실제 악보를 변환합니다.';
    return out;
  }

  const images = await toJpegPages(buffer, mime, fileName);
  if (!images.length) {
    throw new Error('이미지/PDF를 읽지 못했습니다. 다른 파일을 시도해 주세요.');
  }

  const prompt = `당신은 기타 편곡가입니다. 첨부된 악보 이미지의 **모든 마디** 멜로디를 읽고 JSON으로 주세요.
파일: ${fileName || 'score'}

${positionPromptBlock()}

필수:
- 오선 **멜로디만**. 빨간 코드 심볼은 조성 파악 참고용.
- key 필드는 반드시 악보 조성 (예: E, G, C, Am).
- 각 음에 음높이 pitch n(예:"E4","G#4","C5")와 beat를 넣고, 가능하면 위 포지션의 s·f도 함께.
- beat: 마디 안 박(0부터). 8분음=0.5.
- **마지막 마디까지 전부**. 픽업은 measures[0]. 반복은 펼치지 말고 적힌 순서대로.
- 최대 ${MAX_MEASURES}마디. 없는 음 창작 금지.

JSON만:
{"title":"곡명","composer":"","key":"E","tempo":72,"timeSignature":"4/4","measureCount":18,"measures":[{"events":[{"n":"B3","b":0,"s":3,"f":9},{"n":"E4","b":0.5,"s":2,"f":9}]}]}
- n=pitch, b=beat, s=string(1=고음e), f=fret`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: { mimeType: 'image/jpeg', data: img.toString('base64') },
    })),
  ];

  const timeoutMs = Math.min(150000, 50000 + images.length * 20000);
  console.log(`[tab] Gemini 변환 · pages=${images.length} · force=${force}`);

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

  // 원본(리맵 전)만 캐시 — 다음 요청에서 최신 포지션 로직 적용
  cacheSet(hash, {
    rawScore: score,
    model: response.model,
    method: 'gemini',
  });

  const out = await finalizeScore(score, {
    model: response.model,
    method: 'gemini',
    fromCache: false,
  });
  console.log(
    `[tab] 완료 · measures=${out.measureCount} · model=${response.model} · force=${force}`,
  );
  return out;
}

module.exports = {
  convertScoreToTab,
  isConfigured,
  MAX_MEASURES,
};
