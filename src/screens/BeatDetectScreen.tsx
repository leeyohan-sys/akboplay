import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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
import {
  loadTapBpmPresets,
  parsePresetBpm,
  saveTapBpmPresets,
  type TapBpmPresets,
} from '../utils/tapBpmPresets';

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
  // 탭 템포 프리셋 4칸 (localStorage 유지)
  const [presets, setPresets] = useState<TapBpmPresets>(['', '', '', '']);
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

  // 저장된 프리셋 로드
  useEffect(() => {
    setPresets(loadTapBpmPresets());
  }, []);

  const updatePreset = useCallback((index: number, text: string) => {
    // 숫자·소수점만 허용
    const cleaned = text.replace(/[^0-9.]/g, '');
    setPresets((prev) => {
      const next: TapBpmPresets = [...prev] as TapBpmPresets;
      next[index] = cleaned;
      saveTapBpmPresets(next);
      return next;
    });
  }, []);

  /** 프리셋 BPM 눌러 점멸 시작 */
  const applyPresetBpm = useCallback((index: number) => {
    const n = parsePresetBpm(presets[index]);
    if (n <= 0) {
      setError('40~240 사이 BPM을 입력해 주세요.');
      return;
    }
    setError(null);
    setActivePreset(index);
    setBpm(n);
    tapTimesRef.current = [];
    setTapCount(0);
  }, [presets]);

  // BPM 락되면 자동 4박 점멸
  useEffect(() => {
    const active = (mode === 'auto' && listening) || mode === 'tap';
    if (!active || bpm <= 0) {
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
  }, [mode, listening, bpm]);

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
                  BPM 저장 · 숫자를 누르면 그 템포로 점멸
                </Text>
                <View style={styles.presetRow}>
                  {presets.map((value, index) => {
                    const valid = parsePresetBpm(value) > 0;
                    const active = activePreset === index && bpm > 0;
                    return (
                      <View key={index} style={styles.presetCell}>
                        <TextInput
                          value={value}
                          onChangeText={(t) => updatePreset(index, t)}
                          placeholder={`BPM${index + 1}`}
                          placeholderTextColor={colors.mist}
                          keyboardType="decimal-pad"
                          returnKeyType="done"
                          onSubmitEditing={() => applyPresetBpm(index)}
                          style={[
                            styles.presetInput,
                            active && styles.presetInputActive,
                          ]}
                          maxLength={5}
                        />
                        <Pressable
                          onPress={() => applyPresetBpm(index)}
                          disabled={!valid}
                          style={[
                            styles.presetApply,
                            active && styles.presetApplyActive,
                            !valid && styles.presetApplyDisabled,
                          ]}
                        >
                          <Text
                            style={[
                              styles.presetApplyText,
                              active && styles.presetApplyTextActive,
                            ]}
                          >
                            {valid ? value : '—'}
                          </Text>
                        </Pressable>
                      </View>
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
                ? '마이크가 BPM을 듣고, 아래 원을 탭하면 가이드 템포로 잠급니다.\nBPM이 잡히면 자동으로 4박 점멸합니다.'
                : '원을 박자에 맞춰 탭하세요.\n측정된 BPM으로 자동 점멸합니다.'}
            </Text>

            {/* 대형 BPM + 탭 영역 (Live BPM 스타일 전체 탭의 핵심 존) */}
            <Pressable onPress={onScreenTap} style={styles.tapTarget}>
              <Animated.View
                style={[
                  styles.pulseRing,
                  { transform: [{ scale: pulseScale }] },
                ]}
              >
                <Text style={styles.bpmLabel}>BPM</Text>
                <Text style={styles.bpmValue}>{formatBpm(bpm)}</Text>
                {driftLabel ? (
                  <Text
                    style={[
                      styles.drift,
                      drift > 0.3
                        ? styles.driftUp
                        : drift < -0.3
                          ? styles.driftDown
                          : styles.driftOk,
                    ]}
                  >
                    {driftLabel}
                  </Text>
                ) : (
                  <Text style={styles.driftPlaceholder}>탭</Text>
                )}
              </Animated.View>
            </Pressable>

            <Text style={styles.status}>
              {mode === 'tap'
                ? bpm > 0
                  ? activePreset != null
                    ? `프리셋 ${activePreset + 1} · ${formatBpm(bpm)} BPM 점멸`
                    : `탭 ${tapCount}회 · ${formatBpm(bpm)} BPM 점멸`
                  : '박자에 맞춰 원을 탭하거나, 아래 저장 BPM을 누르세요'
                : listening
                  ? bpm > 0
                    ? guideBpm > 0
                      ? `가이드 ${formatBpm(guideBpm)} · 자동 점멸`
                      : `${formatBpm(bpm)} BPM · 자동 점멸`
                    : '듣는 중… BPM 측정 중'
                  : guideBpm > 0
                    ? `가이드 ${formatBpm(guideBpm)} 설정됨 · 시작을 누르세요`
                    : '대기 중 · 시작 또는 원 탭(가이드)'}
            </Text>

            {/* 4박 인디케이터 */}
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
              <>
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
                <Text style={styles.levelHint}>마이크 입력 레벨</Text>
              </>
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
    paddingHorizontal: 22,
    paddingTop: 20,
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
    marginBottom: 12,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
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
    marginTop: 4,
    textAlign: 'center',
    marginBottom: 18,
    fontSize: 14,
    lineHeight: 20,
  },
  tapTarget: {
    marginBottom: 12,
  },
  pulseRing: {
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 2,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  bpmLabel: {
    ...typography.caption,
    letterSpacing: 3,
    color: colors.brass,
  },
  bpmValue: {
    fontFamily: 'Noto Serif KR, Batang, Georgia, serif',
    fontSize: 64,
    fontWeight: '700',
    color: colors.cream,
    lineHeight: 72,
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
  status: {
    ...typography.caption,
    marginBottom: 20,
    textAlign: 'center',
    lineHeight: 18,
  },
  beats: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 18,
  },
  beatDot: {
    width: 52,
    height: 52,
    borderRadius: 26,
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
  factorRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 18,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  factorBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.4)',
    backgroundColor: 'rgba(14, 21, 32, 0.6)',
  },
  factorBtnText: {
    ...typography.caption,
    color: colors.brassBright,
    fontSize: 13,
    fontWeight: '700',
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
    gap: 8,
    width: '100%',
  },
  presetCell: {
    flex: 1,
    gap: 6,
  },
  presetInput: {
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.35)',
    borderRadius: 8,
    backgroundColor: 'rgba(30, 44, 68, 0.7)',
    color: colors.cream,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    paddingVertical: Platform.OS === 'web' ? 10 : 8,
    paddingHorizontal: 4,
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
  },
  presetInputActive: {
    borderColor: colors.brassBright,
  },
  presetApply: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(201, 162, 39, 0.18)',
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetApplyActive: {
    backgroundColor: 'rgba(224, 188, 58, 0.45)',
    borderColor: colors.brassBright,
  },
  presetApplyDisabled: {
    opacity: 0.4,
  },
  presetApplyText: {
    ...typography.bodyStrong,
    color: colors.brassBright,
    fontSize: 15,
  },
  presetApplyTextActive: {
    color: colors.cream,
  },
});
