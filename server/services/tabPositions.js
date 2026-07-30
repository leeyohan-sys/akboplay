/**
 * 조성별 기타 스케일 포지션 (사용자 지정)
 * string: 1=고음 e … 6=저음 E
 *
 * C: 5프렛 · 3현 = 도(C)
 * D: 7프렛 · 3현 = 레(D)
 * E: 9프렛 · 3현 = 미(E)
 * F: 6프렛 · 2현 = 파(F)
 * G: 8프렛 · 2현 = 솔(G)
 * A: 10프렛 · 2현 = 라(A)
 */

/** 개방현 MIDI (1현→6현): E4 B3 G3 D3 A2 E2 */
const OPEN_MIDI = [64, 59, 55, 50, 45, 40];

const NOTE_TO_PC = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** 조성 루트 → 포지션 */
const POSITION_BY_ROOT = {
  C: { string: 3, fret: 5, label: 'C · 5프렛 3현(도)' },
  D: { string: 3, fret: 7, label: 'D · 7프렛 3현(레)' },
  E: { string: 3, fret: 9, label: 'E · 9프렛 3현(미)' },
  F: { string: 2, fret: 6, label: 'F · 6프렛 2현(파)' },
  G: { string: 2, fret: 8, label: 'G · 8프렛 2현(솔)' },
  A: { string: 2, fret: 10, label: 'A · 10프렛 2현(라)' },
  // B는 명시되지 않아 A 포지션을 +2 이동한 형태로 근사
  B: { string: 2, fret: 12, label: 'B · 12프렛 2현' },
};

/**
 * "E", "Em", "E major", "마장조", "Bb" 등 → 루트 문자
 */
