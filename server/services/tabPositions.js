/**
 * 조성별 기타 스케일 포지션 (사용자 지정)
 * string: 1=고음 e … 6=저음 E
 *
 * C: 5프렛 · 3현 = 도(C)  → 프렛 박스 4~9
 * D: 7프렛 · 3현 = 레(D)  → 6~11
 * E: 9프렛 · 3현 = 미(E)  → 8~13
 * F: 6프렛 · 2현 = 파(F)  → 5~10
 * G: 8프렛 · 2현 = 솔(G)  → 7~12
 * A: 10프렛 · 2현 = 라(A) → 9~14
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

/** 조성 루트 → 포지션 (개방현 금지, 박스만 사용) */
const POSITION_BY_ROOT = {
  C: {
    string: 3,
    fret: 5,
    minFret: 4,
    maxFret: 9,
    label: 'C · 5프렛 3현(도)',
  },
  D: {
    string: 3,
    fret: 7,
    minFret: 6,
    maxFret: 11,
    label: 'D · 7프렛 3현(레)',
  },
  E: {
    string: 3,
    fret: 9,
    minFret: 8,
    maxFret: 13,
    label: 'E · 9프렛 3현(미)',
  },
  F: {
    string: 2,
    fret: 6,
    minFret: 5,
    maxFret: 10,
    label: 'F · 6프렛 2현(파)',
  },
  G: {
    string: 2,
    fret: 8,
    minFret: 7,
    maxFret: 12,
    label: 'G · 8프렛 2현(솔)',
  },
  A: {
    string: 2,
    fret: 10,
    minFret: 9,
    maxFret: 14,
    label: 'A · 10프렛 2현(라)',
  },
  B: {
    string: 2,
    fret: 12,
    minFret: 10,
    maxFret: 15,
    label: 'B · 12프렛 2현',
  },
};

/**
 * "E", "Em", "E major", "마장조", "Bb" 등 → 루트 문자
 */
function parseKeyRoot(keyRaw) {
  const s = String(keyRaw || '').trim();
  if (!s) return null;

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
    if (s.includes(`${k}장조`) || s.includes(`${k}단조`)) return v;
  }

  const m = s.match(/^([A-Ga-g])([#♯b♭]?)/);
  if (!m) return null;
  let root = m[1].toUpperCase();
  const acc = m[2];
  if (acc === '#' || acc === '♯') {
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

function pitchClass(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
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
 * MIDI → 포지션 박스 안에서만 운지 (개방현 금지)
 * 같은 음이름(피치클래스)을 박스 내에서 찾고, 원래 음고에 가장 가까운 옥타브 선택
 */
function midiToPositionTab(midi, position) {
  const minF = position.minFret ?? Math.max(0, position.fret - 1);
  const maxF = position.maxFret ?? Math.min(15, position.fret + 4);
  const preferString = position.string;
  const targetPc = pitchClass(midi);

  const candidates = [];
  for (let string = 1; string <= 6; string++) {
    for (let fret = minF; fret <= maxF; fret++) {
      const m = OPEN_MIDI[string - 1] + fret;
      if (pitchClass(m) !== targetPc) continue;
      let score = 100;
      // 원래 음고에 가까운 옥타브
      score -= Math.abs(m - midi) * 2;
      // 루트 현·프렛 근처
      score -= Math.abs(string - preferString) * 5;
      score -= Math.abs(fret - position.fret) * 2;
      // 멜로디는 윗줄(1~4현) 선호
      if (string <= 4) score += 8;
      if (string >= 5) score -= 6;
      candidates.push({ string, fret, midi: m, score });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    return { string: candidates[0].string, fret: candidates[0].fret };
  }

  // 박스에 피치클래스가 없으면(이론상 드묾) 센터 프렛 근처로 폴백
  const fret = Math.max(minF, Math.min(maxF, midi - OPEN_MIDI[preferString - 1]));
  if (fret >= minF && fret <= maxF) {
    return { string: preferString, fret };
  }
  return { string: preferString, fret: position.fret };
}

/**
 * 스코어의 모든 이벤트를 조성 포지션 운지로 재배치
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
        // 음고를 모르면 루트 포지션으로라도 밀어 넣음 (개방현 방지)
        return {
          string: position.string,
          fret: position.fret,
          beat: Number(ev.beat ?? ev.b) || 0,
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
  return `운지 포지션 (서버가 최종 확정 — 반드시 이 박스 프렛만 사용, 개방현 0~3 금지):
- C장조: 5프렛 · 3현(G)=도 → 프렛 4~9만
- D장조: 7프렛 · 3현=레 → 프렛 6~11만
- E장조: 9프렛 · 3현=미 → 프렛 8~13만
- F장조: 6프렛 · 2현(B)=파 → 프렛 5~10만
- G장조: 8프렛 · 2현=솔 → 프렛 7~12만
- A장조: 10프렛 · 2현=라 → 프렛 9~14만
- 단조도 같은 뿌리음 포지션 (Em→E, Am→A)`;
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
