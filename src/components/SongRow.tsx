import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { MatchedSong } from '../types';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';

type Props = {
  song: MatchedSong;
  onToggle?: () => void;
  onRemove?: () => void;
};

/**
 * 웹에서 Pressable 중첩 시 오류가 나서
 * 행=View+Pressable 분리, 삭제는 형제 버튼으로 둡니다.
 */
export function SongRow({ song, onToggle, onRemove }: Props) {
  return (
    <View style={[styles.row, !song.selected && styles.rowOff]}>
      <Pressable
        onPress={onToggle}
        disabled={!onToggle}
        accessibilityRole="button"
        style={styles.rowMain}
      >
        <View style={[styles.check, song.selected && styles.checkOn]}>
          {song.selected ? <Text style={styles.checkMark}>✓</Text> : null}
        </View>

        {song.match?.thumbnailUrl ? (
          <Image
            source={{ uri: song.match.thumbnailUrl }}
            style={styles.thumb}
            contentFit="cover"
          />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Text style={styles.thumbMark}>♪</Text>
          </View>
        )}

        <View style={styles.meta}>
          <Text style={typography.bodyStrong} numberOfLines={1}>
            {song.title}
          </Text>
          <Text style={typography.caption} numberOfLines={1}>
            {song.number ? `${song.number}장 · ` : ''}
            {song.match
              ? song.match.channelTitle
              : song.composer || '작곡가 미상'}
          </Text>
          {song.status === 'not_found' ? (
            <Text style={styles.warn}>유튜브에서 찾지 못함</Text>
          ) : null}
        </View>
      </Pressable>

      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="삭제"
          style={styles.remove}
        >
          <Text style={styles.removeText}>삭제</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(30, 44, 68, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(232, 223, 200, 0.08)',
    overflow: 'hidden',
  },
  rowOff: {
    opacity: 0.55,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minWidth: 0,
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : null),
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkOn: {
    backgroundColor: colors.brass,
    borderColor: colors.brass,
  },
  checkMark: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  thumb: {
    width: 56,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.inkLift,
    flexShrink: 0,
  },
  thumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbMark: {
    color: colors.brass,
    fontSize: 18,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  warn: {
    ...typography.caption,
    color: colors.danger,
    marginTop: 2,
  },
  remove: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexShrink: 0,
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : null),
  },
  removeText: {
    ...typography.caption,
    color: '#F0B0A4',
    fontFamily: 'NotoSansKR_500Medium',
  },
});
