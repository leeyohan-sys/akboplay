import React, { useCallback, useRef, useState } from 'react';
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import { api, pickScoreFileWeb } from '../services/api';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import type { RootStackParamList } from '../navigation/types';
import type { TabConvertResult } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'TabConvert'>;

type LastUpload = {
  kind: 'web-file' | 'native';
  file?: File;
  uri?: string;
  fileName: string;
  mimeType?: string;
  nativeFile?: File | Blob | null;
};

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

export function TabConvertScreen({}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TabConvertResult | null>(null);
  const [hasLastUpload, setHasLastUpload] = useState(false);
  const lastUploadRef = useRef<LastUpload | null>(null);

  const runConvert = useCallback(async (upload: LastUpload, force: boolean) => {
    setError(null);
    setLoading(true);
    if (force) setResult(null);
    try {
      let out: TabConvertResult;
      if (upload.kind === 'web-file' && upload.file) {
        out = await api.convertToTabFile(upload.file, { force });
      } else {
        out = await api.convertToTab(
          upload.uri || '',
          upload.fileName,
          upload.nativeFile ?? null,
          upload.mimeType || 'image/png',
          { force },
        );
      }
      if (force && out.cached) {
        setError(
          '서버가 아직 캐시 결과를 반환했습니다. 잠시 후 다시 시도해 주세요. (API 배포 중일 수 있음)',
        );
      }
      setResult(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : '탭 변환에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  const pickAndConvert = useCallback(async () => {
    setError(null);
    try {
      if (Platform.OS === 'web') {
        const file = await pickScoreFileWeb();
        if (!file) return;
        const upload: LastUpload = {
          kind: 'web-file',
          file,
          fileName: file.name || 'score.png',
        };
        lastUploadRef.current = upload;
        setHasLastUpload(true);
        await runConvert(upload, false);
        return;
      }

      const picked = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;

      const asset = picked.assets[0];
      const upload: LastUpload = {
        kind: 'native',
        uri: asset.uri,
        fileName: asset.name || 'score.png',
        mimeType: asset.mimeType || 'image/png',
        nativeFile: (asset as { file?: File }).file ?? null,
      };
      lastUploadRef.current = upload;
      setHasLastUpload(true);
      await runConvert(upload, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '탭 변환에 실패했습니다.');
      setLoading(false);
    }
  }, [runConvert]);

  /** 같은 파일로 캐시 무시하고 재변환 */
  const reconvert = useCallback(async () => {
    const last = lastUploadRef.current;
    if (!last) {
      setError('다시 변환할 파일이 없습니다. 먼저 악보를 업로드해 주세요.');
      return;
    }
    await runConvert(last, true);
  }, [runConvert]);

  const pngUri = result?.pngBase64
    ? `data:image/png;base64,${result.pngBase64}`
    : null;

  return (
    <ScreenShell
      footer={
        <View style={styles.actions}>
          <PrimaryButton
            label={loading ? '변환 중…' : '악보 이미지/PDF 업로드'}
            onPress={pickAndConvert}
            loading={loading}
            disabled={loading}
          />
          {hasLastUpload ? (
            <PrimaryButton
              label="다시 변환"
              variant="ghost"
              onPress={reconvert}
              disabled={loading}
            />
          ) : null}
          {result?.pngBase64 ? (
            <PrimaryButton
              label="PNG 저장"
              variant="ghost"
              onPress={() =>
                downloadBase64(
                  result.pngBase64,
                  'image/png',
                  `${(result.title || 'tab').replace(/\s+/g, '_')}.png`,
                )
              }
              disabled={loading}
            />
          ) : null}
          {result?.pdfBase64 ? (
            <PrimaryButton
              label="PDF 저장"
              variant="ghost"
              onPress={() =>
                downloadBase64(
                  result.pdfBase64!,
                  'application/pdf',
                  `${(result.title || 'tab').replace(/\s+/g, '_')}.pdf`,
                )
              }
              disabled={loading}
            />
          ) : null}
        </View>
      }
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator
      >
        <Text style={styles.eyebrow}>SCORE → GUITAR TAB</Text>
        <Text style={styles.title}>TAB 변환</Text>
        <Text style={[typography.body, styles.sub]}>
          오선 악보 이미지를 올리면 기타 탭(TAB)으로 바꿔 보여 줍니다.
          {'\n'}같은 파일은 「다시 변환」으로 캐시 없이 재처리할 수 있습니다.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result ? (
          <View style={styles.resultBox}>
            <Text style={styles.resultTitle}>{result.title || 'Guitar Tab'}</Text>
            <Text style={styles.resultMeta}>
              {[
                result.key ? `Key ${result.key}` : null,
                result.positionLabel || null,
                result.tempo ? `♩=${result.tempo}` : null,
                result.timeSignature,
                result.measureCount != null
                  ? `${result.measureCount}마디`
                  : null,
                result.method === 'demo' ? '데모' : 'AI 변환',
                result.forceApplied ? '재변환' : null,
                result.cached ? '캐시' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {result.note ? (
              <Text style={styles.note}>{result.note}</Text>
            ) : null}

            {pngUri ? (
              <Pressable
                onPress={() => {
                  if (Platform.OS === 'web') {
                    window.open(pngUri, '_blank');
                  } else {
                    Linking.openURL(pngUri).catch(() => undefined);
                  }
                }}
              >
                <Image
                  source={{ uri: pngUri }}
                  style={styles.preview}
                  resizeMode="contain"
                />
              </Pressable>
            ) : null}

            {result.asciiTab ? (
              <View style={styles.asciiWrap}>
                <Text style={styles.asciiLabel}>ASCII TAB</Text>
                <Text style={styles.ascii} selectable>
                  {result.asciiTab}
                </Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyMark}>𝄞 → TAB</Text>
            <Text style={[typography.caption, styles.emptyHint]}>
              JPG·PNG·PDF 악보를 업로드하세요.
              {'\n'}변환에는 잠시(최대 1~2분) 걸릴 수 있습니다.
            </Text>
          </View>
        )}
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
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  eyebrow: {
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 11,
    letterSpacing: 2,
    color: colors.brass,
    marginBottom: 6,
  },
  title: {
    ...typography.brand,
    fontSize: 28,
    marginBottom: 8,
  },
  sub: {
    marginBottom: 16,
    lineHeight: 22,
  },
  error: {
    ...typography.caption,
    color: '#F0B0A4',
    marginBottom: 12,
    lineHeight: 18,
  },
  actions: {
    gap: 8,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  empty: {
    marginTop: 28,
    alignItems: 'center',
    paddingVertical: 36,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.28)',
    borderStyle: 'dashed',
    borderRadius: 16,
    backgroundColor: 'rgba(30, 44, 68, 0.35)',
  },
  emptyMark: {
    fontSize: 28,
    color: colors.brassBright,
    marginBottom: 10,
  },
  emptyHint: {
    textAlign: 'center',
    lineHeight: 18,
    color: colors.mist,
  },
  resultBox: {
    marginTop: 8,
    gap: 8,
  },
  resultTitle: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    fontSize: 22,
    fontWeight: '700',
    color: colors.cream,
  },
  resultMeta: {
    ...typography.caption,
    color: colors.brass,
    marginBottom: 4,
  },
  note: {
    ...typography.caption,
    color: colors.mist,
    lineHeight: 18,
    marginBottom: 8,
  },
  preview: {
    width: '100%',
    minHeight: 220,
    maxHeight: 480,
    backgroundColor: '#F7F3E8',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.35)',
  },
  asciiWrap: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(14, 21, 32, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.25)',
  },
  asciiLabel: {
    ...typography.caption,
    color: colors.brass,
    marginBottom: 6,
    letterSpacing: 1,
  },
  ascii: {
    fontFamily: 'Consolas, Monaco, monospace',
    fontSize: 11,
    lineHeight: 15,
    color: colors.parchmentDim,
  },
});
