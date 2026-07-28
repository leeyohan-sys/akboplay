/**
 * 탭 템포 BPM 프리셋 저장 (웹: localStorage, 네이티브: 메모리+가능하면 localStorage)
 * 화면을 다시 열어도 유지
 */

const STORAGE_KEY = 'akboplay.tapBpmPresets.v1';

export type TapBpmPresets = [string, string, string, string];

/** 탭 템포 BPM 프리셋 기본값 */
export const DEFAULT_TAP_BPM_PRESETS: TapBpmPresets = [
  '90',
  '100',
  '110',
  '120',
];

function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    /* private mode 등 */
  }
  return null;
}

export function loadTapBpmPresets(): TapBpmPresets {
  const storage = getStorage();
  if (!storage) return [...DEFAULT_TAP_BPM_PRESETS] as TapBpmPresets;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_TAP_BPM_PRESETS] as TapBpmPresets;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      return [...DEFAULT_TAP_BPM_PRESETS] as TapBpmPresets;
    }
    const loaded = parsed.map((v) => String(v ?? '')) as TapBpmPresets;
    // 전부 비어 있으면 기본값 사용 (이전 빈 저장분 보정)
    if (loaded.every((v) => !String(v).trim())) {
      return [...DEFAULT_TAP_BPM_PRESETS] as TapBpmPresets;
    }
    return loaded;
  } catch {
    return [...DEFAULT_TAP_BPM_PRESETS] as TapBpmPresets;
  }
}

export function saveTapBpmPresets(presets: TapBpmPresets): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota 등 무시 */
  }
}

/** 입력 문자열 → 유효 BPM (40~240), 아니면 0 */
export function parsePresetBpm(text: string): number {
  const n = Number(String(text).trim().replace(/,/g, '.'));
  if (!Number.isFinite(n)) return 0;
  if (n < 40 || n > 240) return 0;
  return Math.round(n * 10) / 10;
}
