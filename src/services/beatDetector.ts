/**
 * 마이크 입력으로 비트(onset)를 추적하고 BPM을 추정합니다.
 * Web Audio API 기반 (웹 / Expo Web)
 */

export type BeatEvent = {
  timeMs: number;
  energy: number;
};

export type BeatDetectorCallbacks = {
  onBeat?: (beatIndex: number, bpm: number) => void;
  onBpm?: (bpm: number) => void;
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
 * 마이크를 열고 실시간으로 비트를 추적합니다.
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
  let lastBeatMs = 0;
  let beatIndex = 0;
  let bpm = 0;
  let energyHistory: number[] = [];
  let raf = 0;
  let stopped = false;

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

    // 저~중역(킥·스네어) 에너지 위주로 비트 감지
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
    // 최소 간격 ~280ms (약 214 BPM 상한) — 더블비트 방지
    const refractory = bpm > 0 ? Math.max(240, 60000 / bpm / 2.2) : 280;
    const rising =
      energyHistory.length >= 3 &&
      energy > energyHistory[energyHistory.length - 2] &&
      energyHistory[energyHistory.length - 2] >=
        energyHistory[energyHistory.length - 3];

    if (energy > threshold && rising && now - lastBeatMs > refractory) {
      if (lastBeatMs > 0) {
        const interval = now - lastBeatMs;
        // 40~200 BPM 범위만 수집
        if (interval >= 300 && interval <= 1500) {
          intervals.push(interval);
          if (intervals.length > 12) intervals.shift();
          const med = median(intervals);
          if (med > 0) {
            bpm = Math.round(60000 / med);
            callbacks.onBpm?.(bpm);
          }
        }
      }
      lastBeatMs = now;
      beatIndex = (beatIndex % 4) + 1;
      callbacks.onBeat?.(beatIndex, bpm);
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return { stop };
}
