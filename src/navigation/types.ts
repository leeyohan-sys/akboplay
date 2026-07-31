import type { AnalyzeResult, MatchedSong } from '../types';

export type RootStackParamList = {
  Home: undefined;
  Songs: { analyze: AnalyzeResult };
  BeatDetect: undefined;
  TabConvert: undefined;
  PlaylistPdf: undefined;
  Playlist: {
    fileName: string;
    songs: MatchedSong[];
    /** 이미 생성된 유튜브 연속재생 URL (Songs에서 바로 만든 경우) */
    playlistUrl?: string;
    playlistTitle?: string;
    videoCount?: number;
  };
};
