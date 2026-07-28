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
    const body = String(m[1] || '')
      .replace(/^```(?:lilypond|lily|ly)?\s*/i, '')
      .replace(/```\s*$/g, '')
      .trim();
    if (body.length > best.length) best = body;
  }
  if (best) text = best;
  // 펜스 추출 실패 시에도 잔여 ``` 제거
  text = text.replace(/```(?:lilypond|lily|ly)?/gi, '');

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

  // 주석 제외하고 마크다운 잔여 검사
  const body = c.replace(/%[^\n]*/g, '');
  const mdBullets = (body.match(/^\s*[\*\-]\s+/gm) || []).length;
  if (mdBullets >= 2) return false;
  if (/\*\*m\.\d+/i.test(body)) return false;

  // \relative / \new Staff / << >> 중 하나는 반드시 있어야 함
  // (맨몸 음표만 있는 \version+\header 는 렌더 시 NOTENAME_PITCH 오류)
  const hasStructure =
    /\\relative\b/.test(c) ||
    /\\new\s+(?:Choir)?Staff\b/.test(c) ||
    (/\\score\b/.test(c) && /<<[\s\S]*>>/.test(c));

  if (!hasStructure) return false;

  const hits = [
    /\\version\b/,
    /\\relative\b/,
    /\\score\b/,
    /\\new\s+(?:Choir)?Staff\b/,
    /\\header\b/,
    /\\key\b/,
    /<<[\s\S]*>>/,
  ].filter((re) => re.test(c)).length;

  return hits >= 2;
}

/**
 * Gemini가 자주 넣는 비문법 조각을 정리
 * 예: "m.9 (1st Ending: E B): e4 b4" → "e4 b4"
 * 예: "alto \\relative c' {" → "alto = \\relative c' {"
 * 예: 마크다운 ``` / 고아 백틱 제거
 */
function sanitizeLilypond(code) {
  let c = String(code || '');
  if (!c.trim()) return c;

  // 스마트쿼트·유사 문자를 ASCII로 (LilyPond는 ' ` 만 옥타브로 인식)
  c = c
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u00B4\u201B\u2035]/g, '`');

  // 본문 어디에 남아 있어도 마크다운 펜스 토큰 제거
  c = c.replace(/```(?:lilypond|lily|ly)?/gi, '');

  c = c
    .split(/\r?\n/)
    .map((line) => {
      let trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('%')) return line;

      // 펜스/백틱만 있는 줄 삭제 (undefined character or shorthand: ` 방지)
      if (/^`+$/.test(trimmed)) return '';

      // 마크다운 목록/볼드 마디 라벨 (* Alto:, * **m.8**: 등)
      if (/^[\*\-]\s+\*\*[^*]+\*\*:?\s*$/.test(trimmed)) {
        return `% ${trimmed.replace(/\*\*/g, '')}`;
      }
      if (/^[\*\-]\s+/.test(trimmed) && !/\\/.test(trimmed)) {
        // "* Alto: gis'8. ..." → 음표만 남김 / 음표 없으면 주석
        let body = trimmed
          .replace(/^[\*\-]\s+/, '')
          .replace(/\*\*/g, '')
          .replace(/^(?:Alto|Melody|Soprano|Tenor|Bass)\s*:\s*/i, '')
          .replace(/^m\.\d+\b[^:]*:\s*/i, '')
          .trim();
        if (!/\b[a-g](?:is|es)?[,']*\d/i.test(body)) {
          return `% ${trimmed}`;
        }
        const indent = (line.match(/^[ \t]*/) || [''])[0];
        return `${indent}${body}`;
      }

      // 마디/엔딩 자연어 라벨만 있는 줄 → 주석
      if (
        /^m\.\d+\b/i.test(trimmed) &&
        !/\\/.test(trimmed) &&
        !/\b[a-g](?:is|es)?['`,]*\d/.test(trimmed)
      ) {
        return `% ${trimmed}`;
      }
      if (
        /^(?:\d+(?:st|nd|rd|th)\s+)?(?:1st|2nd)\s+Ending\b/i.test(trimmed) &&
        !/\\/.test(trimmed)
      ) {
        return `% ${trimmed}`;
      }

      // header/가사 명령 줄은 한글 유지
      const keepHangul =
        /\\(?:header|markup|lyricmode|addlyrics|lyrics)\b/i.test(trimmed) ||
        /^\s*(?:title|composer|poet|arranger|subtitle)\s*=/.test(trimmed);

      // "Melody:", "Alto (G#m):", "nm7 (G#m C#m):" 같은 성부/코드 라벨만 있고
      // 뒤에 음표가 없는 줄 → 주석 (\\ 로 시작하면 실제 명령이므로 건드리지 않음)
      if (
        !/\\/.test(trimmed) &&
        /^[A-Za-z][\w#♯♭]*(?:\s*\([^)]*\))?\s*:\s*$/.test(trimmed)
      ) {
        return `% ${trimmed}`;
      }

      // 인라인 볼드 제거
      let out = line.replace(/\*\*/g, '');

      // "Melody: gis'8 ..." / "Alto (G#m): e'8 ..." → 라벨 제거, 음표만 남김
      // (라벨 자체엔 음표 패턴이 없고, 콜론 뒤가 실제 음표/쉼표/명령으로 시작할 때만)
      out = out.replace(
        /^([ \t]*)([A-Za-z][\w#♯♭]*)(\s*\([^)]*\))?\s*:\s*(?=[a-gA-GR\\<])/,
        (full, indent, label) =>
          /\b[a-g](?:is|es)?[,']*\d/i.test(label) ? full : indent,
      );
      // "m.9 (1st Ending: E B): <음표…>" → 음표만 남김
      out = out.replace(
        /^([ \t]*)m\.\d+\b(?:\s*\([^)]*\))?\s*:\s*/i,
        '$1',
      );
      out = out.replace(
        /^([ \t]*)(?:\d+(?:st|nd|rd|th)\s+)?(?:1st|2nd)\s+Ending\b(?:\s*\([^)]*\))?\s*:\s*/i,
        '$1',
      );
      // 괄호 없는 "m.9: notes" / "m.9 something: notes"
      out = out.replace(
        /^([ \t]*)m\.\d+\b[^:\\{]*:\s*(?=[a-grA-GR\\<{])/i,
        '$1',
      );

      if (!keepHangul) {
        // "으로 - - 보" -> cis''2 …  /  품* -> d''8 …  (가사·분석 매핑 제거)
        out = out.replace(/^([ \t]*)"[^"]*"\s*\*?\s*(?:->|→)\s*/u, '$1');
        out = out.replace(
          /^([ \t]*)[\uAC00-\uD7A3][\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\s\-_*]*\*?\s*(?:->|→)\s*/u,
          '$1',
        );
        // 음표 줄 안의 한글 따옴표 조각·고아 한글 토큰 제거 (not a note name: 품)
        if (/\b[a-g](?:is|es)?[,']*\d/i.test(out)) {
          out = out.replace(/"[^"\n]*[\uAC00-\uD7A3][^"\n]*"/gu, '');
          out = out.replace(
            /[\uAC00-\uD7A3][\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\s\-_*]*/gu,
            ' ',
          );
          out = out.replace(/\s{2,}/g, ' ');
          // " -> notes" 잔여 화살표 정리
          out = out.replace(/^([ \t]*)(?:->|→)\s*/u, '$1');
        } else if (/[\uAC00-\uD7A3]/.test(out) && !/\\/.test(out)) {
          // 음표 없는 한글 설명 줄 → 주석
          return `% ${trimmed}`;
        }
      }

      // 줄 맨 앞 고아 백틱 (`c4 → c4)
      out = out.replace(/^([ \t]*)`+([a-gA-G])/g, '$1$2');
      // 마크다운 인라인 코드 ``c4`` → c4
      out = out.replace(/`([a-g](?:is|es)?[,']*\d*\.*)`/gi, '$1');
      // LilyPond 옥타브는 ' 와 , 만 허용 — 음표 뒤 백틱을 아포스트로피로 변환
      out = out.replace(/([a-g](?:is|es)?[,']*)`+/gi, (m) =>
        m.replace(/`/g, "'"),
      );
      // 남은 고아 백틱(마크다운 잔여 등) 전부 제거
      out = out.replace(/`+/g, '');
      if (/^[ \t]*$/.test(out)) return '';

      // "melody \\relative" / "alto \\lyricmode" 처럼 = 누락 보정
      out = out.replace(
        /^([ \t]*)([A-Za-z][A-Za-z0-9_]*)(\s+)(\\(?:relative|lyricmode|new|lyrics)\b)/,
        (full, indent, name, sp, cmd) => {
          const reserved = new Set([
            'new',
            'with',
            'override',
            'set',
            'once',
            'undo',
            'temporary',
            'version',
            'header',
            'score',
            'layout',
            'midi',
            'paper',
            'book',
            'bookpart',
            'markup',
            'repeat',
            'alternative',
            'context',
          ]);
          if (reserved.has(name)) return full;
          return `${indent}${name} = ${cmd}`;
        },
      );

      return out;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return c;
}

/**
 * 문자열 리터럴 밖의 { } 깊이 계산
 */
function braceDepth(code) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' && code[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * 닫히지 않은 { 를 보완. \score 앞에 열린 블록이 있으면 그 앞에서 먼저 닫음
 * (이전 버그가 unclosed \relative 안에 \score 를 넣어 unexpected \\score 를 유발함)
 */
function balanceBraces(code) {
  let c = String(code || '');
  const scoreIdx = c.search(/\\score\b/);
  if (scoreIdx >= 0) {
    const before = c.slice(0, scoreIdx);
    const after = c.slice(scoreIdx);
    const depth = braceDepth(before);
    if (depth > 0 && depth <= 24) {
      c = `${before.trimEnd()}\n${'}'.repeat(depth)}\n\n${after.trimStart()}`;
    }
  }

  const rest = braceDepth(c);
  if (rest > 0 && rest <= 24) {
    c = `${c.trimEnd()}\n${'}'.repeat(rest)}\n`;
  }
  return c;
}

/**
 * 이전 복구 버그로 삽입된 더미 score(c1) 제거
 */
function stripDummyScore(code) {
  return String(code || '')
    .replace(
      /\n*\\score\s*\{\s*<<\s*\\new Staff\s*\{\s*\\clef treble\s*\\relative c'\s*\{\s*c1\s*\}\s*\}\s*>>\s*\\layout\s*\{\s*\}\s*\}/g,
      '\n',
    )
    .replace(/\n*\\score\s*\{\s*<<\s*>>\s*\\layout\s*\{\s*\}\s*\}/g, '\n');
}

/**
 * 변수로 정의된 성부가 있으면 \\score 로 묶음. top-level \\relative 만 있으면 그대로 둠
 */
function ensureScore(code) {
  if (/\\score\b/.test(code)) return code;

  const vars = [
    ...String(code).matchAll(
      /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*\\(?:relative|new)\b/gm,
    ),
  ].map((m) => m[1]);

  if (vars.length) {
    const staves = vars
      .map((v) => `    \\new Staff { \\clef treble \\${v} }`)
      .join('\n');
    return `${code.trim()}

\\score {
  <<
${staves}
  >>
  \\layout { }
}`;
  }

  // top-level \\relative 는 score 없이도 LilyPond가 렌더 가능
  return code;
}

/**
 * \relative/\new Staff 없이 맨몸 음표만 있는 경우 score로 감싸 렌더 가능하게 함
 */
function wrapOrphanMusic(code) {
  if (/\\(?:relative|new\s+(?:Choir)?Staff)\b/.test(code)) return code;

  const lines = String(code || '').split(/\r?\n/);
  const preamble = [];
  const musicLines = [];
  let inHeader = false;
  let braceDepthHdr = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!musicLines.length) preamble.push(line);
      continue;
    }
    if (trimmed.startsWith('%')) {
      preamble.push(line);
      continue;
    }

    if (/\\header\b/.test(trimmed) || inHeader) {
      preamble.push(line);
      for (const ch of trimmed) {
        if (ch === '{') {
          inHeader = true;
          braceDepthHdr += 1;
        } else if (ch === '}') {
          braceDepthHdr -= 1;
          if (braceDepthHdr <= 0) {
            inHeader = false;
            braceDepthHdr = 0;
          }
        }
      }
      continue;
    }

    if (/^\\(?:version|paper|layout|midi|book)\b/.test(trimmed)) {
      preamble.push(line);
      continue;
    }

    if (/\b[a-g](?:is|es)?[,']*\d/i.test(trimmed)) {
      musicLines.push(trimmed);
      continue;
    }

    preamble.push(`% ${trimmed}`);
  }

  if (!musicLines.length) return code;

  return `${preamble.join('\n').trim()}

\\score {
  \\new Staff {
    \\clef treble
    \\relative c' {
      ${musicLines.join('\n      ')}
    }
  }
  \\layout { }
}`.trim();
}

/** 최소한의 헤더를 붙여 유효 .ly 로 복구 */
function repairLilypond(code, fileName) {
  let c = sanitizeLilypond(String(code || '').trim());
  if (!c) return c;

  // LilyPond 토큰이 전혀 없으면 복구하지 않음 (사과/설명 문구 방지)
  if (
    !/\\(?:version|relative|score|header|new|key|time|clef)\b/.test(c) &&
    !/<<[\s\S]*>>/.test(c) &&
    !/\b[a-g](?:is|es)?['`,]*\d/.test(c)
  ) {
    return c;
  }

  if (!/\\version\b/.test(c)) {
    c = `\\version "2.24.0"\n\n${c}`;
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

  // 이전 버그의 더미 score 제거 → 중괄호 균형 → 맨몸 음표 감싸기 → 필요 시 score
  c = stripDummyScore(c);
  c = balanceBraces(c);
  c = wrapOrphanMusic(c);
  c = ensureScore(c);
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
6) \\header { title = "..." composer = "..." } 채우기. 모든 필드는 key = "value" 형식(등호 필수).
7) \\score { ... \\layout { } \\midi { } } 포함.
8) 음표가 애매해도 빈 출력 금지. 최소한의 2성부 스케치를 작성.
9) 변수 할당은 반드시 등호 사용: melody = \\relative c' { ... }
10) 1·2번 엔딩/도돌이표는 자연어 금지. 오직 \\repeat volta N { ... } \\alternative { { ... } { ... } } 만 사용.
11) "m.9", "1st Ending", "2nd Ending" 같은 마디·엔딩 라벨을 코드 줄에 절대 쓰지 말 것.
12) 마크다운 금지: *, -, **, "#", "Alto:", "Melody:" 목록/설명 금지. 음표는 반드시 \\relative { } 또는 \\new Staff { } 안에만.
13) 가사·음표 매핑 금지. "품* -> d8", "\\"으로\\" -> cis2" 같은 형식을 쓰지 말 것. 가사는 \\lyricmode / \\addlyrics 만 사용.
14) 성부/코드 라벨 금지. "Melody:", "Alto (G#m):", "nm7 (G#m C#m):" 같은 텍스트를 음표 줄에 절대 쓰지 말 것. 성부는 오직 melody = \\relative { } / alto = \\relative { } 변수로만 구분.

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

  // 라우트 예산(약 3분) 안에서 429 재시도·생성 완료
  const deadlineMs = 170000;
  const timeoutMs = Math.min(90000, 45000 + images.length * 15000);
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
      deadlineMs: Math.max(30000, deadlineMs - round * 60000),
      maxRetries: 2,
      throwOnRateLimit: true,
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
  sanitizeLilypond,
};
