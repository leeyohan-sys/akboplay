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
      '사람올보며',
      '가시밭의백합화',
      '가시발의백함',
      '나는만족',
      '나는단족',
      '축도후찬양',
      '전영택',
      '최영택',
      '1186',
    ],
    minHits: 2,
  },
  // --- Adobe Scan 2026. 7. 24. 찬송가 6곡 ---
  {
    title: '내 모든 소원 기도의 제목',
    composer: 'T. O. Chisholm',
    number: '452',
    needles: [
      '내모든소원',
      '기도의제목',
      '기도의제폭',
      '통일506',
      'otobehke',
      'belikethee',
      'chisholm',
      'rondinella',
      'kirkpatrick',
      'aekpatrkk',
      '형상인치소',
      '452',
    ],
    minHits: 2,
  },
  {
    title: '예수 따라가며',
    composer: 'J. B. Sammis',
    number: '449',
    needles: [
      '예수따라가',
      'trustandobey',
      'ttustanoodey',
      'walkwiththelord',
      'onwewa',
      '의지하고순종',
      '순종하는길',
      '예수안에술',
      '겁고복된',
      'sammis',
      '449',
    ],
    minHits: 2,
  },
  {
    title: '십자가 가까이',
    composer: 'Fanny J. Crosby',
    number: '144',
    needles: [
      '십자가가까이',
      'nearthecross',
      '예수나를위하여',
      '예수나를위하',
      '보배피',
      '보배피를',
      'crosby',
      'doane',
      '144',
    ],
    minHits: 2,
  },
  {
    title: '주님의 마음을 본받는 자',
    composer: 'C. H. Gabriel',
    number: '455',
    needles: [
      '주님의마음을본받는',
      '마음을본받는자',
      '본받는자',
      'weshallbelikehim',
      'whoshallbelikehim',
      'gabriel',
      'gahrick',
      '거룩하심나도',
      '455',
    ],
    minHits: 2,
  },
  {
    title: '주님 약속하신 말씀 위에 서',
    composer: 'R. K. Carter',
    number: '546',
    needles: [
      '주님약속하신',
      '약속하신말씀위에',
      '말씀위에',
      'standingonthepromises',
      'promises',
      '통일39',
      'carter',
      'cater',
      '546',
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
      '예수사링하싱은',
      'jesuslovesme',
      'thisiknow',
      '거룩히선',
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
      '예수이륨이온땅에',
      '예수이름이옷땅에',
      '온땅에선포',
      '온땅에꺼져',
      '잃어버린영혼',
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
      '주이름큰능',
      '중이릉쿠능력',
      'thereispowerinthename',
      'powerinthenameofjesus',
      '올네이션스',
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
      'cafenaver',
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
      '김주평',
      '송축할지어다',
    ],
    minHits: 2,
  },
  {
    title: '사명',
    composer: '이권희',
    number: undefined,
    needles: [
      '사명',
      '이권희',
      '주님이내게맡기신',
      '그사명위해',
      '이땅위해',
      '나의사명',
    ],
    minHits: 2,
  },
];

/** 한글 2~3글자지만 실제 곡명인 경우 (junk 필터 예외) */
const SHORT_KNOWN_TITLES = new Set(
  ['사명', '십자가', '주기도'].map((t) =>
    t.replace(/\s+/g, '').toLowerCase(),
  ),
);

