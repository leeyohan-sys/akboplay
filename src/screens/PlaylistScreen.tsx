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
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { navigateYoutubeWindow, sharePlaybackUrl } from '../services/youtubeLauncher';
import { showAlert } from '../utils/dialog';
import type { MatchedSong } from '../types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Playlist'>;

/**
 * Songs 화면에서 이미 유튜브를 연 뒤 들어오는 결과 화면
 * (다시 만들기 버튼 없이, 다시 열기 / 처음으로만 제공)
 */
export function PlaylistScreen({ navigation, route }: Props) {
  const {
    fileName,
    songs: initial,
    playlistUrl: initialUrl,
    playlistTitle,
    videoCount,
  } = route.params;

  const [songs] = useState<MatchedSong[]>(initial.filter((s) => s.selected));
  const [title] = useState(
    playlistTitle || `악보플레이 · ${fileName.replace(/\.pdf$/i, '')}`,
  );
  const [playlistUrl] = useState<string | null>(initialUrl || null);

  const matchedCount = useMemo(
    () => songs.filter((s) => s.match?.videoId).length,
    [songs],
  );

  const reopen = () => {
    if (!playlistUrl) return;
    navigateYoutubeWindow(null, playlistUrl);
  };

  const share = async () => {
    if (!playlistUrl) return;
    const result = await sharePlaybackUrl(playlistUrl, title);
    if (result === 'shared') {
      // 시스템 공유 시트로 전달됨
      return;
    }
    if (result === 'copied') {
      showAlert('링크 복사됨', '재생 URL이 클립보드에 복사되었습니다. 카카오톡 등에 붙여넣기 하세요.');
      return;
    }
    showAlert('공유 실패', '이 기기에서는 공유를 사용할 수 없습니다.');
  };

  return (
    <ScreenShell
      footer={
        <View style={styles.footerInner}>
          {playlistUrl ? (
            <>
              <PrimaryButton
                label="유튜브 플레이리스트 다시 열기"
                onPress={reopen}
              />
              <PrimaryButton
                label="재생 링크 공유"
                onPress={share}
                variant="ghost"
              />
            </>
          ) : null}
          <PrimaryButton
            label="처음으로"
            onPress={() => navigation.popToTop()}
            variant="ghost"
          />
        </View>
      }
    >
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={typography.h1}>유튜브 플레이리스트</Text>
        <Text style={typography.caption}>
          {videoCount ?? matchedCount}곡 · 유튜브에서 이미 열었습니다
        </Text>
      </View>

      <View style={styles.titleBox}>
        <Text style={styles.label}>플레이리스트 이름</Text>
        <TextInput
          value={title}
          editable={false}
          style={styles.input}
          placeholderTextColor={colors.mist}
        />
      </View>

      <View style={styles.guide}>
        <Text style={styles.guideTitle}>완료</Text>
        <Text style={typography.body}>
          유튜브 앱에서 곡 순서대로 재생합니다.{'\n'}
          아래 [재생 링크 공유]로 URL을 카카오톡 등에 보낼 수 있습니다.
        </Text>
      </View>

      <FlatList
        style={styles.listFlex}
        data={songs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator
        renderItem={({ item }) => <SongRow song={item} />}
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 24,
    paddingTop: 12,
    gap: 6,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  titleBox: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  label: {
    ...typography.caption,
    color: colors.brass,
    marginBottom: 8,
  },
  input: {
    minHeight: 50,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(30, 44, 68, 0.7)',
    color: colors.cream,
    fontFamily: 'Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif',
    fontSize: 15,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 39, 0.25)',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  guide: {
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(30, 44, 68, 0.5)',
    borderWidth: 1,
    borderColor: 'rgba(232, 223, 200, 0.08)',
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  guideTitle: {
    ...typography.bodyStrong,
    color: colors.brassBright,
    marginBottom: 8,
  },
  listFlex: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  footerInner: {
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
    gap: 10,
  },
});
