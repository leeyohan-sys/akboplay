import React, { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { api, pickPdfFileWeb } from '../services/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: Props) {
  const { width, height } = useWindowDimensions();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const pulse = React.useRef(new Animated.Value(0)).current;
  const fade = React.useRef(new Animated.Value(0)).current;

  // 작은 폰 화면에서도 버튼이 보이도록 히어로 크기 축소
  const compact = height < 720;
  const heroSize = useMemo(() => {
    const maxByHeight = compact ? height * 0.16 : height * 0.22;
    const maxByWidth = width * (compact ? 0.32 : 0.28);
    return Math.min(Math.max(maxByWidth, compact ? 88 : 120), Math.min(compact ? 140 : 200, maxByHeight));
  }, [width, height, compact]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 700,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: 2400,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: 2400,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      ),
    ]).start();

    api
      .health()
      .then(() => setServerOk(true))
      .catch(() => setServerOk(false));
  }, [fade, pulse]);

  const staffOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.18, 0.38],
  });

  const pickPdf = async () => {
    setError(null);
    try {
      setLoading(true);

      let analyzed;
      if (Platform.OS === 'web') {
        // 모바일 웹에서는 네이티브 file input이 가장 안정적
        const file = await pickPdfFileWeb();
        if (!file) {
          setLoading(false);
          return;
        }
        analyzed = await api.analyzePdfFile(file);
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: 'application/pdf',
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || !result.assets?.[0]) {
          setLoading(false);
          return;
        }
        const asset = result.assets[0];
        analyzed = await api.analyzePdf(
          asset.uri,
          asset.name || 'score.pdf',
          (asset as { file?: File }).file ?? null,
        );
      }

      if (analyzed.method === 'demo') {
        throw new Error(
          '서버가 데모 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.',
        );
      }

      // 인식 실패해도 곡 직접 추가 화면으로 진행
      navigation.navigate('Songs', { analyze: analyzed });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'PDF 분석 중 오류가 발생했습니다.';
      // 서버 502 등으로 실패해도 직접 추가할 수 있게 안내 화면으로
      if (/중단|시간|연결|Bad Gateway|502|503|504/i.test(message)) {
        navigation.navigate('Songs', {
          analyze: {
            fileName: 'score.pdf',
            method: 'heuristic',
            note: message,
            songs: [],
          },
        });
        setError(message);
        return;
      }
      setError(
        serverOk === false
          ? `${message}\n서버 연결을 확인해 주세요.`
          : message,
      );
    } finally {
      setLoading(false);
    }
  };

  const tryDemo = async () => {
    setError(null);
    setLoading(true);
    try {
      const analyzed = await api.demo();
      navigation.navigate('Songs', { analyze: analyzed });
    } catch {
      navigation.navigate('Songs', {
        analyze: {
          fileName: 'demo-score.pdf',
          method: 'demo',
          songs: [
            {
              id: '1',
              title: 'Canon in D',
              composer: 'Pachelbel',
              confidence: 0.95,
              selected: true,
            },
            {
              id: '2',
              title: 'Clair de Lune',
              composer: 'Debussy',
              confidence: 0.92,
              selected: true,
            },
            {
              id: '3',
              title: 'River Flows in You',
              composer: 'Yiruma',
              confidence: 0.9,
              selected: true,
            },
            {
              id: '4',
              title: '봄날',
              composer: 'BTS',
              confidence: 0.88,
              selected: true,
            },
          ],
        },
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenShell
      footer={
        <View style={styles.actions}>
          <PrimaryButton
            label="PDF 악보 첨부"
            onPress={pickPdf}
            loading={loading}
          />
          <PrimaryButton
            label="데모로 미리보기"
            onPress={tryDemo}
            variant="ghost"
            disabled={loading}
          />
          <PrimaryButton
            label="BPM 탐지"
            onPress={() => navigation.navigate('BeatDetect')}
            variant="ghost"
            disabled={loading}
          />
          <PrimaryButton
            label="알토 악보 만들기"
            onPress={() => navigation.navigate('AltoScore')}
            variant="ghost"
            disabled={loading}
          />
        </View>
      }
    >
      <StatusBar style="light" />
      <Animated.View
        style={[styles.staffWrap, { opacity: staffOpacity, pointerEvents: 'none' }]}
      >        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={[styles.staffLine, { top: 40 + i * 28 }]} />
        ))}
      </Animated.View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator
      >
        <Animated.View style={{ opacity: fade }}>
          <Text style={styles.eyebrow}>PDF SCORE → YOUTUBE</Text>
          <Text style={[typography.brand, compact && styles.brandCompact]}>
            악보플레이
          </Text>
          <Text style={[typography.body, styles.sub, compact && styles.subCompact]}>
            악보 PDF를 올리면 곡을 찾아{'\n'}유튜브 플레이리스트로 만들어 드립니다.
          </Text>

          <View
            style={[
              styles.heroMark,
              {
                width: heroSize,
                height: heroSize,
                borderRadius: heroSize / 2,
                marginVertical: compact ? 16 : 28,
              },
            ]}
          >
            <Text style={[styles.clef, { fontSize: heroSize * 0.42 }]}>𝄞</Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Text style={styles.serverHint}>
            {serverOk === null
              ? '서버 연결 확인 중…'
              : serverOk
                ? `서버 연결됨 · ${api.baseUrl}`
                : '서버 미연결 · 데모는 사용 가능'}
          </Text>
        </Animated.View>
      </ScrollView>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 22,
    paddingTop: Platform.OS === 'web' ? 20 : 36,
    paddingBottom: 16,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  eyebrow: {
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 11,
    letterSpacing: 2.4,
    color: colors.brass,
    marginBottom: 10,
  },
  brandCompact: {
    fontSize: 28,
  },
  sub: {
    marginTop: 14,
    marginBottom: 8,
  },
  subCompact: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  heroMark: {
    alignSelf: 'center',
    marginVertical: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(201, 162, 39, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.28)',
  },
  clef: {
    color: colors.brassBright,
    marginTop: -8,
  },
  actions: {
    gap: 10,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  error: {
    ...typography.caption,
    color: '#F0B0A4',
    marginTop: 8,
    lineHeight: 18,
  },
  serverHint: {
    ...typography.caption,
    marginTop: 16,
    textAlign: 'center',
    fontSize: 11,
  },
  staffWrap: {
    position: 'absolute',
    top: '12%',
    left: 0,
    right: 0,
    height: 180,
  },
  staffLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.parchment,
  },
});
