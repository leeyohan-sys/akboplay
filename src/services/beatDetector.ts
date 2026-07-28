/**
 * 마이크 비트 탐지 + 탭 템포 유틸
 * Live BPM(com.kottov.pulse) 스타일: 자동감지 / 가이드 / 탭템포
 */

export type BeatDetectorCallbacks = {
  /** 안정화된 BPM (소수 1자리) */
  onBpm?: (bpm: number) => void;
  /** 에너지 onset (메트로놈 위상 동기화용) */
  onOnset?: (timeMs: number, bpm: number) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
};

export type BeatDetectorHandle = {
  stop: () => void;
  /** 가이드 템포 설정 (0이면 해제). 자동감지 초점을 고정 */
  setGuideBpm: (bpm: number) => void;
  getGuideBpm: () => number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

/** 간격들이 해당 BPM 격자에 얼마나 맞는지 점수 */
function scoreBpmCandidate(intervalsMs: number[], bpm: number): number {
  if (bpm <= 0 || intervalsMs.length === 0) return -Infinity;
  const period = 60000 / bpm;
  let score = 0;
  for (const iv of intervalsMs) {
    const multiples = [0.5, 1, 2, 3, 4];
    let bestErr = Infinity;
    for (const m of multiples) {
      const err = Math.abs(iv - period * m) / (period * m);
      if (err < bestErr) bestErr = err;
    }
    if (bestErr < 0.12) score += 1 - bestErr / 0.12;
    else score -= 0.35;
  }
  if (bpm >= 70 && bpm <= 120) score += 0.55;
  else if (bpm >= 60 && bpm <= 140) score += 0.2;
  else if (bpm > 160 || bpm < 55) score -= 0.4;
  return score;
}

/**
 * 원시 간격 → 절반/배수·가이드 보정 BPM (소수 1자리)
 */
export function stabilizeBpm(
  intervalsMs: number[],
  previousBpm = 0,
  guideBpm = 0,
): number {
  if (intervalsMs.length < 2) return previousBpm || 0;
  const med = median(intervalsMs);
  if (med <= 0) return previousBpm || 0;

  const raw = 60000 / med;
  const candidates = new Set<number>();
  for (const factor of [0.5, 1, 2]) {
    const b = roundBpm(raw * factor);
    if (b >= 50 && b <= 180) candidates.add(b);
  }
  if (previousBpm >= 50 && previousBpm <= 180) {
    candidates.add(roundBpm(previousBpm));
    candidates.add(roundBpm(previousBpm / 2));
    candidates.add(roundBpm(previousBpm * 2));
  }
  if (guideBpm >= 50 && guideBpm <= 180) {
    candidates.add(roundBpm(guideBpm));
    candidates.add(roundBpm(guideBpm / 2));
    candidates.add(roundBpm(guideBpm * 2));
  }

  let best = roundBpm(raw);
  let bestScore = -Infinity;
  for (const bpm of candidates) {
    if (bpm < 50 || bpm > 180) continue;
    let s = scoreBpmCandidate(intervalsMs, bpm);
    if (previousBpm > 0) {
      const rel = Math.abs(bpm - previousBpm) / previousBpm;
      if (rel < 0.04) s += 0.45;
      else if (rel < 0.08) s += 0.15;
      if (
        Math.abs(bpm * 2 - previousBpm) <= 2 ||
        Math.abs(bpm - previousBpm * 2) <= 2
      ) {
        if (!(bpm >= 70 && bpm <= 120) && previousBpm >= 70 && previousBpm <= 120) {
          s -= 0.6;
        }
      }
    }
    // 가이드 템포 근처 강력 가중 (Live BPM Guided Auto-Detect)
    if (guideBpm > 0) {
      const gRel = Math.abs(bpm - guideBpm) / guideBpm;
      if (gRel < 0.03) s += 1.4;
      else if (gRel < 0.06) s += 0.7;
      else if (gRel < 0.1) s += 0.25;
      else s -= 0.5;
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
  let guideBpm = 0;
  let pendingBpm = 0;
  let pendingCount = 0;
  let energyHistory: number[] = [];
  let raf = 0;
  let stopped = false;

  const publishBpm = (next: number) => {
    if (next <= 0) return;
    const rounded = roundBpm(next);
    if (rounded === pendingBpm) {
      pendingCount += 1;
    } else {
      pendingBpm = rounded;
      pendingCount = 1;
    }
    const need = bpm > 0 ? 2 : 1;
    if (pendingCount < need) return;
    if (Math.abs(bpm - rounded) < 0.05) return;
    if (bpm > 0) {
      const rel = Math.abs(rounded - bpm) / bpm;
      if (rel < 0.015) return;
      const isHalfOrDouble =
        Math.abs(rounded * 2 - bpm) <= 3 || Math.abs(rounded - bpm * 2) <= 3;
      if (!isHalfOrDouble && rel < 0.08 && pendingCount < 3) return;
    }
    bpm = rounded;
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
    const refBpm = guideBpm > 0 ? guideBpm : bpm;
    const refractory = refBpm > 0 ? Math.max(220, 60000 / refBpm / 2.4) : 260;
    const rising =
      energyHistory.length >= 3 &&
      energy > energyHistory[energyHistory.length - 2] &&
      energyHistory[energyHistory.length - 2] >=
        energyHistory[energyHistory.length - 3];

    if (energy > threshold && rising && now - lastOnsetMs > refractory) {
      if (lastOnsetMs > 0) {
        const interval = now - lastOnsetMs;
        if (interval >= 300 && interval <= 1500) {
          intervals.push(interval);
          if (intervals.length > 16) intervals.shift();
          if (intervals.length >= 2) {
            publishBpm(stabilizeBpm(intervals, bpm, guideBpm));
          }
        }
      }
      lastOnsetMs = now;
      callbacks.onOnset?.(now, bpm);
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    stop,
    setGuideBpm: (g: number) => {
      guideBpm = g > 0 ? roundBpm(g) : 0;
    },
    getGuideBpm: () => guideBpm,
  };
}