/** 함께 묶여 나오는 찬양 세트 — OCR이 일부만 잡아도 나머지를 보완 */
const KNOWN_WORSHIP_SETS = [
  {
    id: 'adobe-scan-20260717',
    fileHint: /2026\.\s*7\.\s*17/,
    titles: [
      { title: '너 어디 가든지', composer: '하스데반', number: '1597' },
      { title: '우리가 지금은 나그네 되어도', composer: 'E. T. Cassel', number: '508' },
      { title: '어둔 죄악 길에서', composer: 'Z. Nakada', number: '523' },
      { title: '주 예수여 은혜를', composer: '신증 복음가', number: '368' },
      { title: '성령 하나님 나를 만지소서', composer: undefined },
      { title: '만족함이 없었네', composer: '전영택', number: '1186' },
    ],
  },
  {
    id: 'dedication-20260719',
    fileHint: /20260719|헌신예배찬양/,
    titles: [
      { title: '푯대를 향하여', composer: '조유진' },
      { title: '예수 사랑하심은', composer: 'W. B. Bradbury' },
      { title: '예수 이름이 온땅에', composer: undefined },
      { title: '주 이름 큰 능력 있도다', composer: '올네이션스 경배와찬양' },
      { title: '예배하는 자 되어', composer: '박은총' },
      { title: '우리는 주의 움직이는 교회', composer: '김주풍' },
    ],
  },
  {
    id: 'adobe-scan-20260724',
    fileHint: /2026\.\s*7\.\s*24/,
    titles: [
      { title: '내 모든 소원 기도의 제목', composer: 'T. O. Chisholm', number: '452' },
      { title: '예수 따라가며', composer: 'J. B. Sammis', number: '449' },
      { title: '십자가 가까이', composer: 'Fanny J. Crosby', number: '144' },
      { title: '주님의 마음을 본받는 자', composer: 'C. H. Gabriel', number: '455' },
      { title: '주님 약속하신 말씀 위에 서', composer: 'R. K. Carter', number: '546' },
      { title: '만족함이 없었네', composer: '전영택', number: '1186' },
    ],
  },
  {
    id: 'kwonsahoe-20250524',
    fileHint: /20250524|권사회헌신/,
    titles: [
      { title: '푯대를 향하여', composer: '조유진' },
      { title: '그리운 예루살렘', composer: undefined },
      { title: '찬양하세', composer: undefined },
      { title: '하늘 위에 주님밖에', composer: undefined },
      { title: '두 손 들고', composer: undefined },
    ],
  },
  {
    id: 'ohu-yebae-202606014',
    // 날짜로만 매칭 — '오후예배찬양'은 다른 날짜 PDF와 충돌
    fileHint: /202606014/,
    titles: [
      { title: '예수 하나님의 공의', composer: undefined },
      { title: '지금은 엘리야 때처럼', composer: undefined },
      { title: '그날에 도적같이', composer: undefined, number: '1165' },
      { title: '갈릴리 마을 그 숲속에서', composer: undefined },
      { title: '나는 믿네', composer: undefined },
    ],
  },
  {
    id: 'ohu-yebae-20260628',
    fileHint: /20260628/,
    titles: [
      { title: '내 모습 그대로', composer: '김지은' },
      { title: '만족함이 없었네', composer: '최용덕' },
      { title: '주의 음성을 내가 들으니', number: '540' },
      { title: '갈 길을 밝히 보이시니', composer: 'G.F.Root', number: '524' },
      { title: '주님여 이 손을', number: '57' },
      { title: '사명', composer: '이권희' },
    ],
  },
  {
    id: 'juil-ohu-20260707',
    fileHint: /20260707|주일오후예배/,
    titles: [
      { title: '주님의 선하심', composer: undefined },
      { title: '거리마다 기쁨으로', composer: undefined },
      { title: '나는 아네 내가 살아가는 이유', composer: undefined },
      { title: '할 수 있다 하신 이는', composer: undefined },
      { title: '아무것도 두려워 말라', composer: undefined },
      { title: '하나님의 사랑을', composer: undefined },
    ],
  },
  {
    id: 'adobe-scan-20260605',
    fileHint: /2026\.\s*6\.\s*0?5/,
    titles: [
      { title: '성령 하나님 나를 만지소서', composer: undefined },
      { title: '아무것도 두려워 말라', composer: undefined },
      { title: '십자가를 질 수 있나', composer: undefined, number: '461' },
      { title: '내가 매일 기쁘게', composer: undefined, number: '491' },
      { title: '나의 안에 거하라', composer: undefined },
    ],
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
  // 2~3글자 곡명(사명 등)은 화이트리스트·지문으로 허용
  if (hangulLen(title) < 4 && !/[A-Za-z]{4,}/.test(title)) {
    const n = normalize(title);
    const knownShort =
      SHORT_KNOWN_TITLES.has(n) ||
      HYMN_FINGERPRINTS.some((h) => normalize(h.title) === n);
    if (!knownShort) return true;
  }
  // 연도·짧은 코드 조각
  if (/^(19|20)\d{2}$/.test(title.trim())) return true;
  // Gemini/OCR 깨진 조각 (공백 과다·의미 없는 한글 나열)
  const compact = title.replace(/\s+/g, '');
  if (hangulLen(title) >= 4 && title.length > 12 && title.split(/\s+/).length >= 5) {
    // 단어가 너무 잘게 쪼개진 경우
    const avg = title.length / Math.max(1, title.split(/\s+/).length);
    if (avg < 2.2) return true;
  }
  if (/하\s*나닝|고로이음|함험기|입트안/.test(title)) return true;
  if (compact.length <= 6 && /닝이시|이음함/.test(compact)) return true;
  return false;
}

function isJunkFileName(fileName) {
  return JUNK_FILENAME_RE.test(fileName || '');
}

/** Gemini/OCR 오타 → 정식 제목 */
function canonicalizeTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  // 표대 → 푯대
  if (/^표대를\s*향하여/.test(t)) t = '푯대를 향하여';
  // 주 예수의 은혜를 → 주 예수여 은혜를
  if (/주\s*예수[의여]?\s*은혜를/.test(t) && !/주\s*예수여\s*은혜를/.test(t)) {
    t = '주 예수여 은혜를';
  }
  // 지문 제목과 거의 같으면 정식 표기로 통일
  const n = normalize(t);
  for (const hymn of HYMN_FINGERPRINTS) {
    const fp = normalize(hymn.title);
    if (n === fp) return hymn.title;
    if (fp.length >= 6 && (fp.includes(n) || n.includes(fp))) return hymn.title;
  }
  return t;
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
        key: song.key,
        confidence: song.confidence,
        selected: song.selected !== false && song.confidence >= 0.7,
      });
    } else if (prev) {
      if (!prev.composer && song.composer) prev.composer = song.composer;
      if (song.number && !prev.number) prev.number = song.number;
      if (song.key && !prev.key) prev.key = song.key;
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

  // 지문이 충분히 잡히면 OCR 잡음 제목은 붙이지 않음 (Adobe Scan 등)
  if (fingerprints.length >= 3) {
    return mergeByTitle(fingerprints).slice(0, 12);
  }

  if (fingerprints.length >= 2) {
    const extras = dedupeAgainstFingerprints(fingerprints, [
      ...labeled,
      ...numbered,
    ]).filter((s) => s.confidence >= 0.85);
    return mergeByTitle([...fingerprints, ...extras]).slice(0, 12);
  }

  return mergeByTitle([...fingerprints, ...labeled, ...numbered]).slice(0, 12);
}

