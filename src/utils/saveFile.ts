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

/** 공유 시트로 파일 공유 시도 (성공/취소/미지원 여부 반환) */
async function tryShareFile(
  blob: Blob,
  name: string,
  text?: string,
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') {
    return 'unsupported';
  }
  try {
    const file = new File([blob], name, { type: blob.type });
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    const data: ShareData = { files: [file], title: name, text };
    if (nav.share && (!nav.canShare || nav.canShare(data))) {
      await nav.share(data);
      return 'shared';
    }
    return 'unsupported';
  } catch (e) {
    if (e instanceof Error && /AbortError|canceled|cancelled/i.test(e.name + e.message)) {
      return 'cancelled';
    }
    return 'unsupported';
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
  const shareResult = await tryShareFile(blob, name, '악보플레이 알토 악보 (LilyPond)');
  if (shareResult === 'shared') return 'shared';
  if (shareResult === 'cancelled') return 'failed';
  // 파일 공유 미지원이면 텍스트만이라도
  if (isMobileWeb() && typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: name, text: content.slice(0, 50000) });
        return 'shared';
      } catch {
        /* 폴백으로 계속 진행 */
      }
    }
  }

  // 2) <a download> (Android Chrome 등)
  if (anchorDownload(blob, name)) return 'downloaded';

  // 3) 새 탭 열기
  if (openBlobInNewTab(blob)) return 'opened';

  return 'failed';
}

/**
 * PDF/PNG 등 바이너리 악보를 "바로 보기" 우선으로 열기
 * (새 탭에서 뷰어로 즉시 표시 → 실패 시 공유/다운로드로 폴백)
 * @returns 'opened' | 'shared' | 'downloaded' | 'failed'
 */
export async function viewBinaryScoreFile(
  fileName: string,
  blob: Blob,
): Promise<'opened' | 'shared' | 'downloaded' | 'failed'> {
  const ext = fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'png';
  const name = ensureFileName(fileName, ext);

  // 1) 새 탭에서 즉시 뷰어로 표시
  if (openBlobInNewTab(blob)) return 'opened';

  // 2) 팝업 차단 등으로 실패하면 공유 시트
  const shareResult = await tryShareFile(blob, name);
  if (shareResult === 'shared') return 'shared';
  if (shareResult === 'cancelled') return 'failed';

  // 3) 최후: 다운로드
  if (anchorDownload(blob, name)) return 'downloaded';

  return 'failed';
}
