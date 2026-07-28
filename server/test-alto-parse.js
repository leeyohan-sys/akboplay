/** 로컬 파싱/복구 스모크 테스트 (Gemini 호출 없음) */
const {
  extractLilypond,
  looksLikeLilypond,
  repairLilypond,
  sanitizeLilypond,
} = require('./services/altoLilypond');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function countBraceDepth(code) {
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

const fenced = `설명입니다.
\`\`\`lilypond
\\version "2.24.0"
\\relative c' { c4 d e f }
\\score { << \\new Staff { \\relative c' { c1 } } >> \\layout{} }
\`\`\`
끝.`;

const unclosed = `\`\`\`ly
\\version "2.24.0"
\\relative c' { a4 }
\\score { \\relative c' { a1 } \\layout{} }`;

const bareRelative = `\\relative c' {
  \\key c \\major
  c4 d e f
}`;

const apology = '죄송하지만 악보를 읽을 수 없습니다.';

let ly = extractLilypond(fenced);
assert(looksLikeLilypond(ly), 'fenced should parse');

ly = extractLilypond(unclosed);
assert(looksLikeLilypond(ly), 'unclosed fence should parse');

ly = repairLilypond(extractLilypond(bareRelative), 'test.png');
assert(looksLikeLilypond(ly), 'bare relative should repair');
assert(/\\version/.test(ly), 'repair adds version');
assert(countBraceDepth(ly) === 0, 'bare relative braces balanced');

ly = repairLilypond(extractLilypond(apology), 'x.png');
assert(!looksLikeLilypond(ly), 'apology must fail');

// 스마트쿼트·설명 섞인 응답
const smartQuotes = `아래는 코드입니다.
\\version "2.24.0"
\\header { title = “보행을 지나” }
\\relative c' { \\key e \\major e4 fis gis a }
\\score { << \\new Staff { \\relative c' { e1 } } \\new Staff { \\relative c' { cis1 } } >> \\layout{} }`;
ly = repairLilypond(extractLilypond(smartQuotes), '보행을_지나_1(E).png');
assert(looksLikeLilypond(ly), 'smart quotes + Korean title should parse');

// Gemini가 넣는 마디/엔딩 자연어 라벨 제거
const endingProse = `\\version "2.24.0"
\\header { title = "x" }
melody = \\relative c' {
  e4 b4
m.9 (1st Ending: E B): e4 b4 |
m.10 (2nd Ending: E B): e2. |
}
alto \\relative c' { cis4 gis4 e4 b4 }
\\score { << \\new Staff { \\melody } \\new Staff { \\alto } >> \\layout{} }`;
const cleaned = sanitizeLilypond(endingProse);
assert(!/m\.9/i.test(cleaned), 'measure prose prefix fully removed');
assert(!/1st Ending/i.test(cleaned), '1st Ending label removed');
assert(/e4 b4\s*\|/.test(cleaned), 'notes after ending label kept');
assert(/alto\s*=\s*\\relative/.test(cleaned), 'missing = before relative fixed');
assert(looksLikeLilypond(cleaned), 'sanitized ending prose still valid');
console.log('sanitized preview:\n', cleaned);

// 마크다운 펜스·고아 백틱 / 옥타브 백틱→아포스트로피
const fencedJunk = `\`\`\`lilypond
\\version "2.24.0"
\\header { title = "x" }
\`
melody = \\relative c' { c\`4 d\`\` e' }
\`\`\`
\\score { << \\new Staff { \\melody } >> \\layout{} }`;
const noTicks = sanitizeLilypond(extractLilypond(fencedJunk));
assert(!/```/.test(noTicks), 'fences removed');
assert(!/`/.test(noTicks), 'all backticks removed or converted');
assert(/c'4/.test(noTicks), 'octave backtick converted to apostrophe');
assert(/d''/.test(noTicks), 'double octave backtick converted');
assert(looksLikeLilypond(repairLilypond(noTicks, 'x.png')), 'fence junk still valid');

const leadingTick = sanitizeLilypond(
  `\\version "2.24.0"\n\`\nc\`4 d4\n\\relative c' { e4 }`,
);
assert(!/`/.test(leadingTick), 'standalone and octave backticks cleaned');
assert(/c'4/.test(leadingTick), 'c\`4 became c\'4');

// 마크다운 분석 + 맨몸 음표 → 구조로 복구
const mdOrphan = `\\version "2.24.0"
\\header { title = "보혈을_지나_1(E)" tagline = ##f }
b'8. b'16 a'8. gis'16 ~ gis'8. gis'16 fis'8. e'16
  * Alto: gis'8. gis'16 fis'8. e'16 ~ e'8. e'16 dis'8. cis'16
  * **m.8 (A - B)**:`;
assert(!looksLikeLilypond(mdOrphan), 'raw markdown orphan must be rejected');
const repairedMd = repairLilypond(mdOrphan, '보혈을_지나_1(E).png');
assert(looksLikeLilypond(repairedMd), 'repaired markdown orphan becomes valid');
assert(/\\relative\b/.test(repairedMd), 'orphan notes wrapped in relative');
assert(/\\new Staff\b/.test(repairedMd), 'orphan notes wrapped in Staff');
assert(!/\*\s+Alto:/i.test(repairedMd), 'markdown Alto bullet removed');
assert(!/\*\*m\.8/i.test(repairedMd), 'markdown measure bold removed');
assert(/gis'8\./.test(repairedMd), 'alto notes preserved after bullet strip');

// unclosed \relative 안에 더미 \score 가 끼어든 경우 (unexpected \\score)
const nestedScore = `\\version "2.24.0"
\\header { title = "보혈을_지나" tagline = ##f }
\\relative c' {
  gis'2 r4 b,

\\score {
  <<
    \\new Staff { \\clef treble \\relative c' { c1 } }
  >>
  \\layout { }
}`;
const fixedNested = repairLilypond(nestedScore, 'x.png');
assert(countBraceDepth(fixedNested) === 0, 'nested score braces balanced');
assert(!/\\relative c'\s*\{\s*c1\s*\}/.test(fixedNested), 'dummy c1 score stripped');
assert(/gis'2\s+r4\s+b,/.test(fixedNested), 'original notes kept');
// \\score 가 열린 relative 안에 있지 않은지: \\score 앞 depth 0
const scoreAt = fixedNested.search(/\\score\b/);
if (scoreAt >= 0) {
  assert(
    countBraceDepth(fixedNested.slice(0, scoreAt)) === 0,
    'score not nested inside unclosed block',
  );
}
assert(looksLikeLilypond(fixedNested), 'fixed nested score still valid');

// 가사→음표 매핑 (품* -> / "으로" ->) 제거
const lyricMap = `\\version "2.24.0"
\\header { title = "보혈을_지나_1_E_" tagline = ##f }
\\score {
  \\new Staff {
    \\clef treble
    \\relative c' {
    품* -> d''8 d''8 d''8. cis''16
    "으로 - - 보" -> cis''2 ~ cis''4 r8 b'8
    d''8 d''8 d''8. cis''16 ~ cis''4
    }
  }
  \\layout { }
}`;
const fixedLyric = repairLilypond(lyricMap, '보혈을_지나_1_E_.pdf');
assert(!/품/.test(fixedLyric), 'hangul syllable stripped from music');
assert(!/으로/.test(fixedLyric), 'quoted lyric mapping stripped');
assert(!/->/.test(fixedLyric), 'arrow mapping removed');
assert(/d''8\s+d''8\s+d''8\.\s+cis''16/.test(fixedLyric), 'notes after 품* kept');
assert(/cis''2\s*~\s*cis''4/.test(fixedLyric), 'notes after quoted lyric kept');
assert(looksLikeLilypond(fixedLyric), 'lyric-map repaired still valid');
assert(/title = "보혈을_지나_1_E_"/.test(fixedLyric), 'header hangul preserved');

// 성부/코드 라벨 (Melody:, Alto (G#m):, nm7 (G#m C#m):) 제거
const voiceLabels = `\\version "2.24.0"
\\header { title = "보혈을_지나_1_E_" tagline = ##f }
\\relative c' {
e'8. fis'16
nm7 (G#m C#m):
Melody: gis'8. fis'16 gis'8. a'16 cis''4 ~ cis''8. b'16
Alto (G#m): e'8. dis'16 e'8. fis'16
Alto (C#m): e'4 ~ e'8. dis'16
}`;
const fixedLabels = sanitizeLilypond(voiceLabels);
assert(!/Melody/.test(fixedLabels), 'Melody label removed');
assert(!/Alto\s*\(/.test(fixedLabels), 'Alto (chord) label removed');
assert(!/^nm7/m.test(fixedLabels), 'orphan chord-only label commented out');
assert(/gis'8\.\s+fis'16\s+gis'8\.\s+a'16/.test(fixedLabels), 'melody notes kept');
assert(/e'8\.\s+dis'16\s+e'8\.\s+fis'16/.test(fixedLabels), 'alto notes kept');
assert(looksLikeLilypond(repairLilypond(voiceLabels, 'x.png')), 'voice-label repaired still valid');

console.log('ok: alto parse/repair smoke tests passed');
