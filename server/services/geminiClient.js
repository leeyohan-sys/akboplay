/**
 * Gemini API 공통 클라이언트
 * - 요청 직렬화(동시 1개)
 * - 호출 간격 제한
 * - 429 시 지수 백오프 + 전역 쿨다운 (연쇄 폭주 방지)
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL_NAMES = [
  'gemini-flash-latest',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];

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

/**
 * @param {object} opts
 * @param {string|Array} opts.contents - 문자열이면 텍스트 프롬프트, 배열이면 parts
 * @param {object} [opts.generationConfig]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.label]
 * @returns {Promise<null | { text: string, model: string }>}
 */
async function generateContent(opts) {
  if (!isConfigured()) return null;

  const {
    contents,
    generationConfig = { temperature: 0.1, maxOutputTokens: 4096 },
    timeoutMs = 60000,
    label = 'gemini',
  } = opts || {};

  return enqueue(async () => {
    const apiKey = process.env.GEMINI_API_KEY.trim();
    const genAI = new GoogleGenerativeAI(apiKey);

    const parts = Array.isArray(contents)
      ? contents
      : [{ text: String(contents || '') }];

    let lastError = null;

    for (const modelName of MODEL_NAMES) {
      for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
        try {
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
          const result = await Promise.race([
            model.generateContent({
              contents: [{ role: 'user', parts }],
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('gemini-timeout')), timeoutMs),
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
          const msg = String(err.message || err);
          console.warn(`[${label}] ${modelName} 실패:`, msg.slice(0, 160));

          if (isRateLimitError(err)) {
            const wait = backoffMs(attempt, err);
            setCooldown(wait);
            console.warn(
              `[${label}] 429 · ${Math.ceil(wait / 1000)}초 후 재시도 (${attempt + 1}/${MAX_RETRIES_PER_MODEL})`,
            );
            // 마지막 재시도까지 실패하면 다른 모델로 연쇄 호출하지 않음 (같은 키 쿼터)
            if (attempt >= MAX_RETRIES_PER_MODEL - 1) {
              console.warn(`[${label}] 쿼터 한도 — 추가 모델 시도 중단`);
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
    }
    return null;
  });
}

module.exports = {
  isConfigured,
  generateContent,
  MODEL_NAMES,
  MIN_INTERVAL_MS,
};
