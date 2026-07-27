import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import {
  isBeatDetectorSupported,
  startBeatDetector,
  type BeatDetectorHandle,
} from '../services/beatDetector';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'BeatDetect'>;

export function BeatDetectScreen({}: Props) {
  const [listening, setListening] = useState(false);
  const [bpm, setBpm] = useState(0);
  const [beat, setBeat] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<BeatDetectorHandle | null>(null);
  const flash = useRef(new Animated.Value(0)).current;

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setListening(false);
    setBeat(0);
    setLevel(0);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const flashBeat = useCallback(
    (beatIndex: number) => {
      setBeat(beatIndex);
      flash.setValue(0.85);
      Animated.timing(flash, {
        toValue: 0,
        duration: beatIndex === 1 ? 220 : 140,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    },
    [flash],
  );

  const start = async () => {
    setError(null);
    if (!isBeatDetectorSupported()) {
      setError(
        '마이크 비트 탐지는 웹 브라우저에서 사용할 수 있습니다. 마이크 권한을 허용해 주세요.',
      );
      return;
    }
    try {
      stop();
      setBpm(0);
      setBeat(0);
      const handle = await startBeatDetector({
        onBeat: (beatIndex, nextBpm) => {
          flashBeat(beatIndex);
          if (nextBpm > 0) setBpm(nextBpm);
        },
        onBpm: (next) => setBpm(next),
        onLevel: (lv) => setLevel(lv),
        onError: (msg) => setError(msg),
      });
      handleRef.current = handle;
      setListening(true);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : '마이크를 열 수 없습니다. 권한을 확인해 주세요.';
      setError(msg);
      setListening(false);
    }
  };

  return (
    <ScreenShell
      footer={
        <View style={styles.actions}>
          {listening ? (
            <PrimaryButton label="탐지 중지" onPress={stop} variant="danger" />
          ) : (
            <PrimaryButton label="마이크 비트 탐지 시작" onPress={start} />
          )}
        </View>
      }
    >
      {/* 비트에 맞춰 화면 깜박임 */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.flash,
          {
            opacity: flash,
            backgroundColor:
              beat === 1
                ? 'rgba(224, 188, 58, 0.55)'
                : 'rgba(201, 162, 39, 0.32)',
          },
        ]}
      />

      <View style={styles.body}>
        <Text style={styles.eyebrow}>BEAT DETECTOR · 4/4</Text>
        <Text style={typography.h1}>BPM 탐지</Text>
        <Text style={[typography.body, styles.hint]}>
          음악이 나오는 곳에서 시작을 누르면{'\n'}
          마이크가 비트를 듣고 화면이 4박으로 깜박입니다.
        </Text>

        <Text style={styles.bpmLabel}>BPM</Text>
        <Text style={styles.bpmValue}>{bpm > 0 ? bpm : '—'}</Text>
        <Text style={styles.status}>
          {listening
            ? bpm > 0
              ? '비트 추적 중'
              : '듣는 중… 비트를 찾는 중'
            : '대기 중'}
        </Text>

        {/* 4비트 인디케이터 */}
        <View style={styles.beats}>
          {[1, 2, 3, 4].map((n) => {
            const active = beat === n;
            return (
              <View
                key={n}
                style={[
                  styles.beatDot,
                  active && styles.beatDotActive,
                  n === 1 && active && styles.beatDotOne,
                ]}
              >
                <Text
                  style={[styles.beatNum, active && styles.beatNumActive]}
                >
                  {n}
                </Text>
              </View>
            );
          })}
        </View>

        {/* 입력 레벨 */}
        <View style={styles.levelTrack}>
          <View
            style={[
              styles.levelFill,
              { width: `${Math.round(Math.min(1, level) * 100)}%` },
            ]}
          />
        </View>
        <Text style={styles.levelHint}>마이크 입력 레벨</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  flash: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
  },
  body: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 28,
    alignItems: 'center',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  eyebrow: {
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 11,
    letterSpacing: 2.2,
    color: colors.brass,
    marginBottom: 10,
  },
  hint: {
    marginTop: 12,
    textAlign: 'center',
    marginBottom: 28,
  },
  bpmLabel: {
    ...typography.caption,
    letterSpacing: 3,
    color: colors.brass,
  },
  bpmValue: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    fontSize: 88,
    fontWeight: '700',
    color: colors.cream,
    lineHeight: 100,
    marginTop: 4,
  },
  status: {
    ...typography.caption,
    marginBottom: 28,
  },
  beats: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 28,
  },
  beatDot: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: 'rgba(201, 162, 39, 0.35)',
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  beatDotActive: {
    borderColor: colors.brassBright,
    backgroundColor: 'rgba(201, 162, 39, 0.35)',
    transform: [{ scale: 1.08 }],
  },
  beatDotOne: {
    backgroundColor: 'rgba(224, 188, 58, 0.55)',
  },
  beatNum: {
    ...typography.bodyStrong,
    color: colors.mist,
    fontSize: 18,
  },
  beatNumActive: {
    color: colors.cream,
  },
  levelTrack: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(30, 44, 68, 0.8)',
    overflow: 'hidden',
  },
  levelFill: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  levelHint: {
    ...typography.caption,
    marginTop: 8,
    marginBottom: 12,
  },
  error: {
    ...typography.caption,
    color: '#F0B0A4',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  actions: {
    gap: 10,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
});