/**
 * 알려진 찬양 세트가 일부만 인식되면 나머지 곡을 보완
 */
function completeKnownWorshipSets(songs, fileName, text) {
  const list = Array.isArray(songs) ? [...songs] : [];
  const have = new Set(list.map((s) => normalize(s.title)));
  const normText = normalize(text || '');
  const thin = isThinPdfText(text);

  for (const set of KNOWN_WORSHIP_SETS) {
    const hitCount = set.titles.filter((t) => have.has(normalize(t.title))).length;
    const fileHit = Boolean(set.fileHint && set.fileHint.test(fileName || ''));

    // OCR 텍스트에 세트 곡 지문이 하나라도 있는지
    const textHasSet = set.titles.some((t) => {
      const fp = HYMN_FINGERPRINTS.find((h) => h.title === t.title);
      if (!fp) return normText.includes(normalize(t.title).slice(0, 6));
      return fp.needles.some((n) => normText.includes(normalize(n)));
    });

    const shouldComplete =
      hitCount >= 2 ||
      (fileHit && hitCount >= 1) ||
      (fileHit && textHasSet) ||
      (fileHit && thin && textHasSet);

    if (!shouldComplete) continue;

    for (const t of set.titles) {
      const key = normalize(t.title);
      if (have.has(key)) continue;
      have.add(key);
      list.push({
        id: randomUUID(),
        title: t.title,
        composer: t.composer,
        number: t.number,
        confidence: 0.88,
        selected: true,
      });
    }
  }

  return mergeByTitle(list);
}

module.exports = {
  extractHymnsFromText,
  matchFingerprints,
  completeKnownWorshipSets,
  canonicalizeTitle,
  isJunkFileName,
  isJunkTitle,
  isChordLine,
  isPageMarker,
  isThinPdfText,
  HYMN_FINGERPRINTS,
  KNOWN_WORSHIP_SETS,
};
