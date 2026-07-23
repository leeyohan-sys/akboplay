/**
 * 한국 찬송가/복음성가/CCM 스캔본에서 곡 제목을 추출합니다.
 * Adobe Scan OCR은 오선·코드와 섞여 품질이 낮아, 가사 지문을 우선합니다.
 */
const { randomUUID } = require('crypto');

const CHORD_RE =
  /^(?:[A-G](?:#|b|♯|♭)?(?:maj7?|min|m|dim|aug|sus\d?|add\d?|m7|7|9|11|13)?(?:\/[A-G](?:#|b)?)?(?:\s|,)*)+$/i;

const JUNK_FILENAME_RE =
  /adobe\s*scan|camscanner|genius\s*scan|scan\s*\d|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/i;

const JUNK_TITLE_RE =
  /^(편잡인|편집인|후렴|보통으로|쉬운|기타코드|세계선교|기도와|축도후|capt?o|cassel|meet|heart|words\s*&?\s*music|입례)/i;

/** PDF 뷰어가 넣는 페이지 마커 (-- 1 of 3 -- 등) */
const PAGE_MARKER_RE = /^[-–—\s]*\d+\s*of\s*\d+[-–—\s]*$/i;

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
  // --- 헌신예배 찬양셋 (20260719) ---
  {
    title: '푯대를 향하여',
    composer: '조유진',
    number: undefined,
    needles: [
      '푯대를향하여',
      '푯대를향하',
      '표대를향하여',
      '풋대를향하여',
      '내게유익하던',
      '해로여기네',
      '조유진',
      '부름의상',
    ],
    minHits: 2,
  },
  {
    title: '예수 사랑하심은',
    composer: 'W. B. Bradbury',
    number: undefined,
    needles: [
      '예수사랑하심은',
      'jesuslovesme',
      'thisiknow',
      '거룩하신말씀',
      'bradbury',
      '한국찬송가공회',
    ],
    minHits: 2,
  },
  {
    title: '예수 이름이 온땅에',
    composer: undefined,
    number: undefined,
    needles: [
      '예수이름이온땅에',
      '예수이릉이온땅에',
      '예수이륭이온땅에',
      '예수이름이옷땅에',
      '온땅에선포',
      '온땅에toll',
      '잃어버린영혼',
      '잃어 버린영은',
      '영방중에',
    ],
    minHits: 1,
  },
  {
    title: '주 이름 큰 능력 있도다',
    composer: '올네이션스 경배와찬양',
    number: undefined,
    needles: [
      '주이름큰능력',
      '중이릉쿠능력',
      'thereispowerinthename',
      'powerinthenameofjesus',
      '올네이션스',
      '검처럼',
      '자유케해',
    ],
    minHits: 2,
  },
  {
    title: '예배하는 자 되어',
    composer: '박은총',
    number: undefined,
    needles: [
      '예배하는자되어',
      '예배하는자돼',
      '영과진리로',
      '박은총',
      '예배하자주가',
      'cafehaver',
    ],
    minHits: 2,
  },
  {
    title: '우리는 주의 움직이는 교회',
    composer: '김주풍',
    number: undefined,
    needles: [
      '우리는주의움직이는교회',
      '주의움직이는교회',
      '움직이는교회',
      '이곳은주님을위한자리',
      '김주풍',
      '송축할지어다',
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

function isPageMarker(title) {
  const t = String(title || '').trim();
  if (PAGE_MARKER_RE.test(t)) return true;
  if (/^\d+\s*of\s*\d+$/i.test(t)) return true;
  if (/^--\s*\d+\s*of\s*\d+\s*--$/i.test(t)) return true;
  return false;
}

function isJunkTitle(title) {
  if (!title) return true;
  if (isPageMarker(title)) return true;
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

/** 임베디드 텍스트가 사실상 비어 있는지 (페이지 마커만 있는 스캔본) */
function isThinPdfText(text) {
  const raw = String(text || '').trim();
  if (raw.length < 20) return true;
  const meaningful = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isPageMarker(l) && !/^-+$/.test(l));
  const joined = meaningful.join(' ');
  return hangulLen(joined) < 8 && !/[A-Za-z]{6,}/.test(joined);
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
    if (fpNorms.some((fp) => fp.includes(n) || n.includes(fp))) return false;
    return true;
  });
}

/**
 * OCR에서 자주 나오는 "1) 제목" / "2) 제목  다른제목" 패턴
 */
function extractLabeledTitles(text) {
  const found = [];
  const seen = new Set();

  const push = (title, confidence = 0.82) => {
    const cleaned = String(title)
      .replace(/\s+/g, ' ')
      .replace(/[|\[\]~=]+/g, '')
      .trim();
    if (isJunkTitle(cleaned)) return;
    if (hangulLen(cleaned) < 4 || hangulLen(cleaned) > 30) return;
    // OCR 깨진 영문 조각이 섞인 제목 제외
    const latin = ((cleaned.match(/[A-Za-z]/g) || []).length);
    if (latin >= 3 && latin >= hangulLen(cleaned) * 0.4) return;
    const key = normalize(cleaned);
    if (seen.has(key)) return;
    // 이미 등록된 지문 제목과 한 글자만 다른 변형(표대/푯대)은 스킵
    if (
      HYMN_FINGERPRINTS.some((h) => {
        const fp = normalize(h.title);
        return fp === key || (fp.length >= 6 && (fp.includes(key) || key.includes(fp)));
      })
    ) {
      return;
    }
    seen.add(key);
    found.push({
      id: randomUUID(),
      title: cleaned,
      confidence,
      selected: true,
    });
  };

  // 1) 푯대를 향하여
  const labeled = String(text || '').matchAll(
    /(?:^|\n)\s*(\d{1,2})\s*[).．、]\s*([가-힣A-Za-z][가-힣A-Za-z\s]{2,40})/g,
  );
  for (const m of labeled) {
    // 한 줄에 두 곡이 나란히 있는 경우: "예수 이름이 온땅에  주 이름 큰 능력 있도다"
    const rest = m[2].trim();
    const parts = rest.split(/\s{2,}|\t/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      parts.forEach((p) => push(p, 0.84));
    } else {
      push(rest, 0.86);
    }
  }

  return found;
}

/**
 * 번호(3~4자리, 연도 제외) 근처의 뚜렷한 한글 제목만 보조 추출
 */
function extractNumberedTitles(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => !isChordLine(l) && !isPageMarker(l));

  const found = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{3,4})$/);
    if (!m) continue;
    const number = m[1];
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
  const labeled = extractLabeledTitles(text);
  const numbered = extractNumberedTitles(text);

  if (fingerprints.length >= 2) {
    const extras = dedupeAgainstFingerprints(fingerprints, [
      ...labeled,
      ...numbered,
    ]);
    return mergeByTitle([...fingerprints, ...extras]).slice(0, 12);
  }

  return mergeByTitle([...fingerprints, ...labeled, ...numbered]).slice(0, 12);
}

module.exports = {
  extractHymnsFromText,
  matchFingerprints,
  isJunkFileName,
  isJunkTitle,
  isChordLine,
  isPageMarker,
  isThinPdfText,
  HYMN_FINGERPRINTS,
};
