import React, { useCallback, useState } from 'react';
import {
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
import { api } from '../services/api';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { showAlert } from '../utils/dialog';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AltoScore'>;

type AltoResult = {
  fileName: string;
  title?: string;
  key?: string;
  pageCount?: number;
  lilypond: string;
  note?: string;
};

/** 웹: PDF/이미지 파일 선택 */
function pickScoreFileWeb(): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp';
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

function downloadTextFile(fileName: string, content: string) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.ly') ? fileName : `${fileName}.ly`;
  a.click();
  URL.revokeObjectURL(url);
}

export function AltoScoreScreen({}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AltoResult | null>(null);

  const copyLy = useCallback(async () => {
    if (!result?.lilypond) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.lilypond);
        showAlert('복사됨', 'LilyPond 코드를 클립보드에 복사했습니다.');
        return;
      }
    } catch {
      /* fallthrough */
    }
    showAlert('복사 실패', '브라우저에서 클립보드 권한을 확인해 주세요.');
  }, [result]);

  const upload = async () => {
    setError(null);
    setLoading(true);
    try {
      let analyzed: AltoResult;
      if (Platform.OS === 'web') {
        const file = await pickScoreFileWeb();
        if (!file) {
          setLoading(false);
          return;
        }
        analyzed = await api.generateAltoScoreFile(file);
      } else {
        const picked = await DocumentPicker.getDocumentAsync({
          type: ['application/pdf', 'image/*'],
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (picked.canceled || !picked.assets?.[0]) {
          setLoading(false);
          return;
        }
        const asset = picked.assets[0];
        analyzed = await api.generateAltoScore(
          asset.uri,
          asset.name || 'score.pdf',
          (asset as { file?: File }).file ?? null,
          asset.mimeType,
        );
      }
      setResult(analyzed);
    } catch (e) {
      setError(e instanceof Error ? e.message : '알토 악보 생성에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const lyName =
    (result?.title || result?.fileName || 'alto-score')
      .replace(/\.(pdf|png|jpe?g|webp)$/i, '')
      .replace(/[^\w가-힣\-]+/g, '_') + '.ly';

  return (
    <ScreenShell
      footer={
        <View style={styles.actions}>
          <PrimaryButton
            label={result ? '다른 악보 업로드' : '악보 업로드 (PDF/JPG/PNG)'}
            onPress={upload}
            loading={loading}
          />
          {result?.lilypond ? (
            <>
              <PrimaryButton
                label=".ly 파일 다운로드"
                onPress={() => downloadTextFile(lyName, result.lilypond)}
                variant="ghost"
                disabled={Platform.OS !== 'web'}
              />
              <PrimaryButton
                label="코드 복사"
                onPress={copyLy}
                variant="ghost"
              />
            </>
          ) : null}
        </View>
      }
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator
      >
        <Text style={styles.eyebrow}>ALTO HARMONY · LILYPOND</Text>
        <Text style={typography.h1}>알토 악보 만들기</Text>
        <Text style={[typography.body, styles.hint]}>
          멜로디 악보(PDF/JPG/PNG)를 올리면{'\n'}
          알토 화성이 포함된 2성부 LilyPond(.ly) 코드를 만듭니다.{'\n'}
          PC에서{' '}
          <Text style={styles.mono}>python scripts/render_lilypond.py 파일.ly</Text>
          로 PNG·PDF를 렌더하세요.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result ? (
          <View style={styles.resultBox}>
            <Text style={styles.meta}>
              {result.title || result.fileName}
              {result.key ? ` · ${result.key}` : ''}
              {result.pageCount ? ` · ${result.pageCount}p` : ''}
            </Text>
            {result.note ? (
              <Text style={styles.note}>{result.note}</Text>
            ) : null}
            <Pressable onLongPress={copyLy}>
              <Text style={styles.code}>{result.lilypond}</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.empty}>
            {loading
              ? '악보를 읽고 알토 파트를 작성하는 중…'
              : '아직 생성된 코드가 없습니다. 악보를 업로드해 주세요.'}
          </Text>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: 22,
    paddingTop: 24,
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
    marginBottom: 10,
  },
  hint: {
    marginTop: 12,
    marginBottom: 18,
  },
  mono: {
    fontFamily: 'Consolas, Menlo, monospace',
    color: colors.brassBright,
    fontSize: 13,
  },
  error: {
    ...typography.caption,
    color: '#F0B0A4',
    marginBottom: 12,
    lineHeight: 18,
  },
  empty: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: 40,
  },
  resultBox: {
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.28)',
    backgroundColor: 'rgba(14, 21, 32, 0.65)',
    borderRadius: 12,
    padding: 14,
  },
  meta: {
    ...typography.bodyStrong,
    marginBottom: 6,
  },
  note: {
    ...typography.caption,
    marginBottom: 12,
  },
  code: {
    fontFamily: 'Consolas, Menlo, monospace',
    fontSize: 12,
    lineHeight: 18,
    color: colors.parchment,
  },
  actions: {
    gap: 10,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
});
