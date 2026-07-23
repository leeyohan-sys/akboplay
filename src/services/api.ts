import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { AnalyzeResult, MatchedSong, PlaylistResult } from '../types';

/** Android 에뮬레이터는 호스트 PC를 10.0.2.2로 접근 */
function resolveApiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  // GitHub Pages 배포본은 공개 API 사용
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host.endsWith('github.io')) {
      return 'https://akboplay-api.onrender.com';
    }
  }

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants as { debuggerHost?: string }).debuggerHost;

  if (hostUri) {
    const host = hostUri.split(':')[0];
    return `http://${host}:4000`;
  }

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:4000';
  }

  return 'http://localhost:4000';
}

const API_BASE = resolveApiBase();

async function request<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `요청 실패 (${res.status})`);
    }
    return data as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(
        '요청 시간이 초과되었습니다. API 서버(npm run server)가 실행 중인지 확인하세요.',
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 웹에서는 { uri, name, type } FormData가 동작하지 않아
 * 실제 Blob/File로 변환해 업로드합니다.
 */
async function buildPdfFormData(
  uri: string,
  fileName: string,
  file?: File | Blob | null,
): Promise<FormData> {
  const form = new FormData();
  const name = fileName || 'score.pdf';

  if (Platform.OS === 'web') {
    let blob: Blob;
    if (file) {
      blob = file;
    } else {
      const res = await fetch(uri);
      if (!res.ok) {
        throw new Error('선택한 PDF를 읽지 못했습니다. 다시 첨부해 주세요.');
      }
      blob = await res.blob();
    }

    if (!blob || blob.size < 20) {
      throw new Error('PDF 파일이 비어 있습니다. 다른 파일을 선택해 주세요.');
    }

    const pdfFile =
      typeof File !== 'undefined'
        ? new File([blob], name, { type: 'application/pdf' })
        : blob;
    form.append('pdf', pdfFile, name);
    return form;
  }

  // React Native (iOS/Android)
  form.append('pdf', {
    uri,
    name,
    type: 'application/pdf',
  } as unknown as Blob);
  return form;
}

export const api = {
  baseUrl: API_BASE,

  health: () => request<{ ok: boolean; youtubeConfigured: boolean }>('/api/health'),

  demo: () => request<AnalyzeResult>('/api/demo'),

  analyzePdf: async (
    uri: string,
    fileName: string,
    file?: File | Blob | null,
  ): Promise<AnalyzeResult> => {
    const form = await buildPdfFormData(uri, fileName, file);

    return request<AnalyzeResult>('/api/analyze', {
      method: 'POST',
      body: form,
      // Content-Type은 FormData가 boundary 포함해 자동 설정
    });
  },

  matchYoutube: (songs: { id: string; title: string; composer?: string }[]) =>
    request<{ songs: MatchedSong[] }>('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs }),
    }),

  /** API 키 없이 곡 검색 후 유튜브 연속재생(플레이리스트) URL 생성 */
  autoPlaylist: (payload: {
    title: string;
    songs: { id: string; title: string; composer?: string; number?: string }[];
  }) =>
    request<{
      title: string;
      playlistUrl: string;
      playlistsUrl: string;
      videoCount: number;
      videos: {
        title: string;
        videoId: string | null;
        videoTitle?: string;
        query: string;
        error?: string;
      }[];
    }>('/api/playlist/auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // 곡 수에 따라 검색이 길어질 수 있어 여유 타임아웃
      timeoutMs: 120000,
    }),

  createPlaylist: (payload: {
    title: string;
    description?: string;
    videoIds: string[];
    accessToken?: string;
  }) =>
    request<PlaylistResult>('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};
