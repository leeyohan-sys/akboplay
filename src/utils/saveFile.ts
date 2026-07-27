/**
 * 모바일 브라우저에서 텍스트/악보 파일 저장·공유
 * iOS Safari는 <a download>가 자주 무시되므로 Share / 새 탭 폴백 사용
 */

function isMobileWeb(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function ensureFileName(name: string, ext: string): string {
  const base = (name || 'alto-score').replace(/[\\/:*?"<>|]+/g, '_').trim();
  if (base.toLowerCase().endsWith(`.${ext}`)) return base;
  return `${base}.${ext}`;
}

/** Blob을 파일로 저장 시도 (PC 웹) */
function anchorDownload(blob: Blob, fileName: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}

/** 새 탭에서 열어 사용자가 "공유/저장" 하게 함 (iOS 폴백) */
function openBlobInNewTab(blob: Blob): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      // 팝업 차단 시 같은 탭 이동은 위험하니 data URL 사용 안 함
      URL.revokeObjectURL(url);
      return false;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * LilyPond(.ly) 또는 텍스트 악보를 폰에 저장/공유
 * @returns 'shared' | 'downloaded' | 'opened' | 'failed'
 */
export async function saveScoreTextFile(
  fileName: string,
  content: string,
  options?: { ext?: 'ly' | 'txt'; mime?: string },
): Promise<'shared' | 'downloaded' | 'opened' | 'failed'> {
  const ext = options?.ext ?? 'ly';
  const mime = options?.mime ?? 'text/plain;charset=utf-8';
  const name = ensureFileName(fileName, ext);
  const blob = new Blob([content], { type: mime });

  // 1) 모바일: 시스템 공유 시트로 "파일에 저장" / AirDrop 등
  if (typeof navigator !== 'undefined' && typeof File !== 'undefined') {
    try {
      const file = new File([blob], name, { type: mime });
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
        share?: (data: ShareData) => Promise<void>;
      };
      const data: ShareData = {
        files: [file],
        title: name,
        text: '악보플레이 알토 악보 (LilyPond)',
      };
      if (nav.share && (!nav.canShare || nav.canShare(data))) {
        await nav.share(data);
        return 'shared';
      }
      // 파일 공유 미지원이면 텍스트만이라도
      if (isMobileWeb() && nav.share) {
        await nav.share({ title: name, text: content.slice(0, 50000) });
        return 'shared';
      }
    } catch (e) {
      // 사용자가 공유 취소한 경우
      if (e instanceof Error && /AbortError|canceled|cancelled/i.test(e.name + e.message)) {
        return 'failed';
      }
    }
  }

  // 2) <a download> (Android Chrome 등)
  if (anchorDownload(blob, name)) {
    if (isMobileWeb()) {
      // iOS는 download를 무시하고 새 탭처럼 동작하는 경우가 많음
      return 'downloaded';
    }
    return 'downloaded';
  }

  // 3) 새 탭 열기
  if (openBlobInNewTab(blob)) return 'opened';

  return 'failed';
}
