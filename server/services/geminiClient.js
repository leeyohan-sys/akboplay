/**
 * Gemini API 공통 클라이언트
 * - 요청 직렬화(동시 1개)
 * - 호출 간격 제한
 * - 429 시 지수 백오프 + 전역 쿨다운 (연쇄 폭주 방지)
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

/** 목록 조회 자체가 실패할 때만 쓰는 최후 폴백 (마지막 확인: 2026-09) */
const FALLBACK_MODEL_NAMES = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
];
/** 한 번에 시도할 후보 모델 수 (많을수록 안전하지만 최악의 경우 대기 시간 증가) */
const MODEL_CANDIDATE_COUNT = 4;
const MODEL_LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_LIST_TTL_MS = 6 * 60 * 60 * 1000; // 6시간마다 재조회
const MODEL_LIST_FETCH_TIMEOUT_MS = 8000;

let modelListCache = { names: null, fetchedAt: 0 };
let modelListInFlight = null;

function scoreModelName(name) {
  if (/-latest$/i.test(name)) return 0; // 별칭 — 구글이 알아서 최신 안정판을 가리킴
  if (/preview|exp(?:erimental)?/i.test(name)) return 2; // 프리뷰는 불안정하니 후순위
  return 1; // 고정 버전 안정 릴리스
}

/**
 * Google이 모델명을 자주 바꾸고 예고 없이 없애서(예: 2026-09에
 * gemini-2.0-flash* 전체 제거), 하드코딩 목록 대신 매번 실제 사용 가능한
 * 모델을 조회해 캐싱한다. 조회 실패 시 이전 캐시 → 최후 폴백 순으로 사용.
 */
async function fetchModelList() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch(`${MODEL_LIST_URL}?key=${apiKey}&pageSize=200`, {
      signal: AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const names = [
      ...new Set(
        (json.models || [])
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          // 이미지/음성 전용 변형은 텍스트+사진 JSON 추출 용도에 안 맞아 제외
          .filter((name) => /flash/i.test(name) && !/image|tts|audio|omni/i.test(name)),
      ),
    ];
    if (!names.length) return null;
    return names.sort((a, b) => scoreModelName(a) - scoreModelName(b));
  } catch (err) {
    console.warn('[gemini] 모델 목록 조회 실패:', err.message);
    return null;
  }
}

async function getModelNames() {
  const now = Date.now();
  if (modelListCache.names && now - modelListCache.fetchedAt < MODEL_LIST_TTL_MS) {
    return modelListCache.names;
  }
  if (!modelListInFlight) {
    modelListInFlight = fetchModelList().finally(() => {
      modelListInFlight = null;
    });
  }
  const fresh = await modelListInFlight;
  if (fresh) {
    modelListCache = { names: fresh, fetchedAt: now };
    return fresh;
  }
  // 조회 실패 — 오래된 캐시라도 있으면 그걸, 없으면 하드코딩 폴백
  return modelListCache.names || FALLBACK_MODEL_NAMES;
}

// 서버 기동 시 미리 한 번 조회 — 첫 실제 요청이 목록 조회 지연을 겪지 않도록
getModelNames().catch(() => {});

/** 무료 쿼터 기준: 호출 사이 최소 간격 */
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 8000);
/** 429 후 기본 대기 (초 단위로 늘어남) */
const BASE_BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS || 20000);
const MAX_BACKOFF_MS = 120000;
const MAX_RETRIES_PER_MODEL = 3;

let queue = Promise.resolve();
let lastCallAt = 0;
let cooldownUntil = 0;

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status || err?.statusCode;
  return status === 429 || /429|too many requests|quota|rate.?limit|resource.?exhausted/i.test(msg);
}

function isNotFoundModel(err) {
  const msg = String(err?.message || err || '');
  return /404|not found|no longer available|is not found/i.test(msg);
}

/** 에러 메시지에서 재시도 대기(초) 추출 */
function parseRetryAfterMs(err) {
  const msg = String(err?.message || err || '');
  const retryInfo = msg.match(/retryDelay["\s:]+"?(\d+(?:\.\d+)?)s/i);
  if (retryInfo) {
    return Math.ceil(Number(retryInfo[1]) * 1000);
  }
  const please = msg.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (please) {
    return Math.ceil(Number(please[1]) * 1000);
  }
  return null;
}

function backoffMs(attempt, err) {
  const fromApi = parseRetryAfterMs(err);
  if (fromApi) return Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, fromApi));
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 1500);
  return Math.min(MAX_BACKOFF_MS, exp + jitter);
}

async function waitCooldown(label) {
  const now = Date.now();
  if (cooldownUntil > now) {
    const wait = cooldownUntil - now;
    console.warn(`[gemini] 쿨다운 대기 ${Math.ceil(wait / 1000)}초 · ${label || ''}`);
    await sleep(wait);
  }
}

