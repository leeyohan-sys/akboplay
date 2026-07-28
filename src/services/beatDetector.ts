/**
 * 마이크 입력으로 비트(onset)를 추적하고 BPM을 안정적으로 추정합니다.
 * Web Audio API 기반 (웹 / Expo Web)
 *
 * - 간격 중앙값 → 절반/배수 후보 점수화
 * - 체감 템포 대역(약 70~120) 가중
 * - 연속 일치 시에만 BPM 확정 (깜빡임 방지)
 * - 점멸은 UI 쪽 BPM 타이머가 담당, 여기는 onset으로 위상만 맞춤
 */

export type BeatDetectorCallbacks = {
  /** 안정화된 BPM이 바뀔 때 */
  onBpm?: (bpm: number) => void;
  /** 에너지 onset (메트로놈 위상 동기화용) */
  onOnset?: (timeMs: number, bpm: number) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
};

export type BeatDetectorHandle = {
  stop: () => void;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** 간격들이 해당 BPM 격자에 얼마나 맞는지 점수 (높을수록 좋음) */
function scoreBpmCandidate(intervalsMs: number[], bpm: number): number {
  if (bpm <= 0 || intervalsMs.length === 0) return -Infinity;
  const period = 60000 / bpm;
  let score = 0;
  for (const iv of intervalsMs) {
    // 1박·2박·1/2박 배수와의 오차
    const multiples = [0.5, 1, 2, 3, 4];
    let bestErr = Infinity;
    for (const m of multiples) {
      const err = Math.abs(iv - period * m) / (period * m);
      if (err < bestErr) bestErr = err;
    }
    // 12% 이내면 가점, 멀수록 감점
    if (bestErr < 0.12) score += 1 - bestErr / 0.12;
    else score -= 0.35;
  }
  // 체감 BPM 대역 가중 (너무 빠르거나 느린 후보는 감점)
  if (bpm >= 70 && bpm <= 120) score += 0.55;
  else if (bpm >= 60 && bpm <= 140) score += 0.2;
  else if (bpm > 160 || bpm < 55) score -= 0.4;
  return score;
}

/**
 * 원시 간격 → 절반/배수 보정된 BPM
 */
export function stabilizeBpm(intervalsMs: number[], previousBpm = 0): number {
  if (intervalsMs.length < 2) return previousBpm || 0;
  const med = median(intervalsMs);
  if (med <= 0) return previousBpm || 0;

  const raw = 60000 / med;
  const candidates = new Set<number>();
  for (const factor of [0.5, 1, 2]) {
    const b = Math.round(raw * factor);
    if (b >= 50 && b <= 180) candidates.add(b);
  }
  // 이전 BPM 근처도 후보에 넣어 흔들림 완화
  if (previousBpm >= 50 && previousBpm <= 180) {
    candidates.add(previousBpm);
    candidates.add(Math.round(previousBpm / 2));
    candidates.add(previousBpm * 2);
  }

  let best = Math.round(raw);
  let bestScore = -Infinity;
  for (const bpm of candidates) {
    if (bpm < 50 || bpm > 180) continue;
    let s = scoreBpmCandidate(intervalsMs, bpm);
    // 이전 값과 비슷하면 가점 (잦은 점프 억제)
    if (previousBpm > 0) {
      const rel = Math.abs(bpm - previousBpm) / previousBpm;
      if (rel < 0.04) s += 0.45;
      else if (rel < 0.08) s += 0.15;
      // 정확히 절반/배수면 이전과 동일 템포로 간주해 유지 쪽으로
      if (
        Math.abs(bpm * 2 - previousBpm) <= 2 ||
        Math.abs(bpm - previousBpm * 2) <= 2
      ) {
        // 새 후보가 체감 대역이면 전환, 아니면 이전 유지 유도
        if (!(bpm >= 70 && bpm <= 120) && previousBpm >= 70 && previousBpm <= 120) {
          s -= 0.6;
        }
      }
    }
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return best;
}

/** 브라우저에서 마이크 beat detector 지원 여부 */
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
 * @returns stop() 핸들
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

  const ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.35;
  source.connect(analyser);

  const freq = new Uint8Array(analyser.frequencyBinCount);
  const intervals: number[] = [];
  let lastOnsetMs = 0;
  let bpm = 0;
  let pendingBpm = 0;
  let pendingCount = 0;
  let energyHistory: number[] = [];
  let raf = 0;
  let stopped = false;

  const publishBpm = (next: number) => {
    if (next <= 0) return;
    // 같은 후보가 2회 연속일 때만 확정 (안정화)
    if (next === pendingBpm) {
      pendingCount += 1;
    } else {
      pendingBpm = next;
      pendingCount = 1;
    }
    if (pendingCount < 2 && bpm > 0) return;
    if (bpm === next) return;
    // 급변 완화: 기존 BPM과 8% 이상 차이날 때만, 또는 첫 확정
    if (bpm > 0) {
      const rel = Math.abs(next - bpm) / bpm;
      if (rel < 0.05) return;
      // 절반/배수 전환은 허용
      const isHalfOrDouble =
        Math.abs(next * 2 - bpm) <= 3 || Math.abs(next - bpm * 2) <= 3;
      if (!isHalfOrDouble && rel < 0.12 && pendingCount < 3) return;
    }
    bpm = next;
    callbacks.onBpm?.(bpm);
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

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(freq);

    // 저~중역(킥·스네어) 에너지 위주로 onset 감지
    let sum = 0;
    const lo = 1;
    const hi = Math.min(48, freq.length);
    for (let i = lo; i < hi; i++) sum += freq[i];
    const energy = sum / (hi - lo);
    callbacks.onLevel?.(Math.min(1, energy / 180));

    energyHistory.push(energy);
    if (energyHistory.length > 48) energyHistory.shift();
    const avg =
      energyHistory.reduce((a, b) => a + b, 0) / Math.max(1, energyHistory.length);
    const threshold = Math.max(28, avg * 1.28);

    const now = performance.now();
    // 확정 BPM 기준 refractory (더블 트리거 방지)
    const refractory = bpm > 0 ? Math.max(220, 60000 / bpm / 2.4) : 260;
    const rising =
      energyHistory.length >= 3 &&
      energy > energyHistory[energyHistory.length - 2] &&
      energyHistory[energyHistory.length - 2] >=
        energyHistory[energyHistory.length - 3];

    if (energy > threshold && rising && now - lastOnsetMs > refractory) {
      if (lastOnsetMs > 0) {
        const interval = now - lastOnsetMs;
        // 40~200 BPM에 해당하는 간격만 수집
        if (interval >= 300 && interval <= 1500) {
          intervals.push(interval);
          if (intervals.length > 16) intervals.shift();
          if (intervals.length >= 3) {
            const stabilized = stabilizeBpm(intervals, bpm);
            publishBpm(stabilized);
          }
        }
      }
      lastOnsetMs = now;
      callbacks.onOnset?.(now, bpm);
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return { stop };
}
