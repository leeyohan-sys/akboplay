import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import {
  bpmFromTapTimes,
  isBeatDetectorSupported,
  startBeatDetector,
  tempoDrift,
  type BeatDetectorHandle,
} from '../services/beatDetector';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import type { RootStackParamList } from '../navigation/types';
import { TAP_BPM_PRESETS, clampBpm } from '../utils/tapBpmPresets';

type Props = NativeStackScreenProps<RootStackParamList, 'BeatDetect'>;
type Mode = 'auto' | 'tap';

function formatBpm(bpm: number): string {
  if (bpm <= 0) return '—';
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}

export function BeatDetectScreen({}: Props) {
  const [mode, setMode] = useState<Mode>('auto');
  const [listening, setListening] = useState(false);
  const [bpm, setBpm] = useState(0);
  const [guideBpm, setGuideBpm] = useState(0);
  const [beat, setBeat] = useState(0);
  const [level, setLevel] = useState(0);
  const [tapCount, setTapCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<number | null>(null);

  const handleRef = useRef<BeatDetectorHandle | null>(null);
  const flash = useRef(new Animated.Value(0)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const tapTimesRef = useRef<number[]>([]);
  const nextBeatAtRef = useRef(0);
  const periodRef = useRef(0);
  const beatIndexRef = useRef(0);

  const flashBeat = useCallback(
    (beatIndex: number) => {
      setBeat(beatIndex);
      flash.stopAnimation();
      pulseScale.stopAnimation();
      flash.setValue(beatIndex === 1 ? 0.95 : 0.7);
      pulseScale.setValue(1.12);
      Animated.parallel([
        Animated.timing(flash, {
          toValue: 0,
          duration: beatIndex === 1 ? 280 : 160,
          useNativeDriver: false,
        }),
        Animated.timing(pulseScale, {
          toValue: 1,
          duration: beatIndex === 1 ? 280 : 160,
          useNativeDriver: false,
        }),
      ]).start();
    },
    [flash, pulseScale],
  );

  const flashBeatRef = useRef(flashBeat);
  flashBeatRef.current = flashBeat;

  /** 프리셋 BPM 눌러 점멸 시작 */
  const applyPresetBpm = useCallback((index: number) => {
    const n = TAP_BPM_PRESETS[index];
    if (!n) return;
    setError(null);
    setActivePreset(index);
    setBpm(n);
    tapTimesRef.current = [];
    setTapCount(0);
  }, []);

  /** 원 옆 −/+ 로 BPM 미세 조절 */
  const nudgeBpm = useCallback((delta: number) => {
    setBpm((prev) => {
      const base = prev > 0 ? prev : 90;
      return clampBpm(base + delta);
    });
    setActivePreset(null);
    setError(null);
    tapTimesRef.current = [];
    setTapCount(0);
  }, []);

  // BPM이 잡히면(프리셋/−/+/탭/자동감지) 해당 주기로 4박 점멸
  useEffect(() => {
    if (bpm <= 0) {
      nextBeatAtRef.current = 0;
      periodRef.current = 0;
      return;
    }

    const period = 60000 / bpm;
    periodRef.current = period;
    let cancelled = false;
    let rafId = 0;

    beatIndexRef.current = 1;
    flashBeatRef.current(1);
    nextBeatAtRef.current = performance.now() + period;

    const tick = (now: number) => {
      if (cancelled) return;
      const p = periodRef.current || period;
      if (now >= nextBeatAtRef.current) {
        beatIndexRef.current = (beatIndexRef.current % 4) + 1;
        flashBeatRef.current(beatIndexRef.current);
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
  }, [bpm]);

  const stopAuto = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setListening(false);
    setLevel(0);
  }, []);

  const resetAll = useCallback(() => {
    stopAuto();
    setBpm(0);
    setGuideBpm(0);
    setBeat(0);
    setTapCount(0);
    tapTimesRef.current = [];
    nextBeatAtRef.current = 0;
    periodRef.current = 0;
    beatIndexRef.current = 0;
  }, [stopAuto]);

  useEffect(() => () => stopAuto(), [stopAuto]);

  const startAuto = async () => {
    setError(null);
    if (!isBeatDetectorSupported()) {
      setError(
        '마이크 비트 탐지는 웹 브라우저에서 사용할 수 있습니다. 마이크 권한을 허용해 주세요.',
      );
      return;
    }
    try {
      stopAuto();
      setBpm(0);
      setBeat(0);
      const handle = await startBeatDetector({
        onBpm: (next) => setBpm((prev) => (Math.abs(prev - next) < 0.05 ? prev : next)),
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
      if (guideBpm > 0) handle.setGuideBpm(guideBpm);
      handleRef.current = handle;
      setListening(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '마이크를 열 수 없습니다. 권한을 확인해 주세요.',
      );
      setListening(false);
    }
  };

  /** 전체화면 탭: 탭모드=템포 측정 / 자동모드=가이드 템포 */
  const onScreenTap = () => {
    const now = performance.now();
    // 오래된 탭 제거 (3초 이상 간격이면 리셋)
    const taps = tapTimesRef.current;
    if (taps.length && now - taps[taps.length - 1] > 3000) {
      tapTimesRef.current = [];
    }
    tapTimesRef.current.push(now);
    if (tapTimesRef.current.length > 12) tapTimesRef.current.shift();
    setTapCount(tapTimesRef.current.length);

    const tapped = bpmFromTapTimes(tapTimesRef.current);

    if (mode === 'tap') {
      if (tapped > 0) {
        setBpm(tapped);
        setActivePreset(null);
      }
      // 탭 즉시 비주얼 피드백
      beatIndexRef.current = (beatIndexRef.current % 4) + 1;
      flashBeat(beatIndexRef.current);
      return;
    }

    // 자동 모드: 탭으로 가이드 템포 잠금
    if (tapped > 0) {
      setGuideBpm(tapped);
      handleRef.current?.setGuideBpm(tapped);
      if (!listening) {
        // 가이드만 잡고 BPM 표시 → 점멸 시작, 마이크는 버튼으로
        setBpm(tapped);
      }
    }
  };

  const applyHalfDouble = (factor: 0.5 | 2) => {
    if (bpm <= 0) return;
    const next = Math.round(bpm * factor * 10) / 10;
    if (next < 40 || next > 220) return;
    setBpm(next);
    if (mode === 'auto' && guideBpm > 0) {
      const g = Math.round(guideBpm * factor * 10) / 10;
      setGuideBpm(g);
      handleRef.current?.setGuideBpm(g);
    }
  };

  const drift =
    guideBpm > 0 && bpm > 0 ? tempoDrift(bpm, guideBpm) : 0;
  const driftLabel =
    guideBpm > 0 && bpm > 0
      ? `${drift > 0 ? '+' : ''}${drift.toFixed(1)}`
      : null;

  const switchMode = (next: Mode) => {
    resetAll();
    setMode(next);
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
                ? 'rgba(224, 188, 58, 0.72)'
                : 'rgba(201, 162, 39, 0.42)',
          },
        ]}
      />

      <ScreenShell
        footer={
          <View style={styles.actions}>
            {mode === 'auto' ? (
              listening ? (
                <PrimaryButton label="탐지 중지" onPress={stopAuto} variant="danger" />
              ) : (
                <PrimaryButton label="마이크 자동 감지 시작" onPress={startAuto} />
              )
            ) : (
              <View style={styles.tapFooter}>
                <Text style={styles.presetHint}>
                  프리셋을 누르면 그 템포로 점멸
                </Text>
                <View style={styles.presetRow}>
                  {TAP_BPM_PRESETS.map((value, index) => {
                    const active = activePreset === index && bpm === value;
                    return (
                      <Pressable
                        key={value}
                        onPress={() => applyPresetBpm(index)}
                        style={[
                          styles.presetBtn,
                          active && styles.presetBtnActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.presetBtnText,
                            active && styles.presetBtnTextActive,
                          ]}
                        >
                          {value}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <PrimaryButton label="탭 초기화" onPress={resetAll} variant="ghost" />
              </View>
            )}
          </View>
        }
      >
        <View style={styles.body}>
            <Text style={styles.eyebrow}>LIVE BPM · 4/4</Text>

            {/* 모드 전환 */}
            <View style={styles.modeRow}>
              <Pressable
                onPress={() => switchMode('auto')}
                style={[styles.modeChip, mode === 'auto' && styles.modeChipOn]}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    mode === 'auto' && styles.modeChipTextOn,
                  ]}
                >
                  자동 감지
                </Text>
              </Pressable>
              <Pressable
                onPress={() => switchMode('tap')}
                style={[styles.modeChip, mode === 'tap' && styles.modeChipOn]}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    mode === 'tap' && styles.modeChipTextOn,
                  ]}
                >
                  탭 템포
                </Text>
              </Pressable>
            </View>

            <Text style={[typography.body, styles.hint]}>
              {mode === 'auto'
                ? '마이크가 BPM을 듣고 4박으로 점멸합니다.'
                : '프리셋 또는 −/+ 로 BPM을 정하면 점멸합니다.'}
            </Text>

            {/* 대형 BPM + −/+ */}
            <View style={styles.bpmRow}>
              <Pressable
                onPress={() => nudgeBpm(-1)}
                style={styles.nudgeBtn}
                hitSlop={8}
              >
                <Text style={styles.nudgeBtnText}>−</Text>
              </Pressable>

              <Pressable onPress={onScreenTap} style={styles.tapTarget}>
                <Animated.View
                  style={[
                    styles.pulseRing,
                    { transform: [{ scale: pulseScale }] },
                  ]}
                >
                  <Text style={styles.bpmLabel}>BPM</Text>
                  <Text style={styles.bpmValue}>{formatBpm(bpm)}</Text>
                </Animated.View>
              </Pressable>

              <Pressable
                onPress={() => nudgeBpm(1)}
                style={styles.nudgeBtn}
                hitSlop={8}
              >
                <Text style={styles.nudgeBtnText}>+</Text>
              </Pressable>
            </View>

            {/* 4박 인디케이터 — 크게, 원 바로 아래 */}
            <Text style={styles.beatsLabel}>4 BEATS</Text>
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

            <Text style={styles.status}>
              {mode === 'tap'
                ? bpm > 0
                  ? activePreset != null
                    ? `프리셋 ${TAP_BPM_PRESETS[activePreset]} · 점멸 중`
                    : `${formatBpm(bpm)} BPM · 점멸 중`
                  : '프리셋 또는 −/+ 로 BPM을 정하세요'
                : listening
                  ? bpm > 0
                    ? guideBpm > 0
                      ? `가이드 ${formatBpm(guideBpm)} · 자동 점멸`
                      : `${formatBpm(bpm)} BPM · 자동 점멸`
                    : '듣는 중… BPM 측정 중'
                  : guideBpm > 0
                    ? `가이드 ${formatBpm(guideBpm)} · 시작을 누르세요`
                    : '대기 중 · 시작 버튼을 누르세요'}
            </Text>

            {/* ×½ / ×2 */}
            <View style={styles.factorRow}>
              <Pressable
                onPress={() => applyHalfDouble(0.5)}
                style={styles.factorBtn}
              >
                <Text style={styles.factorBtnText}>×½</Text>
              </Pressable>
              <Pressable
                onPress={() => applyHalfDouble(2)}
                style={styles.factorBtn}
              >
                <Text style={styles.factorBtnText}>×2</Text>
              </Pressable>
              {guideBpm > 0 ? (
                <Pressable
                  onPress={() => {
                    setGuideBpm(0);
                    handleRef.current?.setGuideBpm(0);
                  }}
                  style={styles.factorBtn}
                >
                  <Text style={styles.factorBtnText}>가이드 해제</Text>
                </Pressable>
              ) : null}
            </View>

            {mode === 'auto' ? (
              <View style={styles.levelTrack}>
                <View
                  style={[
                    styles.levelFill,
                    {
                      width: `${Math.round(Math.min(1, level) * 100)}%`,
                    },
                  ]}
                />
              </View>
            ) : null}

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
      ? ({ height: '100%' as unknown as number } as object)
      : null),
  },
  flash: {
    ...StyleSheet.absoluteFill,
    zIndex: 2000,
    elevation: 2000,
  },
  body: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 12,
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
    marginBottom: 8,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  modeChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.35)',
    backgroundColor: 'rgba(30, 44, 68, 0.45)',
  },
  modeChipOn: {
    borderColor: colors.brassBright,
    backgroundColor: 'rgba(201, 162, 39, 0.28)',
  },
  modeChipText: {
    ...typography.caption,
    color: colors.mist,
    fontSize: 13,
  },
  modeChipTextOn: {
    color: colors.cream,
    fontWeight: '700',
  },
  hint: {
    marginTop: 2,
    textAlign: 'center',
    marginBottom: 10,
    fontSize: 13,
    lineHeight: 18,
  },
  bpmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 14,
  },
  nudgeBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: 'rgba(201, 162, 39, 0.55)',
    backgroundColor: 'rgba(30, 44, 68, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nudgeBtnText: {
    color: colors.brassBright,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 32,
    marginTop: -2,
  },
  tapTarget: {
    marginBottom: 0,
  },
  pulseRing: {
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 2,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bpmLabel: {
    ...typography.caption,
    letterSpacing: 3,
    color: colors.brass,
  },
  bpmValue: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    fontSize: 48,
    fontWeight: '700',
    color: colors.cream,
    lineHeight: 56,
    marginTop: 2,
  },
  drift: {
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  driftUp: { color: '#E08A6A' },
  driftDown: { color: '#6AB0E0' },
  driftOk: { color: colors.success },
  driftPlaceholder: {
    fontSize: 14,
    marginTop: 2,
    color: colors.mist,
    letterSpacing: 2,
  },
  beatsLabel: {
    ...typography.caption,
    letterSpacing: 2,
    color: colors.brass,
    marginBottom: 8,
    fontSize: 11,
  },
  beats: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: 360,
    gap: 10,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  beatDot: {
    flex: 1,
    aspectRatio: 1,
    maxHeight: 78,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: 'rgba(201, 162, 39, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  beatDotActive: {
    borderColor: colors.brassBright,
    backgroundColor: 'rgba(224, 188, 58, 0.45)',
    transform: [{ scale: 1.04 }],
  },
  beatDotOne: {
    backgroundColor: 'rgba(224, 188, 58, 0.72)',
  },
  beatNum: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    color: colors.cream,
    fontSize: 28,
    fontWeight: '700',
  },
  beatNumActive: {
    color: colors.ink,
  },
  status: {
    ...typography.caption,
    marginBottom: 10,
    textAlign: 'center',
    lineHeight: 18,
    color: colors.parchmentDim,
  },
  factorRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  factorBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(201, 162, 39, 0.5)',
    backgroundColor: 'rgba(30, 44, 68, 0.7)',
  },
  factorBtnText: {
    ...typography.caption,
    color: colors.brassBright,
    fontSize: 14,
    fontWeight: '700',
  },
  levelTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(30, 44, 68, 0.8)',
    overflow: 'hidden',
    marginTop: 4,
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
  tapFooter: {
    gap: 10,
    width: '100%',
  },
  presetHint: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.mist,
    fontSize: 11,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    justifyContent: 'center',
  },
  presetBtn: {
    flex: 1,
    maxWidth: 88,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(201, 162, 39, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetBtnActive: {
    backgroundColor: 'rgba(224, 188, 58, 0.5)',
    borderColor: colors.brassBright,
  },
  presetBtnText: {
    ...typography.bodyStrong,
    color: colors.brassBright,
    fontSize: 18,
  },
  presetBtnTextActive: {
    color: colors.cream,
  },
});
