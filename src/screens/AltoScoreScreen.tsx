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
import { saveScoreTextFile } from '../utils/saveFile';
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
    input.accept =
      'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp';
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

function buildLyFileName(result: AltoResult): string {
  return (
    (result.title || result.fileName || 'alto-score')
      .replace(/\.(pdf|png|jpe?g|webp)$/i, '')
      .replace(/[^\w가-힣\-]+/g, '_') + '.ly'
  );
}

export function AltoScoreScreen({}: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
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

  /** 모바일/웹에서 악보 파일 저장·공유 */
  const downloadLy = useCallback(
    async (target?: AltoResult) => {
      const data = target ?? result;
      if (!data?.lilypond) return;
      setSaving(true);
      try {
        const name = buildLyFileName(data);
        const status = await saveScoreTextFile(name, data.lilypond, {
          ext: 'ly',
          mime: 'text/x-lilypond;charset=utf-8',
        });
        if (status === 'shared') {
          showAlert(
            '공유 완료',
            '공유 시트에서 "파일에 저장" 또는 원하는 앱을 선택하세요.',
          );
        } else if (status === 'downloaded') {
          showAlert('다운로드', `${name} 저장을 시작했습니다.`);
        } else if (status === 'opened') {
          showAlert(
            '새 탭에서 열림',
            '브라우저 메뉴(공유)에서 파일을 저장할 수 있습니다.',
          );
        } else {
          // 최후: txt 저장 재시도
          const txtStatus = await saveScoreTextFile(
            name.replace(/\.ly$/i, '.txt'),
            data.lilypond,
            { ext: 'txt', mime: 'text/plain;charset=utf-8' },
          );
          if (txtStatus === 'failed') {
            showAlert(
              '저장 실패',
              '이 브라우저에서는 파일 저장이 제한됩니다. "코드 복사" 후 메모장에 붙여넣기 해 주세요.',
            );
          }
        }
      } finally {
        setSaving(false);
      }
    },
    [result],
  );

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
      // 생성 직후 모바일에서 바로 저장/공유 유도
      if (Platform.OS === 'web' && analyzed.lilypond) {
        // UI에 결과가 먼저 보이도록 한 프레임 뒤 호출
        setTimeout(() => {
          void downloadLy(analyzed);
        }, 300);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '알토 악보 생성에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

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
                label="악보 파일 다운로드"
                onPress={() => downloadLy()}
                variant="ghost"
                loading={saving}
              />
              <PrimaryButton
                label="코드 복사"
                onPress={copyLy}
                variant="ghost"
                disabled={saving}
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
          알토 화성이 포함된 2성부 LilyPond(.ly) 파일을 만들고{'\n'}
          모바일에서는 공유 시트로 저장할 수 있습니다.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result ? (
          <View style={styles.resultBox}>
            <Text style={styles.meta}>
              {result.title || result.fileName}
              {result.key ? ` · ${result.key}` : ''}
              {result.pageCount ? ` · ${result.pageCount}p` : ''}
            </Text>
            <Text style={styles.note}>
              아래에서 코드를 확인하거나, 하단 "악보 파일 다운로드"로 폰에
              저장하세요.
            </Text>
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
