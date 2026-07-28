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

  // 메트로놈 상태 (BPM 타이머)
  const bpmRef = useRef(0);
  const beatIndexRef = useRef(0);
  const nextBeatAtRef = useRef(0);
  const metroRafRef = useRef(0);
  const listeningRef = useRef(false);

  const stopMetronome = useCallback(() => {
    if (metroRafRef.current) {
      cancelAnimationFrame(metroRafRef.current);
      metroRafRef.current = 0;
    }
    beatIndexRef.current = 0;
    nextBeatAtRef.current = 0;
  }, []);

  const flashBeat = useCallback(
    (beatIndex: number) => {
      setBeat(beatIndex);
      flash.setValue(beatIndex === 1 ? 0.92 : 0.72);
      Animated.timing(flash, {
        toValue: 0,
        duration: beatIndex === 1 ? 240 : 150,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    },
    [flash],
  );

  const flashBeatRef = useRef(flashBeat);
  flashBeatRef.current = flashBeat;

  // BPM 기준 4박 타이머 (rAF로 드리프트 최소화)
  const runMetronome = useCallback(() => {
    const tick = (now: number) => {
      if (!listeningRef.current) return;
      const currentBpm = bpmRef.current;
      if (currentBpm > 0) {
        const period = 60000 / currentBpm;
        if (nextBeatAtRef.current <= 0) {
          nextBeatAtRef.current = now;
        }
        // 탭이 밀리면 따라잡기 (최대 2박)
        let guard = 0;
        while (now >= nextBeatAtRef.current && guard < 2) {
          beatIndexRef.current = (beatIndexRef.current % 4) + 1;
          flashBeatRef.current(beatIndexRef.current);
          nextBeatAtRef.current += period;
          guard += 1;
        }
        // 너무 뒤처지면 위상 리셋
        if (now - nextBeatAtRef.current > period * 2) {
          nextBeatAtRef.current = now + period;
        }
      }
      metroRafRef.current = requestAnimationFrame(tick);
    };
    if (metroRafRef.current) cancelAnimationFrame(metroRafRef.current);
    metroRafRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(() => {
    listeningRef.current = false;
    handleRef.current?.stop();
    handleRef.current = null;
    stopMetronome();
    setListening(false);
    setBeat(0);
    setLevel(0);
    bpmRef.current = 0;
  }, [stopMetronome]);

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
      setBpm(0);
      setBeat(0);
      bpmRef.current = 0;
      beatIndexRef.current = 0;
      nextBeatAtRef.current = 0;

      const handle = await startBeatDetector({
        onBpm: (next) => {
          const prev = bpmRef.current;
          bpmRef.current = next;
          setBpm(next);
          // 첫 BPM 확정 시 메트로놈 시작 / BPM 변경 시 주기만 갱신(위상 유지)
          if (prev <= 0 && next > 0) {
            nextBeatAtRef.current = performance.now();
            beatIndexRef.current = 0;
            runMetronome();
          } else if (prev > 0 && next > 0 && next !== prev) {
            // 남은 대기 시간을 새 주기에 비례 스케일
            const now = performance.now();
            const oldPeriod = 60000 / prev;
            const newPeriod = 60000 / next;
            const remain = Math.max(0, nextBeatAtRef.current - now);
            const ratio = remain / oldPeriod;
            nextBeatAtRef.current = now + ratio * newPeriod;
          }
        },
        // onset으로 메트로놈 위상 동기화
        onOnset: (timeMs) => {
          if (bpmRef.current <= 0) return;
          const period = 60000 / bpmRef.current;
          if (nextBeatAtRef.current <= 0) {
            nextBeatAtRef.current = timeMs + period;
            return;
          }
          // 직전 예정 박과의 오차
          const prevBeatAt = nextBeatAtRef.current - period;
          let err = timeMs - prevBeatAt;
          // -period/2 ~ +period/2 로 정규화
          err = ((err % period) + period) % period;
          if (err > period / 2) err -= period;
          // ±35% 이내면 onset 시각을 박으로 채택하고 다음 박 재설정
          if (Math.abs(err) < period * 0.35) {
            nextBeatAtRef.current = timeMs + period;
          }
        },
        onLevel: (lv) => setLevel(lv),
        onError: (msg) => setError(msg),
      });
      handleRef.current = handle;
      listeningRef.current = true;
      setListening(true);
      runMetronome();
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : '마이크를 열 수 없습니다. 권한을 확인해 주세요.';
      setError(msg);
      setListening(false);
      listeningRef.current = false;
    }
  };

  return (
    <View style={styles.root}>
      {/* 전체화면 점멸 (본문·푸터·세이프영역 포함) */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.flash,
          {
            opacity: flash,
            backgroundColor:
              beat === 1
                ? 'rgba(224, 188, 58, 0.62)'
                : 'rgba(201, 162, 39, 0.38)',
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
            음악 BPM을 안정적으로 측정하고{'\n'}
            그 박자에 맞춰 화면이 4박으로 깜박입니다.
          </Text>

          <Text style={styles.bpmLabel}>BPM</Text>
          <Text style={styles.bpmValue}>{bpm > 0 ? bpm : '—'}</Text>
          <Text style={styles.status}>
            {listening
              ? bpm > 0
                ? 'BPM 락 · 4박 점멸 중'
                : '듣는 중… BPM 안정화 중'
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    ...(Platform.OS === 'web'
      ? ({
          height: '100%' as unknown as number,
          position: 'relative' as unknown as 'absolute',
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
