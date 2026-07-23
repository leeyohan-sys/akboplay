import { Linking, Platform } from 'react-native';

/** 검색 쿼리 구성 (찬송가는 검색 정확도 보강) */
export function buildYoutubeQuery(song: {
  title: string;
  composer?: string;
  number?: string;
}): string {
  const parts = [song.title];
  if (song.number) parts.push(`${song.number}장`);
  if (
    /하나님|예수|성령|찬송|은혜|나그네|죄악|만지소서|만족/.test(song.title) ||
    song.number
  ) {
    parts.push('찬송가');
  } else if (song.composer) {
    parts.push(song.composer);
  }
  return parts.join(' ');
}

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

export function youtubePlaylistsUrl(): string {
  return 'https://www.youtube.com/feed/playlists';
}

/** 모바일 웹 여부 */
export function isMobileWeb(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

/**
 * HTTPS 유튜브 URL → 네이티브 앱 스킴/인텐트
 * Android: intent:// 로 유튜브 앱 강제
 * iOS: youtube:// 스킴 (실패 시 https 폴백은 호출부에서)
 */
export function toYoutubeAppUrl(httpsUrl: string): string {
  try {
    const u = new URL(httpsUrl);
    const host = u.hostname.replace(/^www\./, '');
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) {
      return httpsUrl;
    }

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const pathQuery = `${u.hostname}${u.pathname}${u.search}${u.hash}`;

    if (/Android/i.test(ua)) {
      return (
        `intent://${pathQuery}` +
        `#Intent;scheme=https;package=com.google.android.youtube;` +
        `S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`
      );
    }

    if (/iPhone|iPad|iPod/i.test(ua)) {
      // iOS 유튜브 앱 딥링크
      if (host.includes('youtu.be')) {
        const id = u.pathname.replace(/^\//, '');
        return `youtube://www.youtube.com/watch?v=${id}${u.search}`;
      }
      return `youtube://${pathQuery}`;
    }
  } catch {
    // ignore
  }
  return httpsUrl;
}

/**
 * 클릭 직후 빈 창을 열어 두고(팝업 차단 회피),
 * 검색이 끝나면 그 창에 유튜브 플레이리스트 URL을 넣습니다.
 */
export function writeYoutubeWindowHtml(
  win: Window | null,
  htmlBody: string,
): void {
  if (!win || win.closed) return;
  try {
    win.document.open();
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>악보플레이</title></head>
      <body style="font-family:sans-serif;background:#0E1520;color:#E8DFC8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:420px;padding:24px">${htmlBody}</div>
      </body></html>`,
    );
    win.document.close();
  } catch {
    // ignore
  }
}

export function openYoutubeWindowPlaceholder(): Window | null {
  // 모바일은 새 탭 대신 앱으로 열므로 플레이스홀더 불필요
  if (Platform.OS !== 'web' || isMobileWeb()) return null;
  const win = window.open('about:blank', '_blank');
  writeYoutubeWindowHtml(
    win,
    `<h2 style="margin:0 0 12px">악보플레이</h2>
     <p style="margin:0;opacity:.85">유튜브에서 곡을 찾는 중…</p>
     <p style="margin:16px 0 0;font-size:13px;opacity:.55">보통 10~30초 정도 걸립니다. 이 창을 닫지 마세요.</p>`,
  );
  return win;
}

/** 모바일 웹: 유튜브 앱으로 실행 */
export async function openInYoutubeApp(url: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await Linking.openURL(url);
    return;
  }

  const appUrl = toYoutubeAppUrl(url);

  if (isMobileWeb()) {
    // Android intent / iOS youtube:// — 같은 탭에서 앱 호출이 가장 안정적
    window.location.href = appUrl;

    // iOS에서 앱 미설치 시 https로 폴백
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && appUrl !== url) {
      window.setTimeout(() => {
        // 페이지가 아직 보이면 앱 실행 실패로 보고 https 이동
        if (!document.hidden) {
          window.location.href = url;
        }
      }, 1200);
    }
    return;
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    window.location.href = url;
  }
}

export function navigateYoutubeWindow(
  placeholder: Window | null,
  url: string,
): void {
  if (Platform.OS === 'web') {
    if (isMobileWeb()) {
      void openInYoutubeApp(url);
      try {
        placeholder?.close();
      } catch {
        // ignore
      }
      return;
    }

    if (placeholder && !placeholder.closed) {
      placeholder.location.href = url;
      placeholder.focus();
      return;
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      window.location.href = url;
    }
    return;
  }
  void Linking.openURL(url);
}

export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS === 'web' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 폴백: 임시 textarea
    }
  }
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
  return false;
}

/** 재생 URL 공유 (모바일: 시스템 공유 / 그 외: 클립보드 복사) */
export async function sharePlaybackUrl(
  url: string,
  title = '악보플레이 플레이리스트',
): Promise<'shared' | 'copied' | 'failed'> {
  if (!url) return 'failed';

  if (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function'
  ) {
    try {
      await navigator.share({ title, text: title, url });
      return 'shared';
    } catch (e) {
      // 사용자가 취소한 경우는 실패로 치지 않음
      if (e instanceof Error && /AbortError|cancelled|canceled/i.test(e.name + e.message)) {
        return 'failed';
      }
    }
  }

  const ok = await copyText(url);
  return ok ? 'copied' : 'failed';
}
