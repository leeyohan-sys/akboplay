import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { AnalyzeResult, MatchedSong, PlaylistResult } from '../types';

/** Android 에뮬레이터는 호스트 PC를 10.0.2.2로 접근 */
function resolveApiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

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

function friendlyFetchError(e: unknown): Error {
  if (e instanceof Error && e.name === 'AbortError') {
    return new Error(
      '요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (스캔 PDF는 인식에 시간이 걸릴 수 있습니다)',
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return new Error(
      '서버에 연결하지 못했습니다. 네트워크를 확인하거나 잠시 후 다시 시도해 주세요.',
    );
  }
  if (/502|503|504|bad gateway/i.test(msg)) {
    return new Error(
      '서버가 문서를 처리하다 중단되었습니다. 잠시 후 다시 시도하거나 곡을 직접 추가해 주세요.',
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

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
      if (res.status >= 502 && res.status <= 504) {
        throw new Error(`Bad Gateway (${res.status})`);
      }
      throw new Error(data.error || data.message || `요청 실패 (${res.status})`);
    }
    return data as T;
  } catch (e) {
    throw friendlyFetchError(e);
  } finally {
    clearTimeout(timer);
  }
}

async function blobFromUri(uri: string): Promise<Blob> {
  // 모바일 일부 브라우저는 blob: URL fetch가 실패함 → XHR 폴백
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error('fetch failed');
    return await res.blob();
  } catch {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', uri, true);
      xhr.responseType = 'blob';
      xhr.onload = () => {
        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
          resolve(xhr.response);
        } else {
          reject(new Error('PDF 파일을 읽지 못했습니다.'));
        }
      };
      xhr.onerror = () => reject(new Error('PDF 파일을 읽지 못했습니다.'));
      xhr.send();
    });
  }
}

async function buildPdfFormData(
  uri: string,
  fileName: string,
  file?: File | Blob | null,
): Promise<FormData> {
  const form = new FormData();
  const name = fileName || 'score.pdf';
  form.append('fileName', name);

  if (Platform.OS === 'web') {
    let blob: Blob;
    if (file) {
      blob = file;
    } else {
      blob = await blobFromUri(uri);
    }

    if (!blob || blob.size < 20) {
      throw new Error('PDF 파일이 비어 있습니다. 다른 파일을 선택해 주세요.');
    }

    const pdfFile =
      typeof File !== 'undefined'
        ? new File([blob], name, {
            type: blob.type || 'application/pdf',
          })
        : blob;
    form.append('pdf', pdfFile, name);
    return form;
  }

  form.append('pdf', {
    uri,
    name,
    type: 'application/pdf',
  } as unknown as Blob);
  return form;
}

/** 웹 전용: 안정적인 네이티브 파일 선택기 */
export function pickPdfFileWeb(): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.display = 'none';
    const cleanup = () => {
      input.onchange = null;
      input.remove();
    };
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file);
    };
    // 취소 감지 (대략)
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files?.length) {
            cleanup();
            resolve(null);
          }
        }, 600);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export const api = {
  baseUrl: API_BASE,

  health: () =>
    request<{ ok: boolean; youtubeConfigured: boolean }>('/api/health', {
      timeoutMs: 60000,
    }),

  demo: () => request<AnalyzeResult>('/api/demo', { timeoutMs: 60000 }),

  analyzePdf: async (
    uri: string,
    fileName: string,
    file?: File | Blob | null,
  ): Promise<AnalyzeResult> => {
    const form = await buildPdfFormData(uri, fileName, file);

    return request<AnalyzeResult>('/api/analyze', {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
    });
  },

  /** 웹에서 File 객체를 바로 업로드 */
  analyzePdfFile: async (file: File): Promise<AnalyzeResult> => {
    const form = new FormData();
    const name = file.name || 'score.pdf';
    // UTF-8 텍스트 필드로 파일명 별도 전달 (multipart filename 깨짐 방지)
    form.append('fileName', name);
    form.append('pdf', file, name);
    return request<AnalyzeResult>('/api/analyze', {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
    });
  },

  /** 알토 2성부 LilyPond 생성 (네이티브 URI) */
  generateAltoScore: async (
    uri: string,
    fileName: string,
    file?: File | Blob | null,
    mimeType?: string,
  ) => {
    const form = new FormData();
    const name = fileName || 'score.pdf';
    form.append('fileName', name);

    if (Platform.OS === 'web') {
      let blob: Blob;
      if (file) blob = file;
      else blob = await blobFromUri(uri);
      if (!blob || blob.size < 20) {
        throw new Error('악보 파일이 비어 있습니다.');
      }
      const upload =
        typeof File !== 'undefined'
          ? new File([blob], name, {
              type: mimeType || blob.type || 'application/octet-stream',
            })
          : blob;
      form.append('score', upload, name);
    } else {
      form.append('score', {
        uri,
        name,
        type: mimeType || 'application/octet-stream',
      } as unknown as Blob);
    }

    return request<{
      fileName: string;
      title?: string;
      key?: string;
      pageCount?: number;
      lilypond: string;
      note?: string;
      model?: string;
    }>('/api/alto-score', {
      method: 'POST',
      body: form,
      timeoutMs: 130000,
    });
  },

  /** 웹 File → 알토 LilyPond */
  generateAltoScoreFile: async (file: File) => {
    const form = new FormData();
    const name = file.name || 'score.pdf';
    form.append('fileName', name);
    form.append('score', file, name);
    return request<{
      fileName: string;
      title?: string;
      key?: string;
      pageCount?: number;
      lilypond: string;
      note?: string;
      model?: string;
    }>('/api/alto-score', {
      method: 'POST',
      body: form,
      timeoutMs: 130000,
    });
  },

  matchYoutube: (songs: { id: string; title: string; composer?: string }[]) =>
    request<{ songs: MatchedSong[] }>('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs }),
    }),

  autoPlaylist: (payload: {
    title: string;
    songs: {
      id: string;
      title: string;
      composer?: string;
      number?: string;
      key?: string;
    }[];
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
        channel?: string;
        channelTitle?: string;
        query: string;
        error?: string;
      }[];
    }>('/api/playlist/auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
