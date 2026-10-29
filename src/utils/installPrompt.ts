/**
 * 웹 "홈 화면에 앱 추가" 상태
 * beforeinstallprompt는 앱 렌더 전에 올 수 있어 모듈 로드 시점에 미리 받아 둠
 */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    notify();
  });
}

export function subscribeInstall(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function isInstalled() {
  if (installed || typeof window === 'undefined') return installed;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function canPromptInstall() {
  return deferredPrompt !== null;
}

/** 브라우저 설치 창을 띄움. 설치 창을 띄울 수 없으면 null */
export async function promptInstall(): Promise<boolean | null> {
  if (!deferredPrompt) return null;
  const promptEvent = deferredPrompt;
  deferredPrompt = null;
  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  if (outcome === 'accepted') installed = true;
  notify();
  return outcome === 'accepted';
}

export type InstallEnv = 'kakao' | 'inapp' | 'ios' | 'samsung' | 'android' | 'desktop';

export function detectInstallEnv(): InstallEnv {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/KAKAOTALK/i.test(ua)) return 'kakao';
  if (/NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|BAND\//i.test(ua)) return 'inapp';
  if (
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ) {
    return 'ios';
  }
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}
