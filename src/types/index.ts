export type SongCandidate = {
  id: string;
  title: string;
  composer?: string;
  /** 찬송가 장 번호 */
  number?: string;
  confidence: number;
  selected: boolean;
};

export type YoutubeMatch = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  duration?: string;
};

export type MatchedSong = SongCandidate & {
  match?: YoutubeMatch;
  status: 'pending' | 'matched' | 'not_found' | 'error';
};

export type AnalyzeResult = {
  fileName: string;
  songs: SongCandidate[];
  rawTextPreview?: string;
  method: 'text' | 'heuristic' | 'demo' | 'hymn' | 'ocr';
  note?: string;
};

export type PlaylistResult = {
  playlistId: string;
  playlistUrl: string;
  title: string;
  videoCount: number;
};
