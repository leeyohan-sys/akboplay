import React, { useState } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import { api } from '../services/api';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import type { RootStackParamList } from '../navigation/types';
import type { PlaylistScorePdfResult } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'PlaylistPdf'>;

type JobResult = Omit<PlaylistScorePdfResult, 'pdfBase64'> & {
  hasPdf?: boolean;
  jobId?: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 모바일/PC 공통 PDF 저장·열기 */
async function openOrDownloadPdf(
  blob: Blob,
  fileName: string,
  fileUrl?: string,
) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    if (fileUrl) {
      await Linking.openURL(fileUrl);
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  try {
    // iOS Safari는 download 속성이 약해 새 탭으로 여는 편이 안정적
    if (isIOS) {
      const opened = window.open(url, '_blank');
      if (!opened && fileUrl) {
        window.location.href = fileUrl;
      }
      return;
    }

    if (isAndroid && fileUrl) {
      // 안드로이드 크롬: 서버 URL 직접 이동이 다운로드에 유리한 경우 많음
      window.location.href = fileUrl;
      return;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'akboplay-score.pdf';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function PlaylistPdfScreen({}: Props) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);
  const [status, setStatus] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  const downloadReadyPdf = async (id: string, fileName: string) => {
    const fileUrl = api.playlistScorePdfFileUrl(id);
    const blob = await api.downloadPlaylistScorePdfFile(id);
    await openOrDownloadPdf(blob, fileName, fileUrl);
  };

  const makePdf = async () => {
    setError(null);
    setResult(null);
    setJobId(null);
    const playlistUrl = url.trim();
    if (!playlistUrl) {
      setError('유튜브 재생목록 URL을 입력해 주세요.');
      return;
    }

    setLoading(true);
    setStatus('서버 연결 확인 중…');
    try {
      try {
        await api.wakeUp();
      } catch {
        /* 계속 시도 */
      }

      setStatus('작업 시작 중…');
      const started = await api.startPlaylistScorePdfJob(playlistUrl);
      const id = started.jobId;
      if (!id) {
        throw new Error('작업 ID를 받지 못했습니다.');
      }
      setJobId(id);
      setStatus('재생목록·악보 검색 중…');

      // 짧은 요청을 반복 폴링 → 모바일 장시간 fetch 끊김 방지
      let final: Awaited<ReturnType<typeof api.getPlaylistScorePdfJob>> | null =
        null;
      const startedAt = Date.now();
      const maxMs = 4 * 60 * 1000;

      while (Date.now() - startedAt < maxMs) {
        await sleep(2000);
        // 폴링 중에도 서버 슬립 방지용 짧은 요청
        const job = await api.getPlaylistScorePdfJob(id);
        if (job.message) setStatus(job.message);
        else if (job.total) {
          setStatus(`진행 중… ${job.current || 0}/${job.total}`);
        }

        if (job.status === 'done') {
          final = job;
          break;
        }
        if (job.status === 'error') {
          throw new Error(job.error || job.message || 'PDF 생성 실패');
        }
      }

      if (!final?.result) {
        throw new Error(
          '시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
        );
      }

      const out: JobResult = { ...final.result, jobId: id };
      setResult(out);
      setStatus(
        `${out.playlistTitle} · ${out.songCount}곡 · ${out.pageCount}페이지 · 악보 ${out.foundCount}곡`,
      );

      if (out.hasPdf) {
        setStatus((prev) => `${prev}\n다운로드 중…`);
        await downloadReadyPdf(id, out.fileName || 'akboplay-score.pdf');
        setStatus(
          `${out.playlistTitle} · ${out.songCount}곡 · ${out.pageCount}페이지 · 악보 ${out.foundCount}곡`,
        );
      }
    } catch (e) {
      const raw =
        e instanceof Error
          ? e.message
          : '재생목록 악보 PDF 생성에 실패했습니다.';
      // API 미배포(404)일 때 모바일에서 원인 파악이 쉽도록 안내
      const msg =
        /404|Cannot POST|찾을 수 없/i.test(raw)
          ? 'API 서버가 아직 업데이트되지 않았습니다. Render에서 Manual Deploy 후 1~2분 뒤 다시 시도해 주세요.'
          : raw;
      setError(msg);
      setStatus('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenShell
      footer={
        <View style={styles.footer}>
          <PrimaryButton
            label={loading ? 'PDF 만드는 중…' : 'PDF 만들기'}
            onPress={makePdf}
            loading={loading}
          />
          {result?.hasPdf && (result.jobId || jobId) ? (
            <PrimaryButton
              label="다시 다운로드"
              variant="ghost"
              disabled={loading}
              onPress={() => {
                const id = result.jobId || jobId;
                if (!id) return;
                downloadReadyPdf(id, result.fileName || 'akboplay-score.pdf').catch(
                  (e) =>
                    setError(
                      e instanceof Error ? e.message : '다운로드에 실패했습니다.',
                    ),
                );
              }}
            />
          ) : null}
        </View>
      }
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hint}>
          유튜브 재생목록 URL을 넣으면 곡마다 악보 이미지를 검색해{'\n'}
          가로 한 페이지에 좌·우 2곡씩 PDF로 만듭니다.
        </Text>

        <Text style={styles.label}>재생목록 URL</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://youtube.com/playlist?list=..."
          placeholderTextColor={colors.mist}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading}
          style={styles.input}
          multiline
        />

        {status ? <Text style={styles.status}>{status}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result?.songs?.length ? (
          <View style={styles.list}>
            <Text style={styles.listTitle}>곡 목록</Text>
            {result.songs.map((s) => (
              <View key={`${s.index}-${s.title}`} style={styles.row}>
                <Text style={styles.rowIndex}>{s.index}</Text>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {s.title}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {s.scoreFound
                      ? s.scoreVideoTitle || '악보 이미지 찾음'
                      : '악보 미발견'}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.badge,
                    s.scoreFound ? styles.badgeOn : styles.badgeOff,
                  ]}
                >
                  {s.scoreFound ? '악보' : '—'}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  hint: {
    ...typography.body,
    fontSize: 14,
    lineHeight: 22,
    color: colors.parchmentDim,
    marginBottom: 16,
  },
  label: {
    ...typography.caption,
    color: colors.brass,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.4)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.cream,
    backgroundColor: 'rgba(30, 44, 68, 0.65)',
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none' } as object)
      : null),
  },
  status: {
    ...typography.caption,
    marginTop: 12,
    color: colors.brassBright,
    lineHeight: 18,
  },
  error: {
    ...typography.caption,
    marginTop: 10,
    color: '#F0B0A4',
    lineHeight: 18,
  },
  footer: {
    gap: 10,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  list: {
    marginTop: 20,
    gap: 8,
  },
  listTitle: {
    ...typography.bodyStrong,
    color: colors.cream,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.22)',
  },
  rowIndex: {
    width: 24,
    textAlign: 'center',
    color: colors.brass,
    fontWeight: '700',
  },
  rowBody: { flex: 1 },
  rowTitle: {
    color: colors.cream,
    fontSize: 14,
    fontWeight: '600',
  },
  rowMeta: {
    marginTop: 2,
    color: colors.mist,
    fontSize: 11,
  },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  badgeOn: {
    color: colors.ink,
    backgroundColor: colors.brassBright,
  },
  badgeOff: {
    color: colors.mist,
    backgroundColor: 'rgba(138, 147, 163, 0.25)',
  },
});
