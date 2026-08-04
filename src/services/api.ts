import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type {
  AnalyzeJob,
  AnalyzeResult,
  MatchedSong,
  PlaylistResult,
  PlaylistScorePdfResult,
  TabConvertResult,
} from '../types';

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
      '요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요. (무료 서버는 깨어나는 데 30~60초 걸릴 수 있습니다)',
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return new Error(
      '서버에 연결하지 못했습니다. 무료 API가 잠들어 있거나 재배포 중일 수 있습니다. 10초 뒤 다시 시도해 주세요.',
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

async function pollAnalyzeJob(
  jobId: string,
  onProgress?: (job: AnalyzeJob) => void,
): Promise<AnalyzeJob> {
  const startedAt = Date.now();
  let lastKey = '';
  for (;;) {
    const job = await request<AnalyzeJob>(
      `/api/analyze/jobs/${encodeURIComponent(jobId)}`,
      { timeoutMs: 30000 },
    );
    const key = `${job.status}|${job.stage}|${job.message}|${job.current}|${job.total}`;
    if (key !== lastKey) {
      lastKey = key;
      onProgress?.(job);
    }
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() - startedAt > 130000) {
      throw new Error('분석 작업이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    await new Promise((r) => setTimeout(r, 700));
  }
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

/** 웹: 악보 이미지 또는 PDF 선택 (TAB 변환용) */
export function pickScoreFileWeb(): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf,.pdf,.png,.jpg,.jpeg,.webp';
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
    request<{
      ok: boolean;
      youtubeConfigured: boolean;
      geminiConfigured?: boolean;
      version?: string;
    }>('/api/health', {
      timeoutMs: 90000,
    }),

  /** Render 무료 플랜 슬립 깨우기 (변환 전 호출) */
  wakeUp: async (): Promise<{ ok: boolean; version?: string }> => {
    try {
      const h = await api.health();
      return { ok: Boolean(h?.ok), version: h?.version };
    } catch {
      // 한 번 더 시도
      await new Promise((r) => setTimeout(r, 2500));
      const h = await api.health();
      return { ok: Boolean(h?.ok), version: h?.version };
    }
  },

  demo: () => request<AnalyzeResult>('/api/demo', { timeoutMs: 60000 }),

  analyzePdf: async (
    uri: string,
    fileName: string,
    file?: File | Blob | null,
    onProgress?: (job: AnalyzeJob) => void,
  ): Promise<AnalyzeResult> => {
    const form = await buildPdfFormData(uri, fileName, file);
    onProgress?.({
      jobId: '',
      status: 'running',
      stage: 'upload',
      message: 'PDF 업로드 중…',
      current: 0,
      total: 5,
    });
    const started = await request<AnalyzeJob>('/api/analyze/jobs', {
      method: 'POST',
      body: form,
      timeoutMs: 60000,
    });
    onProgress?.(started);
    const final = await pollAnalyzeJob(started.jobId, onProgress);
    if (final.status === 'error') {
      throw new Error(final.error || final.message || 'PDF 분석에 실패했습니다.');
    }
    if (!final.result) {
      throw new Error('분석 결과를 받지 못했습니다.');
    }
    return final.result;
  },

  /** 웹에서 File 객체를 바로 업로드 */
  analyzePdfFile: async (
    file: File,
    onProgress?: (job: AnalyzeJob) => void,
  ): Promise<AnalyzeResult> => {
    const form = new FormData();
    const name = file.name || 'score.pdf';
    // UTF-8 텍스트 필드로 파일명 별도 전달 (multipart filename 깨짐 방지)
    form.append('fileName', name);
    form.append('pdf', file, name);
    onProgress?.({
      jobId: '',
      status: 'running',
      stage: 'upload',
      message: 'PDF 업로드 중…',
      current: 0,
      total: 5,
    });
    const started = await request<AnalyzeJob>('/api/analyze/jobs', {
      method: 'POST',
      body: form,
      timeoutMs: 60000,
    });
    onProgress?.(started);
    const final = await pollAnalyzeJob(started.jobId, onProgress);
    if (final.status === 'error') {
      throw new Error(final.error || final.message || 'PDF 분석에 실패했습니다.');
    }
    if (!final.result) {
      throw new Error('분석 결과를 받지 못했습니다.');
    }
    return final.result;
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

  /** 유튜브 재생목록 → 악보 PDF (동기, 호환용) */
  playlistScorePdf: (playlistUrl: string) =>
    request<PlaylistScorePdfResult>('/api/playlist-score-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistUrl }),
      timeoutMs: 180000,
    }),

  /** 모바일 친화: 작업 시작 */
  startPlaylistScorePdfJob: (playlistUrl: string) =>
    request<{
      jobId: string;
      status: string;
      message?: string;
    }>('/api/playlist-score-pdf/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistUrl }),
      timeoutMs: 60000,
    }),

  /** 작업 상태 폴링 */
  getPlaylistScorePdfJob: (jobId: string) =>
    request<{
      jobId: string;
      status: 'queued' | 'running' | 'done' | 'error';
      message?: string;
      stage?: string;
      current?: number;
      total?: number;
      error?: string | null;
      result?: Omit<PlaylistScorePdfResult, 'pdfBase64'> & { hasPdf?: boolean };
    }>(`/api/playlist-score-pdf/jobs/${encodeURIComponent(jobId)}`, {
      timeoutMs: 30000,
    }),

  /** 완성 PDF 파일 URL (다운로드/새 탭) */
  playlistScorePdfFileUrl: (jobId: string) =>
    `${API_BASE}/api/playlist-score-pdf/jobs/${encodeURIComponent(jobId)}/file`,

  /** PDF 바이너리 다운로드 (Blob) */
  downloadPlaylistScorePdfFile: async (jobId: string): Promise<Blob> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(
        `${API_BASE}/api/playlist-score-pdf/jobs/${encodeURIComponent(jobId)}/file`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ||
            `PDF 다운로드 실패 (${res.status})`,
        );
      }
      return await res.blob();
    } catch (e) {
      throw friendlyFetchError(e);
    } finally {
      clearTimeout(timer);
    }
  },

  /** 웹 File → 기타 탭 변환 */
  convertToTabFile: async (
    file: File,
    opts?: { force?: boolean },
  ): Promise<TabConvertResult> => {
    const form = new FormData();
    const name = file.name || 'score.png';
    form.append('fileName', name);
    // multer body + 쿼리 둘 다 (일부 환경에서 body 필드 누락 대비)
    if (opts?.force) form.append('force', '1');
    form.append('file', file, name);
    const q = opts?.force ? '?force=1' : '';
    return request<TabConvertResult>(`/api/tab-convert${q}`, {
      method: 'POST',
      body: form,
      timeoutMs: 150000,
      headers: opts?.force ? { 'X-Tab-Force': '1' } : undefined,
    });
  },

  /** 네이티브 URI → 기타 탭 변환 */
  convertToTab: async (
    uri: string,
    fileName: string,
    file?: File | Blob | null,
    mimeType = 'image/png',
    opts?: { force?: boolean },
  ): Promise<TabConvertResult> => {
    const form = new FormData();
    const name = fileName || 'score.png';
    form.append('fileName', name);
    if (opts?.force) form.append('force', '1');

    if (Platform.OS === 'web') {
      let blob: Blob;
      if (file) {
        blob = file;
      } else {
        blob = await blobFromUri(uri);
      }
      const upload =
        typeof File !== 'undefined'
          ? new File([blob], name, { type: blob.type || mimeType })
          : blob;
      form.append('file', upload, name);
    } else {
      form.append('file', {
        uri,
        name,
        type: mimeType,
      } as unknown as Blob);
    }

    const q = opts?.force ? '?force=1' : '';
    return request<TabConvertResult>(`/api/tab-convert${q}`, {
      method: 'POST',
      body: form,
      timeoutMs: 150000,
      headers: opts?.force ? { 'X-Tab-Force': '1' } : undefined,
    });
  },
};
