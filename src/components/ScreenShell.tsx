import React, { ReactNode, useEffect, useState } from 'react';
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
 * 웹/모바일 공통 화면 골격
 * - 웹: 하단 CTA를 뷰포트 하단에 fixed (문서 스크롤/내비에 가리지 않음)
 * - 네이티브: SafeArea + flex
 */
export function ScreenShell({ children, footer, style }: Props) {
  const [footerH, setFooterH] = useState(88);
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;

    const syncFooterBottom = () => {
      const vv = window.visualViewport;
      const layoutH = window.innerHeight;
      const visibleH = vv?.height ?? layoutH;
      const offsetTop = vv?.offsetTop ?? 0;
      const bottomInset = Math.max(0, Math.round(layoutH - (visibleH + offsetTop)));
      // 모바일 브라우저 하단 UI 여유만 최소로 — 과도하면 본문(1–4)을 가림
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      document.documentElement.style.setProperty(
        '--shell-footer-bottom',
        `${Math.max(isMobile ? 12 : 0, bottomInset)}px`,
      );
    };

    syncFooterBottom();
    window.addEventListener('resize', syncFooterBottom);
    window.visualViewport?.addEventListener('resize', syncFooterBottom);
    window.visualViewport?.addEventListener('scroll', syncFooterBottom);
    return () => {
      window.removeEventListener('resize', syncFooterBottom);
      window.visualViewport?.removeEventListener('resize', syncFooterBottom);
      window.visualViewport?.removeEventListener('scroll', syncFooterBottom);
    };
  }, [isWeb]);

  return (
    <View style={[styles.root, style]}>
      <LinearGradient
        colors={['#0E1520', '#152238', '#0E1520']}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView
        style={styles.safe}
        edges={isWeb ? ['top'] : ['top', 'bottom']}
      >
        <View
          style={[
            styles.body,
            isWeb && footer ? { paddingBottom: footerH + 8 } : null,
          ]}
        >
          {children}
        </View>
        {footer ? (
          <View
            style={[styles.footer, isWeb ? styles.footerFixed : null]}
            onLayout={(e) => {
              const h = Math.ceil(e.nativeEvent.layout.height);
              if (h > 0 && h !== footerH) setFooterH(h);
            }}
          >
            {footer}
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.ink,
    ...(Platform.OS === 'web'
      ? ({
          height: '100%' as unknown as number,
          maxHeight: '100%' as unknown as number,
          overflow: 'hidden',
        } as ViewStyle)
      : null),
  },
  safe: {
    flex: 1,
    minHeight: 0,
    ...(Platform.OS === 'web' ? ({ overflow: 'hidden' } as ViewStyle) : null),
  },
  body: {
    flex: 1,
    minHeight: 0,
    // 잘림 대신 스크롤 가능 (짧은 화면에서도 하단 CTA·박자 확인)
    ...(Platform.OS === 'web' ? ({ overflow: 'auto' } as ViewStyle) : null),
  },
  footer: {
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(232, 223, 200, 0.12)',
    backgroundColor: 'rgba(14, 21, 32, 0.98)',
  },
  footerFixed: Platform.select({
    web: {
      position: 'fixed' as unknown as 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 1000,
      paddingBottom:
        'max(12px, calc(env(safe-area-inset-bottom, 0px) + var(--shell-footer-bottom, 24px)))' as unknown as number,
    } as ViewStyle,
    default: {},
  }) as ViewStyle,
});
