/** 탭 템포 고정 프리셋 BPM */
export const TAP_BPM_PRESETS = [90, 100, 110, 120] as const;

export function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(240, Math.max(40, Math.round(n * 10) / 10));
}
