/**
 * 악보 이미지/PDF → 멜로디+알토 화성 2성부 LilyPond(.ly) 생성
 */
const { PDFParse } = require('pdf-parse');
const { generateContent, isConfigured } = require('./geminiClient');

/** PDF → JPEG 페이지들 */
async function pdfToJpegs(buffer, { first = 8, scale = 1.4 } = {}) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [];
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo().catch(() => null);
    const total = Math.min(first, Math.max(1, Number(info?.total) || first));
    const shot = await parser.getScreenshot({
      first: total,
      scale,
      imageBuffer: true,
      imageDataUrl: false,
    });

    const images = [];
    for (const page of shot.pages || []) {
      const jpg = await sharp(Buffer.from(page.data))
        .resize({ width: 1400, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      images.push(jpg);
    }
    return images;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** 업로드 버퍼를 Gemini용 JPEG 목록으로 */
async function bufferToImages(buffer, mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  const isPdf =
    mime.includes('pdf') ||
    name.endsWith('.pdf') ||
    buffer.slice(0, 5).toString() === '%PDF-';

  if (isPdf) {
    return pdfToJpegs(buffer);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [buffer];
  }

  try {
    const jpg = await sharp(buffer)
      .rotate()
      .resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return [jpg];
  } catch (err) {
    console.warn('[alto] 이미지 변환 실패, 원본 전송:', err.message);
    return [buffer];
  }
}

/** 마크다운/설명 섞인 응답에서 LilyPond 본문만 추출 */
function extractLilypond(raw) {
  let text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!text) return '';

  // 코드펜스 (언어 태그 유무·미닫힘 모두)
  const fenceRe =
    /```(?:lilypond|lily|ly)?\s*\r?\n?([\s\S]*?)(?:```|$)/gi;
  let best = '';
  for (const m of text.matchAll(fenceRe)) {
    const body = String(m[1] || '').trim();
    if (body.length > best.length) best = body;
  }
  if (best) text = best;

  // HTML <pre> 등
  const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (pre?.[1] && /\\version|\\relative|\\score/.test(pre[1])) {
    text = pre[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  // \version 지점부터
  const ver = text.search(/\\version\b/);
  if (ver >= 0) text = text.slice(ver);

  // 앞쪽 설명 문장 제거: 첫 LilyPond 토큰부터
  if (!/\\version\b/.test(text)) {
    const token = text.search(/\\(?:header|score|relative|new|key|time|clef)\b/);
    if (token >= 0) text = text.slice(token);
  }

  return text.trim();
}

function looksLikeLilypond(code) {
  const c = String(code || '');
  if (c.length < 20) return false;

  // 실제 음표/성부 내용이 있어야 함 (\header+\version만으로는 거부)
  const hasMusic =
    /\\relative\b/.test(c) ||
    /\\score\b/.test(c) ||
    /\\new\s+(?:Choir)?Staff\b/.test(c) ||
    /<<[\s\S]*>>/.test(c) ||
    /\b[a-g](?:is|es)?['`,]*\d/.test(c); // c4, gis'8 등

  if (!hasMusic) return false;

  // 헤더/조성 등 보조 토큰 포함해 2개 이상이면 통과
  const hits = [
    /\\version\b/,
    /\\relative\b/,
    /\\score\b/,
    /\\new\s+(?:Choir)?Staff\b/,
    /\\header\b/,
    /\\key\b/,
    /<<[\s\S]*>>/,
  ].filter((re) => re.test(c)).length;

  return hits >= 2 || (/\\version\b/.test(c) && hasMusic);
}

/** 최소한의 헤더를 붙여 유효 .ly 로 복구 */
function repairLilypond(code, fileName) {
  let c = String(code || '').trim();
  if (!c) return c;

  // LilyPond 토큰이 전혀 없으면 복구하지 않음 (사과/설명 문구 방지)
  if (
    !/\\(?:version|relative|score|header|new|key|time|clef)\b/.test(c) &&
    !/<<[\s\S]*>>/.test(c) &&
    !/\b[a-g](?:is|es)?['`,]*\d/.test(c)
  ) {
    return c;
  }

  // 스마트쿼트 등 정리
  c = c
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  if (!/\\version\b/.test(c)) {
    c = `\\version "2.24.0"\n\n${c}`;
  }
  if (!/\\score\b/.test(c) && /\\relative\b/.test(c)) {
    // relative만 있으면 score 래퍼 추가
    c += `\n\n\\score {\n  <<\n    ${/\\new\b/.test(c) ? '' : '\\new Staff { \\clef treble \\relative c\' { c1 } }\n'}\n  >>\n  \\layout { }\n}\n`;
  }
  if (!/\\header\b/.test(c)) {
    const title = String(fileName || 'Alto Score')
      .replace(/\.(pdf|png|jpe?g|webp)$/i, '')
      .replace(/"/g, '');
    c = c.replace(
      /(\\version\s+"[^"]+"\s*)/,
      `$1\n\\header { title = "${title}" tagline = ##f }\n`,
    );
  }
  return c.trim();
}

function buildPrompt(fileName, stricter = false) {
  const extra = stricter
    ? `\n중요: 이전 출력이 거부되었습니다. 설명·사과·마크다운 없이 **순수 LilyPond 소스만** 출력하세요. 첫 글자는 반드시 \\version 이어야 합니다.\n`
    : '';

  return `당신은 교회 합창/CCM 편곡가이자 LilyPond 전문가입니다.
첨부된 악보(모든 페이지)를 보고 **멜로디(소프라노/주선율) + 알토 화성**의 2성부 악보를 LilyPond 코드로 작성하세요.
${extra}
파일명: ${fileName || 'score'}

규칙:
1) 출력은 LilyPond 코드만. 설명/마크다운/코드펜스 금지. 반드시 \\version "2.24.0" 으로 시작.
2) 조성·박자·템포를 악보에서 읽고 반영.
3) 위 성부: 원곡 멜로디. 아래 성부: 알토 화성(3도·6도·화음톤, 자연스러운 성부진행).
4) \\new ChoirStaff << \\new Staff = "melody" ... \\new Staff = "alto" ... >> 형식 권장.
5) 가사가 보이면 Lyrics 포함, 없으면 생략.
6) \\header { title = "..." composer = "..." } 채우기.
7) \\score { ... \\layout { } \\midi { } } 포함.
8) 음표가 애매해도 빈 출력 금지. 최소한의 2성부 스케치를 작성.

LilyPond 소스만:`;
}

/**
 * @returns {Promise<{ lilypond: string, title?: string, key?: string, rawText: string }>}
 */
async function generateAltoLilypond(buffer, fileName, mimeType) {
  if (!isConfigured()) {
    const err = new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
    err.code = 'NO_GEMINI';
    throw err;
  }

  const images = await bufferToImages(buffer, mimeType, fileName);
  if (!images.length) {
    const err = new Error('악보 이미지를 읽지 못했습니다. PDF/JPG/PNG로 다시 시도해 주세요.');
    err.code = 'NO_IMAGE';
    throw err;
  }

  const imageParts = images.map((img) => ({
    inlineData: {
      mimeType: 'image/jpeg',
      data: Buffer.isBuffer(img)
        ? img.toString('base64')
        : Buffer.from(img).toString('base64'),
    },
  }));

  const timeoutMs = Math.min(120000, 45000 + images.length * 15000);
  console.log(`[alto] LilyPond 생성 · pages=${images.length}`);

  let lastRaw = '';
  let lastModel = '';

  for (let round = 0; round < 2; round++) {
    const response = await generateContent({
      contents: [{ text: buildPrompt(fileName, round > 0) }, ...imageParts],
      generationConfig: {
        temperature: round > 0 ? 0.1 : 0.2,
        maxOutputTokens: 8192,
      },
      timeoutMs,
      label: 'alto-ly',
    });

    if (!response?.text) {
      continue;
    }

    lastRaw = response.text;
    lastModel = response.model;
    console.log(
      `[alto] 응답 수신 · model=${response.model} · chars=${response.text.length} · preview=${JSON.stringify(response.text.slice(0, 120))}`,
    );

    let lilypond = repairLilypond(extractLilypond(response.text), fileName);
    if (!looksLikeLilypond(lilypond)) {
      console.warn('[alto] 파싱 실패 preview:', response.text.slice(0, 280));
      continue;
    }

    const titleMatch = lilypond.match(/title\s*=\s*"([^"]+)"/);
    const keyMatch = lilypond.match(
      /\\key\s+([a-g](?:is|es)?)\s*\\(major|minor)/i,
    );

    return {
      lilypond,
      title: titleMatch?.[1],
      key: keyMatch ? `${keyMatch[1]} ${keyMatch[2]}` : undefined,
      pageCount: images.length,
      rawText: response.text,
      model: response.model,
    };
  }

  const err = new Error(
    lastRaw
      ? `유효한 LilyPond 코드를 받지 못했습니다. (응답: ${lastRaw.slice(0, 80).replace(/\s+/g, ' ')}…)`
      : 'Gemini가 알토 악보를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
  err.code = lastRaw ? 'BAD_LY' : 'GEMINI_EMPTY';
  err.preview = lastRaw.slice(0, 300);
  err.model = lastModel;
  throw err;
}

module.exports = {
  generateAltoLilypond,
  extractLilypond,
  looksLikeLilypond,
  repairLilypond,
};
