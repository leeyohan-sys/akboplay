/**
 * 악보에서 읽은 조성(Key) 정규화 · 유튜브 검색용 표기
 * 예: "G", "Gm", "Bb", "E♭" → 검색어 "G키", "Gm키", "Bb키"
 */

function normalizeMusicKey(raw) {
  if (raw == null) return undefined;
  let s = String(raw)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^key[:：]?/i, '')
    .replace(/키$/i, '')
    .replace(/major$/i, '')
    .replace(/minor$/i, 'm')
    .replace(/maj$/i, '')
    .replace(/min$/i, 'm')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b');

  if (!s) return undefined;

  // Capo 3 같은 값은 무시
  if (/^capo/i.test(s) || /^\d+$/.test(s)) return undefined;

  const m = s.match(/^([A-Ga-g])([#b]?)(m)?$/);
  if (!m) return undefined;

  const note = m[1].toUpperCase() + (m[2] || '');
  const minor = m[3] ? 'm' : '';
  return `${note}${minor}`;
}

/** 유튜브 검색용: "G키" */
function formatKeyForSearch(raw) {
  const k = normalizeMusicKey(raw);
  if (!k) return undefined;
  return `${k}키`;
}

module.exports = {
  normalizeMusicKey,
  formatKeyForSearch,
};
