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
  // 탭 템포를 기본·우선 모드로
  const [mode, setMode] = useState<Mode>('tap');
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

  /** 원 옆 −/+ 로 BPM 1씩 조절 (정수만) */
  const nudgeBpm = useCallback((delta: number) => {
    setBpm((prev) => {
      const base = prev > 0 ? Math.round(prev) : 90;
      return clampBpm(base + delta);
    });
    setActivePreset(null);
    setError(null);
    tapTimesRef.current = [];
    setTapCount(0);
  }, []);

  // 탭 템포: BPM만 있으면 점멸 / 자동감지: 듣는 중에만 점멸
  useEffect(() => {
    const shouldFlash =
      bpm > 0 && (mode === 'tap' || (mode === 'auto' && listening));
    if (!shouldFlash) {
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
  }, [bpm, mode, listening]);

  const stopAuto = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setListening(false);
    setLevel(0);
    setBeat(0);
    flash.setValue(0);
  }, [flash]);

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
        onBpm: (next) => {
          const rounded = Math.round(next);
          setBpm((prev) => (prev === rounded ? prev : rounded));
        },
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

  /** 탭 템포 모드: 원을 탭해 BPM 측정 */
  const onScreenTap = () => {
    if (mode !== 'tap') return;

    const now = performance.now();
    const taps = tapTimesRef.current;
    if (taps.length && now - taps[taps.length - 1] > 3000) {
      tapTimesRef.current = [];
    }
    tapTimesRef.current.push(now);
    if (tapTimesRef.current.length > 12) tapTimesRef.current.shift();
    setTapCount(tapTimesRef.current.length);

    const tapped = bpmFromTapTimes(tapTimesRef.current);
    if (tapped > 0) {
      setBpm(Math.round(tapped));
      setActivePreset(null);
    }
    beatIndexRef.current = (beatIndexRef.current % 4) + 1;
    flashBeat(beatIndexRef.current);
  };

  const applyHalfDouble = (factor: 0.5 | 2) => {
    if (bpm <= 0) return;
    const next = clampBpm(Math.round(bpm) * factor);
    if (next < 40 || next > 220) return;
    setBpm(next);
    setActivePreset(null);
  };

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

      {/* fixed 푸터 없이 본문에 모두 배치 → 잘림 방지 */}
      <ScreenShell>
        <View style={styles.body}>
          <View style={styles.topBlock}>
            {/* 탭 템포 → 자동 감지 순 */}
            <View style={styles.modeRow}>
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
            </View>

            {/* BPM + −/+ */}
            <View style={styles.bpmRow}>
              <Pressable
                onPress={() => nudgeBpm(-1)}
                style={styles.nudgeBtn}
                hitSlop={8}
              >
                <Text style={styles.nudgeBtnText}>−</Text>
              </Pressable>

              {mode === 'tap' ? (
                <Pressable onPress={onScreenTap} style={styles.tapTarget}>
                  <Animated.View
                    style={[
                      styles.pulseRing,
                      styles.pulseRingTap,
                      { transform: [{ scale: pulseScale }] },
                    ]}
                  >
                    <Text style={styles.bpmLabel}>BPM</Text>
                    <Text style={styles.bpmValue}>{formatBpm(bpm)}</Text>
                    <Text style={styles.tapBadge}>탭</Text>
                  </Animated.View>
                </Pressable>
              ) : (
                <View style={styles.tapTarget}>
                  <Animated.View
                    style={[
                      styles.pulseRing,
                      { transform: [{ scale: pulseScale }] },
                    ]}
                  >
                    <Text style={styles.bpmLabel}>BPM</Text>
                    <Text style={styles.bpmValue}>{formatBpm(bpm)}</Text>
                  </Animated.View>
                </View>
              )}

              <Pressable
                onPress={() => nudgeBpm(1)}
                style={styles.nudgeBtn}
                hitSlop={8}
              >
                <Text style={styles.nudgeBtnText}>+</Text>
              </Pressable>
            </View>

            {/* 4박 — 작은 고정 크기 */}
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

            <Text style={styles.status} numberOfLines={1}>
              {mode === 'tap'
                ? bpm > 0
                  ? activePreset != null
                    ? `프리셋 ${TAP_BPM_PRESETS[activePreset]} · 점멸`
                    : tapCount > 0
                      ? `${formatBpm(bpm)} · 탭 ${tapCount}`
                      : `${formatBpm(bpm)} BPM · 점멸`
                  : '원을 탭하거나 프리셋으로 BPM 설정'
                : listening
                  ? bpm > 0
                    ? `${formatBpm(bpm)} BPM · 점멸 중`
                    : '듣는 중…'
                  : '시작 버튼을 누르세요'}
            </Text>

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
            </View>

            {mode === 'tap' ? (
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
            ) : (
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
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.ctaBlock}>
            {mode === 'auto' ? (
              listening ? (
                <PrimaryButton
                  label="탐지 중지"
                  onPress={stopAuto}
                  variant="danger"
                />
              ) : (
                <PrimaryButton
                  label="마이크 자동 감지 시작"
                  onPress={startAuto}
                />
              )
            ) : (
              <PrimaryButton
                label="탭 초기화"
                onPress={resetAll}
                variant="ghost"
              />
            )}
          </View>
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
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'web' ? 16 : 8,
    alignItems: 'center',
    justifyContent: 'space-between',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  topBlock: {
    width: '100%',
    alignItems: 'center',
  },
  ctaBlock: {
    width: '100%',
    marginTop: 12,
    paddingBottom: 4,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  modeChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
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
  bpmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  nudgeBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
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
    lineHeight: 30,
    marginTop: -2,
  },
  tapTarget: {
    marginBottom: 0,
  },
  pulseRing: {
    width: 188,
    height: 188,
    borderRadius: 94,
    borderWidth: 2.5,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRingTap: {
    borderColor: colors.brassBright,
    borderStyle: 'dashed',
  },
  bpmLabel: {
    ...typography.caption,
    letterSpacing: 2.5,
    color: colors.brass,
    fontSize: 13,
  },
  bpmValue: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    fontSize: 58,
    fontWeight: '700',
    color: colors.cream,
    lineHeight: 64,
  },
  tapBadge: {
    marginTop: 2,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.brassBright,
  },
  beats: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  beatDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.brass,
    backgroundColor: 'rgba(201, 162, 39, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  beatDotActive: {
    borderColor: colors.brassBright,
    backgroundColor: 'rgba(224, 188, 58, 0.5)',
  },
  beatDotOne: {
    backgroundColor: 'rgba(224, 188, 58, 0.75)',
  },
  beatNum: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    color: colors.cream,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  beatNumActive: {
    color: colors.ink,
  },
  status: {
    ...typography.caption,
    marginBottom: 6,
    textAlign: 'center',
    lineHeight: 16,
    fontSize: 12,
    color: colors.parchmentDim,
  },
  factorRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    justifyContent: 'center',
  },
  factorBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.5)',
    backgroundColor: 'rgba(30, 44, 68, 0.7)',
  },
  factorBtnText: {
    ...typography.caption,
    color: colors.brassBright,
    fontSize: 12,
    fontWeight: '700',
  },
  levelTrack: {
    width: '80%',
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(30, 44, 68, 0.8)',
    overflow: 'hidden',
    marginTop: 2,
  },
  levelFill: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  error: {
    ...typography.caption,
    color: '#F0B0A4',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 16,
    fontSize: 12,
  },
  // 4열×2행 균등 그리드 (60~130, 8개 프리셋)
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    width: 304, // 4×70 + 3×8
    alignSelf: 'center',
    justifyContent: 'flex-start',
  },
  presetBtn: {
    width: 70,
    paddingVertical: 10,
    borderRadius: 8,
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
    fontSize: 15,
    textAlign: 'center',
  },
  presetBtnTextActive: {
    color: colors.cream,
  },
});
