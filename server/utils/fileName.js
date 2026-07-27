/**
 * multipart 업로드 파일명 한글 복원
 * busboy/multer는 UTF-8 바이트를 latin1로 읽는 경우가 많음
 */
function decodeUploadFileName(raw, fallback = 'score.pdf') {
  const name = String(raw || '').trim();
  if (!name) return fallback;

  const candidates = [name];

  // 1) latin1 → utf8 (가장 흔한 깨짐: íì … → 헌신…)
  try {
    candidates.push(Buffer.from(name, 'latin1').toString('utf8'));
  } catch {
    // ignore
  }

  // 2) percent-encoding
  try {
    if (/%[0-9A-Fa-f]{2}/.test(name)) {
      candidates.push(decodeURIComponent(name));
    }
  } catch {
    // ignore
  }

  // 3) URI escape 후 unescape 패턴
  try {
    candidates.push(decodeURIComponent(escape(name)));
  } catch {
    // ignore
  }

  const score = (s) => {
    const hangul = (s.match(/[가-힣]/g) || []).length;
    const mojibake = (s.match(/[ÃÂíìëê]/g) || []).length;
    const replacement = (s.match(/\uFFFD/g) || []).length;
    return hangul * 10 - mojibake * 3 - replacement * 5;
  };

  let best = name;
  let bestScore = score(name);
  for (const c of candidates) {
    if (!c || c.includes('\u0000')) continue;
    const sc = score(c);
    if (sc > bestScore) {
      best = c;
      bestScore = sc;
    }
  }

  // 제어문자 제거
  return best.replace(/[\u0000-\u001F\u007F]/g, '').trim() || fallback;
}

module.exports = {
  decodeUploadFileName,
};
