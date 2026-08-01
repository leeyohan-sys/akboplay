/** 탭 템포 고정 프리셋 BPM */
export const TAP_BPM_PRESETS = [60, 70, 80, 90, 100, 110, 120, 130] as const;

/** 정수 BPM으로 클램프 (40~240) */
export function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(240, Math.max(40, Math.round(n)));
}
