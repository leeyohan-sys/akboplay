import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenShell } from '../components/ScreenShell';
import { SongRow } from '../components/SongRow';
import { api } from '../services/api';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { showAlert } from '../utils/dialog';
import {
  navigateYoutubeWindow,
  openYoutubeWindowPlaceholder,
  writeYoutubeWindowHtml,
} from '../services/youtubeLauncher';
import type { MatchedSong } from '../types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Songs'>;

/**
 * 버튼 한 번으로 바로 유튜브 검색 → 플레이리스트 새 창 오픈
 * (중간 Playlist 확인 화면에서 다시 누르지 않음)
 */
export function SongsScreen({ navigation, route }: Props) {
  const { analyze } = route.params;
  const [songs, setSongs] = useState<MatchedSong[]>(
    analyze.songs.map((s) => ({ ...s, status: 'pending' as const })),
  );
  const [newTitle, setNewTitle] = useState('');
  const [matching, setMatching] = useState(false);

  const selectedCount = useMemo(
    () => songs.filter((s) => s.selected).length,
    [songs],
  );

  const playlistTitle = `악보플레이 · ${analyze.fileName.replace(/\.pdf$/i, '')}`;

  const toggle = (id: string) => {
    setSongs((prev) =>
      prev.map((s) => (s.id === id ? { ...s, selected: !s.selected } : s)),
    );
  };

  const remove = (id: string) => {
    setSongs((prev) => prev.filter((s) => s.id !== id));
  };

  const addSong = () => {
    const title = newTitle.trim();
    if (!title) return;
    setSongs((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        title,
        confidence: 1,
        selected: true,
        status: 'pending',
      },
    ]);
    setNewTitle('');
  };

  const createPlaylistNow = async () => {
    const selected = songs.filter((s) => s.selected);
    if (selected.length === 0) {
      showAlert('곡을 선택하세요', '플레이리스트에 넣을 곡을 하나 이상 선택해 주세요.');
      return;
    }

    // 클릭 제스처 안에서 바로 새 창 오픈 (팝업 차단 방지)
    const ytWindow = openYoutubeWindowPlaceholder();
    setMatching(true);

    try {
      const result = await api.autoPlaylist({
        title: playlistTitle,
        songs: selected.map(({ id, title, composer, number, key }) => ({
          id,
          title,
          composer,
          number,
          key,
        })),
      });

      const matchedSongs: MatchedSong[] = selected.map((s) => {
        const hit = result.videos.find((v) => v.title === s.title);
        if (!hit?.videoId) {
          return { ...s, status: 'not_found' as const };
        }
        return {
          ...s,
          status: 'matched' as const,
          match: {
            videoId: hit.videoId,
            title: hit.videoTitle || s.title,
            channelTitle: hit.channel || hit.channelTitle || 'YouTube',
            thumbnailUrl: `https://i.ytimg.com/vi/${hit.videoId}/mqdefault.jpg`,
          },
        };
      });

      // 유튜브 플레이리스트 화면으로 바로 이동
      navigateYoutubeWindow(ytWindow, result.playlistUrl);

      navigation.navigate('Playlist', {
        fileName: analyze.fileName,
        songs: matchedSongs,
        playlistUrl: result.playlistUrl,
        playlistTitle,
        videoCount: result.videoCount,
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : '자동 플레이리스트 생성에 실패했습니다.';
      writeYoutubeWindowHtml(
        ytWindow,
        `<h2 style="margin:0 0 12px">검색 실패</h2>
         <p style="margin:0;opacity:.9;line-height:1.5">${msg}</p>
         <p style="margin:16px 0 0;font-size:13px;opacity:.55">이 창을 닫고 다시 시도해 주세요.</p>`,
      );
      showAlert('실패', msg);
    } finally {
      setMatching(false);
    }
  };

  return (
    <ScreenShell
      footer={
        <View style={styles.footerInner}>
          <PrimaryButton
            label={matching ? '유튜브에서 곡 검색 중…' : '유튜브 목록 만들기'}
            onPress={createPlaylistNow}
            loading={matching}
            disabled={selectedCount === 0}
          />
        </View>
      }
    >
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={typography.h1}>인식된 곡</Text>
        <Text style={typography.caption}>
          {analyze.fileName} ·{' '}
          {analyze.method === 'demo'
            ? '데모'
            : analyze.method === 'hymn'
              ? '찬송가 인식'
              : analyze.method === 'ocr'
                ? 'OCR 인식'
                : analyze.method === 'gemini'
                  ? 'AI 인식'
                : 'PDF 분석'}{' '}
          · {selectedCount}곡 선택
        </Text>
        {analyze.note ? (
          <Text style={styles.busyHint}>{analyze.note}</Text>
        ) : null}
        {matching ? (
          <Text style={styles.busyHint}>
            유튜브에서 곡을 찾는 중입니다. 잠시만 기다려 주세요…
          </Text>
        ) : null}
      </View>

      <FlatList
        style={styles.listFlex}
        data={songs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator
        renderItem={({ item }) => (
          <SongRow
            song={item}
            onToggle={() => toggle(item.id)}
            onRemove={() => remove(item.id)}
          />
        )}
        ListFooterComponent={
          <View style={styles.addBox}>
            <Text style={styles.addLabel}>곡 직접 추가</Text>
            <View style={styles.addRow}>
              <TextInput
                value={newTitle}
                onChangeText={setNewTitle}
                placeholder="곡 제목 입력"
                placeholderTextColor={colors.mist}
                style={styles.input}
                onSubmitEditing={addSong}
                returnKeyType="done"
              />
              <PrimaryButton label="추가" onPress={addSong} style={styles.addBtn} />
            </View>
          </View>
        }
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 6,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  busyHint: {
    ...typography.caption,
    color: colors.brassBright,
    marginTop: 4,
  },
  listFlex: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  addBox: {
    marginTop: 8,
    marginBottom: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(30, 44, 68, 0.45)',
    borderWidth: 1,
    borderColor: 'rgba(232, 223, 200, 0.08)',
  },
  addLabel: {
    ...typography.caption,
    marginBottom: 10,
    color: colors.brass,
  },
  addRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: colors.ink,
    color: colors.cream,
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 15,
    borderWidth: 1,
    borderColor: 'rgba(143, 163, 191, 0.25)',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  addBtn: {
    width: 88,
    flexShrink: 0,
  },
  footerInner: {
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
});
