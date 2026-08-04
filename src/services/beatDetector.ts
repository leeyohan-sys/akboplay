/**
 * 마이크 비트 탐지 + 탭 템포
 * liveBPM(com.DanielBach.liveBPM) 참고:
 * - 강한 리듬(킥/스네어) 중심 onset
 * - 60~200 BPM, 0.1 단위
 * - 절반/배수 모호성 해소
 * - 가이드(목표) 템포로 초점 고정
 */

export type BeatDetectorCallbacks = {
  /** 안정화된 BPM (소수 1자리) */
  onBpm?: (bpm: number) => void;
  /** 에너지 onset (메트로놈 위상 동기화용) */
  onOnset?: (timeMs: number, bpm: number) => void;
  onLevel?: (level: number) => void;
  /** 탐지 안정성 0~1 */
  onConfidence?: (confidence: number) => void;
  onError?: (message: string) => void;
};

export type BeatDetectorHandle = {
  stop: () => void;
  /** 가이드 템포 설정 (0이면 해제). 자동감지 초점을 고정 */
  setGuideBpm: (bpm: number) => void;
  getGuideBpm: () => number;
};

const MIN_BPM = 60;
const MAX_BPM = 200;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

function clampBpmRange(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

/** 간격들이 해당 BPM 격자에 얼마나 맞는지 점수 */
function scoreBpmCandidate(intervalsMs: number[], bpm: number): number {
  if (bpm <= 0 || intervalsMs.length === 0) return -Infinity;
  const period = 60000 / bpm;
  let score = 0;
  for (const iv of intervalsMs) {
    // 4/4·3/4 계열 배수까지 허용
    const multiples = [0.5, 1, 1.5, 2, 3, 4];
    let bestErr = Infinity;
    for (const m of multiples) {
      const err = Math.abs(iv - period * m) / (period * m);
      if (err < bestErr) bestErr = err;
    }
    if (bestErr < 0.1) score += 1 - bestErr / 0.1;
    else if (bestErr < 0.16) score += 0.25;
    else score -= 0.4;
  }
  // liveBPM 권장 밴드 가중
  if (bpm >= 70 && bpm <= 140) score += 0.45;
  else if (bpm >= 60 && bpm <= 180) score += 0.15;
  else score -= 0.25;
  return score;
}

/**
 * onset 시각 배열로 자기상관 BPM 후보 추출 (liveBPM식 안정성)
 */
function bpmFromAutocorr(onsetTimesMs: number[]): number[] {
  if (onsetTimesMs.length < 4) return [];
  const start = onsetTimesMs[0];
  const end = onsetTimesMs[onsetTimesMs.length - 1];
  const span = end - start;
  if (span < 1200) return [];

  // 10ms 해상도 임펄스 트레인
  const step = 10;
  const n = Math.min(4000, Math.ceil(span / step) + 1);
  const train = new Float32Array(n);
  for (const t of onsetTimesMs) {
    const i = Math.round((t - start) / step);
    if (i >= 0 && i < n) train[i] += 1;
  }

  const minLag = Math.round(60000 / MAX_BPM / step); // 200BPM
  const maxLag = Math.round(60000 / MIN_BPM / step); // 60BPM
  const scores: { lag: number; score: number }[] = [];

  for (let lag = minLag; lag <= Math.min(maxLag, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += train[i] * train[i + lag];
    scores.push({ lag, score: s });
  }
  scores.sort((a, b) => b.score - a.score);

  const out: number[] = [];
  for (const { lag, score } of scores.slice(0, 8)) {
    if (score <= 0) continue;
    const bpm = roundBpm(clampBpmRange(60000 / (lag * step)));
    if (!out.includes(bpm)) out.push(bpm);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 원시 간격 → 절반/배수·가이드 보정 BPM (소수 1자리)
 */
export function stabilizeBpm(
  intervalsMs: number[],
  previousBpm = 0,
  guideBpm = 0,
  onsetTimesMs: number[] = [],
): number {
  if (intervalsMs.length < 2) return previousBpm || 0;
  const med = median(intervalsMs);
  if (med <= 0) return previousBpm || 0;

  const raw = 60000 / med;
  const candidates = new Set<number>();
  for (const factor of [0.5, 1, 2]) {
    const b = roundBpm(raw * factor);
    if (b >= MIN_BPM && b <= MAX_BPM) candidates.add(b);
  }
  for (const b of bpmFromAutocorr(onsetTimesMs)) candidates.add(b);

  if (previousBpm >= MIN_BPM && previousBpm <= MAX_BPM) {
    candidates.add(roundBpm(previousBpm));
    candidates.add(roundBpm(previousBpm / 2));
    candidates.add(roundBpm(previousBpm * 2));
  }
  if (guideBpm >= MIN_BPM && guideBpm <= MAX_BPM) {
    candidates.add(roundBpm(guideBpm));
    candidates.add(roundBpm(guideBpm / 2));
    candidates.add(roundBpm(guideBpm * 2));
  }

  let best = roundBpm(clampBpmRange(raw));
  let bestScore = -Infinity;
  for (const bpm of candidates) {
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
    let s = scoreBpmCandidate(intervalsMs, bpm);
    if (previousBpm > 0) {
      const rel = Math.abs(bpm - previousBpm) / previousBpm;
      if (rel < 0.03) s += 0.7;
      else if (rel < 0.06) s += 0.3;
      else if (rel < 0.1) s += 0.1;
      // 갑자기 절반/배수로 튀는 것 억제 (가이드 없을 때)
      const isHalfOrDouble =
        Math.abs(bpm * 2 - previousBpm) <= 2.5 ||
        Math.abs(bpm - previousBpm * 2) <= 2.5;
      if (isHalfOrDouble && guideBpm <= 0 && previousBpm >= 70 && previousBpm <= 140) {
        if (!(bpm >= 70 && bpm <= 140)) s -= 0.85;
      }
    }
    // liveBPM Guided Auto-Detect
    if (guideBpm > 0) {
      const gRel = Math.abs(bpm - guideBpm) / guideBpm;
      if (gRel < 0.025) s += 1.8;
      else if (gRel < 0.05) s += 1.0;
      else if (gRel < 0.09) s += 0.35;
      else s -= 0.65;
    }
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return best;
}

/** 탭 시각 배열 → BPM (소수 1자리). 최근 탭만 사용 */
export function bpmFromTapTimes(tapTimesMs: number[]): number {
  if (tapTimesMs.length < 2) return 0;
  const recent = tapTimesMs.slice(-9);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const iv = recent[i] - recent[i - 1];
    if (iv >= 200 && iv <= 2000) intervals.push(iv);
  }
  if (intervals.length === 0) return 0;
  return roundBpm(60000 / median(intervals));
}

/** 목표 대비 드리프트 (현재 - 목표) */
export function tempoDrift(currentBpm: number, targetBpm: number): number {
  if (currentBpm <= 0 || targetBpm <= 0) return 0;
  return roundBpm(currentBpm - targetBpm);
}

export function isBeatDetectorSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return false;
  }
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return typeof (w.AudioContext || w.webkitAudioContext) === 'function';
}

/**
 * 마이크를 열고 실시간으로 onset·BPM을 추적합니다.
 * liveBPM 스타일: 다대역 spectral flux + 적응 임계 + 자기상관 보강
 */
export async function startBeatDetector(
  callbacks: BeatDetectorCallbacks = {},
): Promise<BeatDetectorHandle> {
  if (!isBeatDetectorSupported()) {
    throw new Error(
      '이 환경에서는 마이크 비트 탐지를 지원하지 않습니다. 모바일/PC 웹에서 시도해 주세요.',
    );
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const ctx = new AudioCtx({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  // FFT로 스펙트럼 분석 (liveBPM 설명의 FFT 분석에 해당)
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);

  const bins = analyser.frequencyBinCount;
  const freq = new Float32Array(bins);
  const prevFreq = new Float32Array(bins);
  const intervals: number[] = [];
  const onsetTimes: number[] = [];
  const fluxHistory: number[] = [];

  let lastOnsetMs = 0;
  let bpm = 0;
  let guideBpm = 0;
  let pendingBpm = 0;
  let pendingCount = 0;
  let confidence = 0;
  let raf = 0;
  let stopped = false;
  let hasPrev = false;

  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  // 킥(~40–160Hz) + 스네어/퍼커션(~160–2500Hz) 가중
  const kickLo = Math.max(1, Math.floor(40 / hzPerBin));
  const kickHi = Math.min(bins - 1, Math.ceil(160 / hzPerBin));
  const percLo = kickHi;
  const percHi = Math.min(bins - 1, Math.ceil(2500 / hzPerBin));

  const publishBpm = (next: number, conf: number) => {
    if (next <= 0) return;
    const rounded = roundBpm(clampBpmRange(next));
    if (rounded === pendingBpm) pendingCount += 1;
    else {
      pendingBpm = rounded;
      pendingCount = 1;
    }
    // 초기는 빠르게, 이후엔 안정화 후 갱신 (liveBPM처럼 튀지 않게)
    const need = bpm > 0 ? (conf > 0.55 ? 2 : 3) : 1;
    if (pendingCount < need) return;
    if (Math.abs(bpm - rounded) < 0.05) {
      confidence = Math.max(confidence, conf);
      callbacks.onConfidence?.(confidence);
      return;
    }
    if (bpm > 0) {
      const rel = Math.abs(rounded - bpm) / bpm;
      if (rel < 0.012) return;
      const isHalfOrDouble =
        Math.abs(rounded * 2 - bpm) <= 3 || Math.abs(rounded - bpm * 2) <= 3;
      if (!isHalfOrDouble && rel < 0.06 && pendingCount < 3) return;
      if (isHalfOrDouble && guideBpm <= 0 && pendingCount < 4 && conf < 0.6) return;
    }
    bpm = rounded;
    confidence = conf;
    callbacks.onBpm?.(bpm);
    callbacks.onConfidence?.(confidence);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
  };

  const bandFlux = (lo: number, hi: number, weight: number) => {
    let s = 0;
    for (let i = lo; i < hi; i++) {
      const d = freq[i] - prevFreq[i];
      if (d > 0) s += d * weight;
    }
    return s / Math.max(1, hi - lo);
  };

  const tick = () => {
    if (stopped) return;
    analyser.getFloatFrequencyData(freq);
    // dB(-100~0) → 대략 0~1 선형화
    for (let i = 0; i < bins; i++) {
      freq[i] = Math.max(0, (freq[i] + 100) / 100);
    }

    if (!hasPrev) {
      prevFreq.set(freq);
      hasPrev = true;
      raf = requestAnimationFrame(tick);
      return;
    }

    const kickFlux = bandFlux(kickLo, kickHi, 1.6);
    const percFlux = bandFlux(percLo, percHi, 1.0);
    const flux = kickFlux * 0.62 + percFlux * 0.38;

    // 레벨 미터 (킥 비중)
    const level =
      kickFlux * 0.7 + percFlux * 0.3;
    callbacks.onLevel?.(Math.min(1, level / 0.08));

    fluxHistory.push(flux);
    if (fluxHistory.length > 60) fluxHistory.shift();
    const avgFlux = mean(fluxHistory);
    const sorted = [...fluxHistory].sort((a, b) => a - b);
    const p70 = sorted[Math.floor(sorted.length * 0.7)] || avgFlux;
    // 적응 임계: 평균·상위 백분위 기반 (부드러운 곡도 어느 반응)
    const threshold = Math.max(0.012, avgFlux * 1.35, p70 * 1.12);

    const now = performance.now();
    const refBpm = guideBpm > 0 ? guideBpm : bpm;
    // 리프랙토리: 현재/가이드 BPM의 약 1/2.5 박
    const refractory =
      refBpm > 0 ? Math.max(180, 60000 / refBpm / 2.5) : 230;

    const rising =
      fluxHistory.length >= 3 &&
      flux > fluxHistory[fluxHistory.length - 2] &&
      fluxHistory[fluxHistory.length - 2] >= fluxHistory[fluxHistory.length - 3];

    if (flux > threshold && rising && now - lastOnsetMs > refractory) {
      if (lastOnsetMs > 0) {
        const interval = now - lastOnsetMs;
        // 60~200 BPM 한 박 + 배수 여유
        if (interval >= 280 && interval <= 1600) {
          intervals.push(interval);
          if (intervals.length > 24) intervals.shift();
          onsetTimes.push(now);
          if (onsetTimes.length > 48) onsetTimes.shift();

          if (intervals.length >= 2) {
            const next = stabilizeBpm(intervals, bpm, guideBpm, onsetTimes);
            // 간격 일관성으로 confidence
            const period = 60000 / Math.max(next, 1);
            let hits = 0;
            for (const iv of intervals.slice(-12)) {
              const err = Math.min(
                Math.abs(iv - period),
                Math.abs(iv - period * 2),
                Math.abs(iv - period * 0.5),
              );
              if (err / period < 0.12) hits += 1;
            }
            const conf = Math.min(1, hits / Math.max(4, Math.min(12, intervals.length)));
            publishBpm(next, conf);
          }
        }
      }
      lastOnsetMs = now;
      callbacks.onOnset?.(now, bpm);
    }

    prevFreq.set(freq);
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    stop,
    setGuideBpm: (g: number) => {
      guideBpm = g > 0 ? roundBpm(clampBpmRange(g)) : 0;
    },
    getGuideBpm: () => guideBpm,
  };
}
