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
    mime.includes('pdf') || name.endsWith('.pdf') || buffer.slice(0, 5).toString() === '%PDF-';

  if (isPdf) {
    return pdfToJpegs(buffer);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return [buffer];
  }

  const jpg = await sharp(buffer)
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return [jpg];
}

function extractLilypond(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  // ```lilypond ... ``` 또는 ```ly ... ```
  const fenced = text.match(/```(?:lilypond|ly)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  // \version 으로 시작하는 본문
  const ver = text.indexOf('\\version');
  if (ver >= 0) return text.slice(ver).trim();

  return text;
}

function looksLikeLilypond(code) {
  const c = String(code || '');
  return /\\version|\\relative|\\new\s+Staff|<<|\\score/.test(c);
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
    const err = new Error('악보 이미지를 읽지 못했습니다.');
    err.code = 'NO_IMAGE';
    throw err;
  }

  const prompt = `당신은 교회 합창/CCM 편곡가이자 LilyPond 전문가입니다.
첨부된 악보(모든 페이지)를 보고 **멜로디(소프라노/주선율) + 알토 화성**의 2성부 악보를 LilyPond 코드로 작성하세요.

파일명: ${fileName || 'score'}

규칙:
1) 출력은 LilyPond 코드만. 설명/마크다운 금지. \\version "2.24.0" 부터 시작.
2) 조성·박자·템포를 악보에서 읽고 반영.
3) 위 성부: 원곡 멜로디(필요 시 옥타브 조정 가능). 아래 성부: 알토 화성(3도·6도·화음톤 위주, 성부진행 자연스럽게).
4) \\new ChoirStaff << \\new Staff = "melody" ... \\new Staff = "alto" ... >> 또는 한 Staff에 \\voiceOne/\\voiceTwo 2성부.
5) 가사(lyrics)가 보이면 멜로디에 \\addlyrics 또는 \\new Lyrics 로 넣기. 없으면 생략.
6) \\header { title = "..." composer = "..." } 채우기.
7) \\layout { \\context { \\Score \\omit BarNumber } } 정도로 읽기 쉽게.
8) 음표가 애매하면 가장 그럴듯한 화성으로 채우되, 가짜 제목/가짜 가사는 만들지 말 것.
9) MIDI도 포함: \\score { ... \\midi { } }

LilyPond 코드만 출력:`;

  const parts = [
    { text: prompt },
    ...images.map((img) => ({
      inlineData: {
        mimeType: 'image/jpeg',
        data: img.toString('base64'),
      },
    })),
  ];

  const timeoutMs = Math.min(120000, 40000 + images.length * 15000);
  console.log(`[alto] LilyPond 생성 · pages=${images.length}`);

  const response = await generateContent({
    contents: parts,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
    timeoutMs,
    label: 'alto-ly',
  });

  if (!response?.text) {
    const err = new Error('Gemini가 알토 악보를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    err.code = 'GEMINI_EMPTY';
    throw err;
  }

  const lilypond = extractLilypond(response.text);
  if (!looksLikeLilypond(lilypond)) {
    const err = new Error('유효한 LilyPond 코드를 받지 못했습니다.');
    err.code = 'BAD_LY';
    throw err;
  }

  // 제목·조성 힌트(있으면)
  const titleMatch = lilypond.match(/title\s*=\s*"([^"]+)"/);
  const keyMatch = lilypond.match(/\\key\s+([a-g][ei]?s?)\s*\\(major|minor)/i);

  return {
    lilypond,
    title: titleMatch?.[1],
    key: keyMatch ? `${keyMatch[1]} ${keyMatch[2]}` : undefined,
    pageCount: images.length,
    rawText: response.text,
    model: response.model,
  };
}

module.exports = {
  generateAltoLilypond,
  extractLilypond,
  looksLikeLilypond,
};
