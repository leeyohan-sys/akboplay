import React, { useState } from 'react';
import {
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

function downloadBase64(base64: string, mime: string, fileName: string) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${base64}`;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function PlaylistPdfScreen({}: Props) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaylistScorePdfResult | null>(null);
  const [status, setStatus] = useState('');

  const makePdf = async () => {
    setError(null);
    setResult(null);
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
        /* 변환은 계속 시도 */
      }

      setStatus('재생목록·악보 검색 중… (곡 수에 따라 1~2분 걸릴 수 있습니다)');
      const out = await api.playlistScorePdf(playlistUrl);
      setResult(out);
      setStatus(
        `${out.playlistTitle} · ${out.songCount}곡 · ${out.pageCount}페이지 · 악보 ${out.foundCount}곡`,
      );

      if (out.pdfBase64) {
        downloadBase64(
          out.pdfBase64,
          out.mimePdf || 'application/pdf',
          out.fileName || 'akboplay-score.pdf',
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '재생목록 악보 PDF 생성에 실패했습니다.',
      );
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
          {result?.pdfBase64 ? (
            <PrimaryButton
              label="다시 다운로드"
              variant="ghost"
              disabled={loading}
              onPress={() =>
                downloadBase64(
                  result.pdfBase64,
                  result.mimePdf || 'application/pdf',
                  result.fileName || 'akboplay-score.pdf',
                )
              }
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
