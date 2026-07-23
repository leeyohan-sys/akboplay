import React, { ReactNode } from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';

type Props = {
  children: ReactNode;
  footer?: ReactNode;
  style?: ViewStyle;
};

/**
 * 웹/모바일 공통 화면 골격 — 본문은 스크롤, 하단 버튼은 항상 고정 노출
 */
export function ScreenShell({ children, footer, style }: Props) {
  return (
    <View style={[styles.root, style]}>
      <LinearGradient
        colors={['#0E1520', '#152238', '#0E1520']}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.body}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.ink,
    ...(Platform.OS === 'web'
      ? ({
          height: '100vh' as unknown as number,
          maxHeight: '100vh' as unknown as number,
          overflow: 'hidden',
        } as ViewStyle)
      : null),
  },
  safe: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  footer: {
    flexShrink: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'web' ? 20 : 12,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(232, 223, 200, 0.12)',
    backgroundColor: 'rgba(14, 21, 32, 0.96)',
    ...(Platform.OS === 'web'
      ? ({
          position: 'sticky' as unknown as 'absolute',
          bottom: 0,
          zIndex: 20,
        } as ViewStyle)
      : null),
  },
});
