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

  // onset 위상 보정용
  const nextBeatAtRef = useRef(0);
  const periodRef = useRef(0);

  const flashBeat = useCallback(
    (beatIndex: number) => {
      setBeat(beatIndex);
      flash.stopAnimation();
      flash.setValue(beatIndex === 1 ? 0.95 : 0.75);
      Animated.timing(flash, {
        toValue: 0,
        duration: beatIndex === 1 ? 260 : 160,
        useNativeDriver: false,
      }).start();
    },
    [flash],
  );

  const flashBeatRef = useRef(flashBeat);
  flashBeatRef.current = flashBeat;

  /**
   * BPM이 잡히면(>0) 자동으로 그 주기에 맞춰 4박 점멸.
   * listening + bpm 상태에만 의존해 확실히 시작/재시작한다.
   */
  useEffect(() => {
    if (!listening || bpm <= 0) {
      nextBeatAtRef.current = 0;
      periodRef.current = 0;
      return;
    }

    const period = 60000 / bpm;
    periodRef.current = period;
    let beatIndex = 0;
    let cancelled = false;
    let rafId = 0;

    // BPM 확정 즉시 1박부터 점멸 시작
    beatIndex = 1;
    flashBeatRef.current(1);
    nextBeatAtRef.current = performance.now() + period;

    const tick = (now: number) => {
      if (cancelled) return;
      const p = periodRef.current || period;
      // 밀린 박은 최대 1개만 따라잡아 연속 깜빡임 폭주 방지
      if (now >= nextBeatAtRef.current) {
        beatIndex = (beatIndex % 4) + 1;
        flashBeatRef.current(beatIndex);
        // 한 박만 진행. 너무 밀렸으면 지금 기준으로 재정렬
        if (now - nextBeatAtRef.current > p) {
          nextBeatAtRef.current = now + p;
        } else {
          nextBeatAtRef.current += p;
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [listening, bpm]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setListening(false);
    setBeat(0);
    setLevel(0);
    setBpm(0);
    nextBeatAtRef.current = 0;
    periodRef.current = 0;
  }, []);

  useEffect(() => () => stop(), [stop]);

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
      const handle = await startBeatDetector({
        onBpm: (next) => {
          // BPM이 바뀌면 useEffect가 자동으로 점멸 주기를 재시작
          setBpm((prev) => (prev === next ? prev : next));
        },
        // 마이크 onset으로 다음 박 시각만 살짝 맞춤 (점멸 자체는 BPM 타이머)
        onOnset: (timeMs) => {
          const p = periodRef.current;
          if (p <= 0 || nextBeatAtRef.current <= 0) return;
          const prevBeatAt = nextBeatAtRef.current - p;
          let err = timeMs - prevBeatAt;
          err = ((err % p) + p) % p;
          if (err > p / 2) err -= p;
          if (Math.abs(err) < p * 0.35) {
            nextBeatAtRef.current = timeMs + p;
          }
        },
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
    <View style={styles.root}>
      {/* 전체화면 점멸 */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.flash,
          {
            opacity: flash,
            backgroundColor:
              beat === 1
                ? 'rgba(224, 188, 58, 0.7)'
                : 'rgba(201, 162, 39, 0.45)',
          },
        ]}
      />

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
        <View style={styles.body}>
          <Text style={styles.eyebrow}>BEAT DETECTOR · 4/4</Text>
          <Text style={typography.h1}>BPM 탐지</Text>
          <Text style={[typography.body, styles.hint]}>
            BPM이 측정되면 그 박자에 맞춰{'\n'}
            화면이 자동으로 4박 점멸합니다.
          </Text>

          <Text style={styles.bpmLabel}>BPM</Text>
          <Text style={styles.bpmValue}>{bpm > 0 ? bpm : '—'}</Text>
          <Text style={styles.status}>
            {listening
              ? bpm > 0
                ? `${bpm} BPM · 자동 점멸 중`
                : '듣는 중… BPM 측정 중'
              : '대기 중'}
          </Text>

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({
          height: '100%' as unknown as number,
          position: 'relative' as unknown as 'relative',
        } as object)
      : null),
  },
  flash: {
    ...StyleSheet.absoluteFill,
    zIndex: 2000,
    elevation: 2000,
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