async function waitMinInterval() {
  const elapsed = Date.now() - lastCallAt;
  if (lastCallAt > 0 && elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
}

function setCooldown(ms) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

/** 모든 Gemini 호출을 한 줄로 직렬화 */
function enqueue(task) {
  const run = queue.then(task, task);
  // 이전 실패가 다음을 막지 않도록
  queue = run.catch(() => undefined);
  return run;
}

function makeRateLimitError(waitMs) {
  const sec = Math.max(1, Math.ceil((waitMs || 60000) / 1000));
  const err = new Error(
    `Gemini 요청이 많습니다. 약 ${sec}초 후 다시 시도해 주세요.`,
  );
  err.code = 'RATE_LIMIT';
  err.retryAfterMs = waitMs || 60000;
  return err;
}

/**
 * @param {object} opts
 * @param {string|Array} opts.contents - 문자열이면 텍스트 프롬프트, 배열이면 parts
 * @param {object} [opts.generationConfig]
 * @param {number} [opts.timeoutMs] - 단일 generateContent 호출 제한
 * @param {number} [opts.deadlineMs] - 전체(재시도 포함) 마감까지 남은 ms. 초과 대기면 RATE_LIMIT로 즉시 실패
 * @param {number} [opts.maxRetries] - 모델당 재시도 횟수 (기본 MAX_RETRIES_PER_MODEL)
 * @param {boolean} [opts.throwOnRateLimit] - 429 한도 시 null 대신 예외
 * @param {string} [opts.label]
 * @returns {Promise<null | { text: string, model: string }>}
 */
async function generateContent(opts) {
  if (!isConfigured()) return null;

  const {
    contents,
    generationConfig = { temperature: 0.1, maxOutputTokens: 4096 },
    timeoutMs = 60000,
    deadlineMs,
    maxRetries = MAX_RETRIES_PER_MODEL,
    throwOnRateLimit = false,
    label = 'gemini',
  } = opts || {};

  const startedAt = Date.now();
  const deadlineAt =
    typeof deadlineMs === 'number' && deadlineMs > 0
      ? startedAt + deadlineMs
      : null;

  return enqueue(async () => {
    const apiKey = process.env.GEMINI_API_KEY.trim();
    const genAI = new GoogleGenerativeAI(apiKey);

    const parts = Array.isArray(contents)
      ? contents
      : [{ text: String(contents || '') }];

    let lastError = null;
    const retries = Math.max(1, Number(maxRetries) || MAX_RETRIES_PER_MODEL);
    const modelNames = (await getModelNames()).slice(0, MODEL_CANDIDATE_COUNT);

    for (const modelName of modelNames) {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          // 마감이 임박하면 대기하지 않고 즉시 안내
          if (deadlineAt && Date.now() >= deadlineAt - 5000) {
            throw makeRateLimitError(cooldownUntil - Date.now());
          }

          await waitCooldown(label);
          await waitMinInterval();

          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig,
          });

          console.log(
            `[${label}] 요청 · model=${modelName} · try=${attempt + 1}`,
          );

          lastCallAt = Date.now();
          const callTimeout =
            deadlineAt != null
              ? Math.max(5000, Math.min(timeoutMs, deadlineAt - Date.now()))
              : timeoutMs;

          const result = await Promise.race([
            model.generateContent({
              contents: [{ role: 'user', parts }],
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('gemini-timeout')),
                callTimeout,
              ),
            ),
          ]);

          const text = result?.response?.text?.() || '';
          if (!text.trim()) {
            console.warn(`[${label}] 빈 응답 · ${modelName}`);
            break; // 다음 모델
          }

          return { text, model: modelName };
        } catch (err) {
          lastError = err;
          if (err?.code === 'RATE_LIMIT') {
            if (throwOnRateLimit) throw err;
            return null;
          }

          const msg = String(err.message || err);
          console.warn(`[${label}] ${modelName} 실패:`, msg.slice(0, 160));

          if (isRateLimitError(err)) {
            const wait = backoffMs(attempt, err);
            setCooldown(wait);
            console.warn(
              `[${label}] 429 · ${Math.ceil(wait / 1000)}초 후 재시도 (${attempt + 1}/${retries})`,
            );

            const remaining = deadlineAt ? deadlineAt - Date.now() : Infinity;
            // HTTP 타임아웃 전에 끝나지 못하면 기다리지 않고 안내
            if (wait + 20000 > remaining || attempt >= retries - 1) {
              console.warn(`[${label}] 쿼터 한도 — 재시도 포기`);
              const rl = makeRateLimitError(wait);
              if (throwOnRateLimit) throw rl;
              return null;
            }

            await sleep(wait);
            continue; // 같은 모델 재시도
          }

          if (isNotFoundModel(err)) {
            break; // 다음 모델
          }

          if (/timeout/i.test(msg)) {
            break;
          }

          // 기타 오류: 짧게 쉬고 다음 모델
          await sleep(1500);
          break;
        }
      }
    }

    if (lastError) {
      console.warn(
        `[${label}] 최종 실패:`,
        String(lastError.message || lastError).slice(0, 200),
      );
      if (throwOnRateLimit && isRateLimitError(lastError)) {
        throw makeRateLimitError(parseRetryAfterMs(lastError) || BASE_BACKOFF_MS);
      }
    }
    return null;
  });
}

module.exports = {
  isConfigured,
  generateContent,
  getModelNames,
  MIN_INTERVAL_MS,
};
