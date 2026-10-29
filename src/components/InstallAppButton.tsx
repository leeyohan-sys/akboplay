import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import {
  detectInstallEnv,
  isInstalled,
  promptInstall,
  subscribeInstall,
} from '../utils/installPrompt';

const HELP: Record<ReturnType<typeof detectInstallEnv>, string[]> = {
  kakao: [
    '카카오톡 안에서는 홈 화면에 추가할 수 없어요.',
    "아래 버튼으로 휴대폰 기본 브라우저에서 연 다음, 다시 '홈 화면에 앱 추가'를 눌러 주세요.",
  ],
  inapp: [
    '이 앱 안에서는 홈 화면에 추가할 수 없어요.',
    "메뉴(⋮ 또는 ···)에서 '다른 브라우저로 열기'를 누른 다음, 다시 '홈 화면에 앱 추가'를 눌러 주세요.",
  ],
  ios: [
    '1. 화면의 공유 버튼(네모에 위쪽 화살표 □↑)을 누르세요.',
    "2. 목록을 내려 '홈 화면에 추가'를 누르세요.",
    "3. 오른쪽 위 '추가'를 누르면 홈 화면에 '악보플레이' 앱이 생깁니다.",
  ],
  samsung: [
    '1. 아래쪽 메뉴(≡)를 누르세요.',
    "2. '현재 페이지 추가' → '홈 화면'을 누르세요.",
  ],
  android: [
    '1. 오른쪽 위 메뉴(⋮)를 누르세요.',
    "2. '홈 화면에 추가' 또는 '앱 설치'를 누르세요.",
  ],
  desktop: [
    "주소창 오른쪽의 설치 아이콘을 누르거나, 브라우저 메뉴에서 '앱 설치' 또는 '홈 화면에 추가'를 선택하세요.",
  ],
};

/**
 * 웹 상단 "홈 화면에 앱 추가" 버튼
 * 설치 창을 띄울 수 있는 브라우저(크롬 등)는 바로 설치 창을, 나머지는 브라우저별 안내를 보여줌
 */
export function InstallAppButton() {
  const [installed, setInstalled] = useState(isInstalled);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => subscribeInstall(() => setInstalled(isInstalled())), []);

  // 네이티브 앱이거나 이미 홈 화면 앱으로 실행 중이면 숨김
  if (Platform.OS !== 'web' || installed) return null;

  const env = detectInstallEnv();

  const onPress = async () => {
    const accepted = await promptInstall();
    if (accepted !== null) {
      setHelpOpen(false);
      return;
    }
    setHelpOpen((open) => !open);
  };

  const openExternal = () => {
    window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(
      window.location.href,
    )}`;
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>홈 화면에 앱 추가</Text>
      </Pressable>
      {helpOpen ? (
        <View style={styles.help}>
          {HELP[env].map((line) => (
            <Text key={line} style={styles.helpText}>
              {line}
            </Text>
          ))}
          {env === 'kakao' ? (
            <Pressable
              onPress={openExternal}
              style={({ pressed }) => [styles.button, styles.helpButton, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>브라우저로 열기</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  button: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.55)',
    backgroundColor: 'rgba(201, 162, 39, 0.12)',
  },
  pressed: {
    opacity: 0.75,
  },
  buttonText: {
    ...typography.caption,
    fontSize: 12,
    fontWeight: '700',
    color: colors.brassBright,
  },
  help: {
    alignSelf: 'stretch',
    marginTop: 8,
    padding: 12,
    gap: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(30, 44, 68, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.35)',
  },
  helpText: {
    ...typography.caption,
    fontSize: 13,
    lineHeight: 19,
    color: colors.parchment,
  },
  helpButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
  },
});
