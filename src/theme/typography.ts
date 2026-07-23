import { StyleSheet } from 'react-native';
import { colors } from './colors';

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
    fontFamily: 'NotoSerifKR_700Bold',
    fontSize: 34,
    letterSpacing: -0.5,
    color: colors.cream,
  },
  h1: {
    fontFamily: 'NotoSerifKR_700Bold',
    fontSize: 26,
    color: colors.cream,
    letterSpacing: -0.3,
  },
  h2: {
    fontFamily: 'NotoSerifKR_600SemiBold',
    fontSize: 20,
    color: colors.cream,
  },
  body: {
    fontFamily: 'NotoSansKR_400Regular',
    fontSize: 15,
    lineHeight: 22,
    color: colors.parchmentDim,
  },
  bodyStrong: {
    fontFamily: 'NotoSansKR_500Medium',
    fontSize: 15,
    color: colors.cream,
  },
  caption: {
    fontFamily: 'NotoSansKR_400Regular',
    fontSize: 12,
    color: colors.mist,
  },
  button: {
    fontFamily: 'NotoSansKR_700Bold',
    fontSize: 16,
    color: colors.ink,
  },
});
