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
assert(/\\version/.test(ly) && /\\score/.test(ly), 'repair adds version+score');

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

console.log('ok: alto parse/repair smoke tests passed');
