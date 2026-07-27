/** 로컬 파싱/복구 스모크 테스트 (Gemini 호출 없음) */
const {
  extractLilypond,
  looksLikeLilypond,
  repairLilypond,
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

console.log('ok: alto parse/repair smoke tests passed');
