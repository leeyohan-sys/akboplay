/**
 * Gemini로 유튜브 후보 중 최적 영상을 고릅니다.
 * 우선: 한국 대표 워십팀 → 없으면 조회수·인지도 높은 버전
 */

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 후보를 Gemini용 짧은 목록으로 정리 */
function slimCandidates(candidates, limit = 12) {
  const seen = new Set();
  const list = [];
  for (const v of candidates || []) {
    const id = String(v?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      title: String(v.title || '').slice(0, 120),
      channel: String(v.channel?.name || v.channel || '').slice(0, 80),
      views: Number(v.views) || 0,
    });
    if (list.length >= limit) break;
  }
  return list;
}

function parsePicksJson(raw, expectedIds) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item) => ({
        songId: String(item?.songId ?? item?.id ?? '').trim(),
        videoId: String(item?.videoId || '').trim(),
        reason: String(item?.reason || '').trim(),
      }))
      .filter((p) => p.songId && p.videoId && expectedIds.has(p.videoId));
  } catch {
    return [];
  }
}

/**
 * 여러 곡의 후보 목록을 한 번에 보내 최적 videoId를 고름
 * @param {Array<{ songId: string, title: string, key?: string, candidates: object[] }>} jobs
 * @returns {Promise<Map<string, string>>} songId → videoId
 */
async function pickVideosWithGemini(jobs) {
  const result = new Map();
  if (!isConfigured() || !Array.isArray(jobs) || jobs.length === 0) {
    return result;
  }

  const payload = jobs
    .map((j) => ({
      songId: String(j.songId),
      title: String(j.title || '').trim(),
      key: j.key || '',
      candidates: slimCandidates(j.candidates),
    }))
    .filter((j) => j.title && j.candidates.length > 0);

  if (payload.length === 0) return result;

  const allowedIds = new Set(
    payload.flatMap((j) => j.candidates.map((c) => c.id)),
  );

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const apiKey = process.env.GEMINI_API_KEY.trim();
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelNames = [
    'gemini-flash-latest',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
  ];

  const prompt = `당신은 한국 교회 찬양 유튜브 큐레이터입니다.
각 곡마다 후보 영상 중 **하나만** 고르세요.

우선순위(반드시 이 순서):
1) 한국의 대표 워십팀이 연주/인도한 영상 우선
   - 마커스워십(Marcus Worship), 피아워십(FIA), 위러브(WELOVE), 어노인팅(Anointing)
   - 그 외 잘 알려진 한국 워십팀(아이자야씩스티원, 제이어스, 예수전도단 등)
2) 대표 워십팀 버전이 없거나 곡과 맞지 않으면, 조회수(views)가 높고 인지도 있는 버전
3) 곡 제목과 관련 없는 영상, 다른 곡, 단순 반주/MR만 있는 영상은 피하세요.
4) 후보에 없는 videoId는 만들지 마세요.

입력(JSON):
${JSON.stringify(payload)}

출력: 설명 없이 JSON 배열만.
예: [{"songId":"...","videoId":"...","reason":"피아워십 라이브"}]`;

  let lastError = null;
  for (const modelName of modelNames) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
          },
        });

        console.log(
          `[gemini-yt] 추천 요청 · model=${modelName} · songs=${payload.length} · try=${attempt + 1}`,
        );

        const response = await Promise.race([
          model.generateContent(prompt),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('gemini-yt-timeout')), 45000),
          ),
        ]);

        const rawText = response?.response?.text?.() || '';
        const picks = parsePicksJson(rawText, allowedIds);
        for (const p of picks) {
          result.set(p.songId, p.videoId);
        }

        if (result.size > 0) {
          console.log(
            `[gemini-yt] ${result.size}/${payload.length}곡 선택 · ${modelName}`,
          );
          return result;
        }

        console.warn('[gemini-yt] 파싱 실패:', rawText.slice(0, 200));
        break;
      } catch (err) {
        lastError = err;
        const msg = String(err.message || err);
        console.warn(`[gemini-yt] ${modelName} 실패:`, msg.slice(0, 160));
        if (/429|quota|rate/i.test(msg) && attempt === 0) {
          await sleep(2500);
          continue;
        }
        break;
      }
    }
  }

  if (lastError) {
    console.warn(
      '[gemini-yt] 최종 실패:',
      String(lastError.message || lastError).slice(0, 180),
    );
  }
  return result;
}

module.exports = {
  pickVideosWithGemini,
  slimCandidates,
};
