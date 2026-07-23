import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  style?: ViewStyle;
};

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  variant = 'primary',
  style,
}: Props) {
  const isDisabled = disabled || loading;

  const webCursor =
    Platform.OS === 'web'
      ? ({
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          userSelect: 'none',
          transitionProperty: 'opacity, transform',
          transitionDuration: '120ms',
        } as ViewStyle)
      : null;

  if (variant === 'ghost') {
    return (
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        accessibilityRole="button"
        style={(state) => [
          styles.ghost,
          webCursor,
          (state as { hovered?: boolean }).hovered && !isDisabled
            ? styles.ghostHover
            : null,
          state.pressed && !isDisabled ? styles.pressed : null,
          isDisabled && styles.disabled,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.brass} />
        ) : (
          <Text style={styles.ghostLabel}>{label}</Text>
        )}
      </Pressable>
    );
  }

  if (variant === 'danger') {
    return (
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        accessibilityRole="button"
        style={(state) => [
          styles.danger,
          webCursor,
          (state as { hovered?: boolean }).hovered && !isDisabled
            ? styles.dangerHover
            : null,
          state.pressed && !isDisabled ? styles.pressed : null,
          isDisabled && styles.disabled,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.cream} />
        ) : (
          <Text style={styles.dangerLabel}>{label}</Text>
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      style={(state) => [
        webCursor,
        (state as { hovered?: boolean }).hovered && !isDisabled
          ? styles.primaryHover
          : null,
        state.pressed && !isDisabled ? styles.pressed : null,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      <LinearGradient
        colors={[colors.brassBright, colors.brass]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.primary}
      >
        {loading ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <Text style={typography.button}>{label}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    minHeight: 54,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryHover: {
    opacity: 0.92,
    transform: [{ scale: 1.01 }],
  },
  ghost: {
    minHeight: 54,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.45)',
    backgroundColor: 'rgba(30, 44, 68, 0.55)',
  },
  ghostHover: {
    backgroundColor: 'rgba(30, 44, 68, 0.85)',
    borderColor: colors.brassBright,
  },
  ghostLabel: {
    ...typography.button,
    color: colors.brassBright,
  },
  danger: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: 'rgba(196, 91, 74, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(196, 91, 74, 0.45)',
  },
  dangerHover: {
    backgroundColor: 'rgba(196, 91, 74, 0.35)',
  },
  dangerLabel: {
    ...typography.button,
    color: '#F0B0A4',
    fontSize: 14,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.45,
  },
});
