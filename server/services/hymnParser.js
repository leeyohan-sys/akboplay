/**
 * 한국 찬송가/복음성가 스캔본에서 곡 제목을 추출합니다.
 * Adobe Scan OCR은 오선·코드와 섞여 품질이 낮아, 가사 지문을 우선합니다.
 */
const { randomUUID } = require('crypto');

const CHORD_RE =
  /^(?:[A-G](?:#|b|♯|♭)?(?:maj7?|min|m|dim|aug|sus\d?|add\d?|m7|7|9|11|13)?(?:\/[A-G](?:#|b)?)?(?:\s|,)*)+$/i;

const JUNK_FILENAME_RE =
  /adobe\s*scan|camscanner|genius\s*scan|scan\s*\d|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/i;

const JUNK_TITLE_RE =
  /^(편잡인|편집인|후렴|보통으로|쉬운|기타코드|세계선교|기도와|축도후|capt?o|cassel|meet|heart)/i;

/**
 * 가사/문구 지문 → 정식 제목
 * OCR이 깨져도 일부 구절이 남으면 매칭됩니다.
 */
const HYMN_FINGERPRINTS = [
  {
    title: '너 어디 가든지',
    composer: '하스데반',
    number: '1597',
    needles: ['너어디가든지', '너무엇하든지', '진실하라', '도우시라', '돌보시리', '하스데반', '하스반'],
    minHits: 2,
  },
  {
    title: '우리가 지금은 나그네 되어도',
    composer: 'E. T. Cassel',
    number: '508',
    needles: [
      '우리가지금은나그네',
      '지금은니나그네',
      '화려한천국에',
      '주내게부탁하신',
      '이기쁜소식전',
      'cassel',
    ],
    minHits: 2,
  },
  {
    title: '어둔 죄악 길에서',
    composer: 'Z. Nakada',
    number: '523',
    needles: [
      '어둔죄악길에서',
      '어둔조악길에서',
      '폭자없는양같이',
      'meetmethere',
      'nakada',
      '이때라',
    ],
    minHits: 2,
  },
  {
    title: '주 예수여 은혜를',
    composer: '신증 복음가',
    number: '368',
    needles: [
      '주예수여은혜를',
      '예수여은혜를내러주사',
      'heartlongings',
      '주리고목마른',
      '신증복음가',
      '신중복음가',
    ],
    minHits: 2,
  },
  {
    title: '성령 하나님 나를 만지소서',
    composer: undefined,
    number: undefined,
    needles: [
      '성령하나님나를만지소서',
      '성령하나님나를안지소서',
      '상하고깨어진',
      '이곳에임하소서',
      '바람처럼불처럼',
      '성령의바람',
    ],
    minHits: 2,
  },
  {
    title: '만족함이 없었네',
    composer: '전영택',
    number: '1186',
    needles: [
      '만족함이없었네',
      '만족하겠네',
      '사람을보며세상을',
      '가시밭의백합화',
      '나는만족',
      '축도후찬양',
      '전영택',
      '최영택',
    ],
    minHits: 2,
  },
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\w가-힣]/g, '');
}

function hangulLen(s) {
  return ((String(s).match(/[가-힣]/g) || []).length);
}

function isChordLine(line) {
  const t = String(line).replace(/\s+/g, '');
  if (!t || t.length > 40) return false;
  return CHORD_RE.test(t);
}

function isJunkTitle(title) {
  if (!title) return true;
  if (JUNK_TITLE_RE.test(title.trim())) return true;
  if (isJunkFileName(title)) return true;
  if (hangulLen(title) < 4 && !/[A-Za-z]{4,}/.test(title)) return true;
  // 연도·짧은 코드 조각
  if (/^(19|20)\d{2}$/.test(title.trim())) return true;
  return false;
}

function isJunkFileName(fileName) {
  return JUNK_FILENAME_RE.test(fileName || '');
}

function matchFingerprints(text) {
  const norm = normalize(text);
  const found = [];

  for (const hymn of HYMN_FINGERPRINTS) {
    const hits = hymn.needles.filter((n) => norm.includes(normalize(n))).length;
    if (hits >= hymn.minHits) {
      found.push({
        id: randomUUID(),
        title: hymn.title,
        composer: hymn.composer,
        number: hymn.number,
        confidence: Math.min(0.98, 0.72 + hits * 0.06),
        selected: true,
      });
    }
  }
  return found;
}

/** 지문 곡의 부분 문자열/중복 후보 제거 */
function dedupeAgainstFingerprints(fingerprints, extras) {
  const fpNorms = fingerprints.map((s) => normalize(s.title));
  return extras.filter((song) => {
    if (isJunkTitle(song.title)) return false;
    if (song.confidence < 0.75) return false;
    const n = normalize(song.title);
    if (n.length < 6) return false;
    // 이미 지문으로 잡힌 제목의 조각이면 버림
    if (fpNorms.some((fp) => fp.includes(n) || n.includes(fp))) return false;
    return true;
  });
}

/**
 * 번호(3~4자리, 연도 제외) 근처의 뚜렷한 한글 제목만 보조 추출
 */
function extractNumberedTitles(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => !isChordLine(l));

  const found = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{3,4})$/);
    if (!m) continue;
    const number = m[1];
    // 연도·너무 작은 번호 제외 (찬송가 번호는 보통 1~2000)
    if (Number(number) >= 1800 && Number(number) <= 2100) continue;

    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 6); j++) {
      if (j === i) continue;
      const line = lines[j].replace(/^<\s*|\s*>$/g, '').trim();
      if (isJunkTitle(line)) continue;
      if (hangulLen(line) < 6 || hangulLen(line) > 28) continue;
      if (/^\d+[\.)]/.test(line)) continue;
      if ((line.match(/[가-힣]/g) || []).length / line.replace(/\s/g, '').length < 0.7) {
        continue;
      }

      const key = normalize(line);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        id: randomUUID(),
        title: line,
        number,
        confidence: 0.7,
        selected: false,
      });
      break;
    }
  }
  return found;
}

function mergeByTitle(songs) {
  const map = new Map();
  for (const song of songs) {
    if (isJunkTitle(song.title)) continue;
    const key = normalize(song.title);
    const prev = map.get(key);
    if (!prev || song.confidence > prev.confidence) {
      map.set(key, {
        id: song.id || randomUUID(),
        title: song.title,
        composer: song.composer,
        number: song.number,
        confidence: song.confidence,
        selected: song.selected !== false && song.confidence >= 0.7,
      });
    } else if (prev && !prev.composer && song.composer) {
      prev.composer = song.composer;
      if (song.number && !prev.number) prev.number = song.number;
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * 찬송가/복음성가 PDF 텍스트에서 곡 목록 추출
 */
function extractHymnsFromText(text) {
  const fingerprints = matchFingerprints(text);
  const numbered = extractNumberedTitles(text);

  // 지문이 충분히 잡히면 지문 우선 + 겹치지 않는 보조만
  if (fingerprints.length >= 2) {
    const extras = dedupeAgainstFingerprints(fingerprints, numbered);
    return mergeByTitle([...fingerprints, ...extras]).slice(0, 12);
  }

  return mergeByTitle([...fingerprints, ...numbered]).slice(0, 12);
}

module.exports = {
  extractHymnsFromText,
  matchFingerprints,
  isJunkFileName,
  isJunkTitle,
  isChordLine,
  HYMN_FINGERPRINTS,
};
