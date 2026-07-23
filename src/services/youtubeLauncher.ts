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
  if (Platform.OS !== 'web') return null;
  const win = window.open('about:blank', '_blank');
  writeYoutubeWindowHtml(
    win,
    `<h2 style="margin:0 0 12px">악보플레이</h2>
     <p style="margin:0;opacity:.85">유튜브에서 곡을 찾는 중…</p>
     <p style="margin:16px 0 0;font-size:13px;opacity:.55">보통 10~30초 정도 걸립니다. 이 창을 닫지 마세요.</p>`,
  );
  return win;
}

export function navigateYoutubeWindow(
  placeholder: Window | null,
  url: string,
): void {
  if (Platform.OS === 'web') {
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
  Linking.openURL(url);
}

export async function openInYoutubeApp(url: string): Promise<void> {
  navigateYoutubeWindow(null, url);
}

export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS === 'web' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}
