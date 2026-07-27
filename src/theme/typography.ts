import { StyleSheet } from 'react-native';
import { colors } from './colors';

/** 웹: Google Fonts CDN / 네이티브: 시스템 한글 폰트 폴백 */
const sans = 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif';
const serif = 'Noto Serif KR, Batang, Georgia, serif';

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const typography = StyleSheet.create({
  brand: {
    fontFamily: serif,
    fontWeight: '700',
    fontSize: 34,
    letterSpacing: -0.5,
    color: colors.cream,
  },
  h1: {
    fontFamily: serif,
    fontWeight: '700',
    fontSize: 26,
    color: colors.cream,
    letterSpacing: -0.3,
  },
  h2: {
    fontFamily: serif,
    fontWeight: '600',
    fontSize: 20,
    color: colors.cream,
  },
  body: {
    fontFamily: sans,
    fontWeight: '400',
    fontSize: 15,
    lineHeight: 22,
    color: colors.parchmentDim,
  },
  bodyStrong: {
    fontFamily: sans,
    fontWeight: '500',
    fontSize: 15,
    color: colors.cream,
  },
  caption: {
    fontFamily: sans,
    fontWeight: '400',
    fontSize: 12,
    color: colors.mist,
  },
  button: {
    fontFamily: sans,
    fontWeight: '700',
    fontSize: 16,
    color: colors.ink,
  },
});
