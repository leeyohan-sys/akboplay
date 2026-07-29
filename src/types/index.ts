export type SongCandidate = {
  id: string;
  title: string;
  composer?: string;
  /** 찬송가 장 번호 */
  number?: string;
  /** 조성 (예: G, Bb, Em) */
  key?: string;
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
  method: 'text' | 'heuristic' | 'demo' | 'hymn' | 'ocr' | 'gemini';
  note?: string;
};

export type PlaylistResult = {
  playlistId: string;
  playlistUrl: string;
  title: string;
  videoCount: number;
};

/** 악보 → 기타 탭 변환 결과 */
export type TabConvertResult = {
  fileName: string;
  title: string;
  composer?: string;
  key?: string;
  tempo?: number;
  timeSignature?: string;
  asciiTab?: string;
  svg?: string;
  pngBase64: string;
  pdfBase64?: string;
  mimePng?: string;
  mimePdf?: string;
  method?: string;
  note?: string;
  model?: string;
};