function parseKeyRoot(keyRaw) {
  const s = String(keyRaw || '').trim();
  if (!s) return null;

  // 한글 조성
  const ko = {
    다: 'C',
    라: 'D',
    마: 'E',
    바: 'F',
    사: 'G',
    가: 'A',
    나: 'B',
  };
  for (const [k, v] of Object.entries(ko)) {
    if (s.includes(`${k}장조`) || s.includes(`${k}단조`) || s.startsWith(k)) {
      // "라" alone is ambiguous with note 라 — only match *장조/*단조
      if (s.includes('장조') || s.includes('단조')) return v;
    }
  }

  const m = s.match(/^([A-Ga-g])([#♯b♭]?)/);
  if (!m) return null;
  let root = m[1].toUpperCase();
  const acc = m[2];
  if (acc === '#' || acc === '♯') {
    // C# → 가장 가까운 명시 포지션(D)보다 enharmonic 처리: C#는 C+1 → D계열로 두지 말고
    // Bb/Eb 등은 아래 테이블로
    const sharpMap = { C: 'D', D: 'E', F: 'G', G: 'A', A: 'B' };
    root = sharpMap[root] || root;
  } else if (acc === 'b' || acc === '♭') {
    const flatMap = { D: 'C', E: 'D', G: 'F', A: 'G', B: 'A' };
    root = flatMap[root] || root;
  }
  return root;
}

function getPositionForKey(keyRaw) {
  const root = parseKeyRoot(keyRaw) || 'C';
  return {
    root,
    ...(POSITION_BY_ROOT[root] || POSITION_BY_ROOT.C),
  };
}

function midiFromTab(string, fret) {
  const s = Math.max(1, Math.min(6, string));
  const f = Math.max(0, Math.min(24, fret));
  return OPEN_MIDI[s - 1] + f;
}

/**
 * note 문자열 → MIDI (C4, Do4, 미4, "E", midi number)
 */
function parsePitchToMidi(pitch, fallbackMidi) {
  if (pitch == null || pitch === '') return fallbackMidi;
  if (typeof pitch === 'number' && Number.isFinite(pitch)) {
    return Math.round(pitch);
  }
  const t = String(pitch).trim();
  if (/^\d+$/.test(t)) return Number(t);

  // 계이름
  const solf = { 도: 'C', 레: 'D', 미: 'E', 파: 'F', 솔: 'G', 라: 'A', 시: 'B' };
  let n = t;
  for (const [ko, en] of Object.entries(solf)) {
    if (n.includes(ko)) n = n.replace(ko, en);
  }

  const m = n.match(/^([A-Ga-g])([#♯b♭]?)(-?\d)?/);
  if (!m) return fallbackMidi;
  let pc = NOTE_TO_PC[m[1].toUpperCase()];
  if (pc == null) return fallbackMidi;
  const acc = m[2];
  if (acc === '#' || acc === '♯') pc = (pc + 1) % 12;
  if (acc === 'b' || acc === '♭') pc = (pc + 11) % 12;
  const oct = m[3] != null ? Number(m[3]) : 4;
  return (oct + 1) * 12 + pc;
}

/**
 * MIDI → 지정 포지션 박스 안 최적 (string, fret)
 * 박스: 루트 프렛 기준으로 -1 ~ +4 (약 한 포지션 폭)
 */
function midiToPositionTab(midi, position) {
  const centerFret = position.fret;
  const minF = Math.max(0, centerFret - 2);
  const maxF = Math.min(15, centerFret + 5);
  const preferString = position.string;

  const candidates = [];
  for (let string = 1; string <= 6; string++) {
    const fret = midi - OPEN_MIDI[string - 1];
    if (fret < 0 || fret > 15) continue;
    let score = 0;
    // 포지션 프렛 범위 안
    if (fret >= minF && fret <= maxF) score += 40;
    else score -= Math.abs(fret - centerFret) * 3;
    // 루트 현 근처 선호 (멜로디는 주로 1~4현)
    score -= Math.abs(string - preferString) * 4;
    if (string <= 4) score += 6;
    // 같은 MIDI면 센터에 가까운 프렛
    score -= Math.abs(fret - centerFret) * 1.5;
    // 너무 높은 프렛 페널티
    if (fret > 12) score -= 8;
    candidates.push({ string, fret, score });
  }

  if (!candidates.length) {
    // 폴백: 1현
    const fret = Math.max(0, Math.min(15, midi - OPEN_MIDI[0]));
    return { string: 1, fret: fret };
  }

  candidates.sort((a, b) => b.score - a.score);
  return { string: candidates[0].string, fret: candidates[0].fret };
}

/**
 * 스코어의 모든 이벤트를 조성 포지션 운지로 재배치
 * 이벤트에 pitch/note/midi가 있으면 그걸 쓰고, 없으면 기존 string/fret → MIDI
 */
function remapScoreToKeyPosition(score) {
  if (!score?.measures?.length) return score;
  const position = getPositionForKey(score.key);
  const measures = score.measures.map((m) => {
    const events = (m.events || []).map((ev) => {
      const fromTab =
        ev.string != null && ev.fret != null
          ? midiFromTab(Number(ev.string), Number(ev.fret))
          : null;
      const midi = parsePitchToMidi(
        ev.pitch ?? ev.note ?? ev.midi ?? ev.n,
        fromTab,
      );
      if (midi == null || !Number.isFinite(midi)) {
        return {
          string: Math.max(1, Math.min(6, Number(ev.string) || 1)),
          fret: Math.max(0, Math.min(24, Number(ev.fret) || 0)),
          beat: Number(ev.beat) || 0,
        };
      }
      const tab = midiToPositionTab(midi, position);
      return {
        string: tab.string,
        fret: tab.fret,
        beat: Number(ev.beat ?? ev.b) || 0,
      };
    });
    return { events };
  });

  return {
    ...score,
    measures,
    positionLabel: position.label,
    positionRoot: position.root,
  };
}

function positionPromptBlock() {
  return `운지 포지션 (반드시 준수 — 해당 조성의 스케일 박스에서만 집기):
- C장조: 5프렛 · 위에서 3번째 줄(G현)=도(C) 기준 스케일
- D장조: 7프렛 · 3번째 줄=레(D) 기준
- E장조: 9프렛 · 3번째 줄=미(E) 기준
- F장조: 6프렛 · 2번째 줄(B현)=파(F) 기준
- G장조: 8프렛 · 2번째 줄=솔(G) 기준
- A장조: 10프렛 · 2번째 줄=라(A) 기준
- 단조도 같은 뿌리음 포지션 (Em→E 9프렛 3현, Am→A 10프렛 2현)
- 프렛은 대체로 루트±2~5 범위. 0프렛·1현만으로 몰지 마세요.`;
}

module.exports = {
  OPEN_MIDI,
  POSITION_BY_ROOT,
  parseKeyRoot,
  getPositionForKey,
  midiFromTab,
  parsePitchToMidi,
  midiToPositionTab,
  remapScoreToKeyPosition,
  positionPromptBlock,
};
