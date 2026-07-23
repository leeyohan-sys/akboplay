/**
 * YouTube Data API 검색 및 플레이리스트 생성
 * - YOUTUBE_API_KEY: 검색용
 * - YOUTUBE_ACCESS_TOKEN 또는 요청 body accessToken: 플레이리스트 생성(OAuth)
 */
const { google } = require('googleapis');

function getYoutube(authOrKey) {
  if (typeof authOrKey === 'string' && authOrKey.startsWith('ya29')) {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: authOrKey });
    return google.youtube({ version: 'v3', auth: oauth2 });
  }

  const key = authOrKey || process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  return google.youtube({ version: 'v3', auth: key });
}

function isConfigured() {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

/** 곡 제목(+작곡가)으로 가장 적합한 영상 1개 검색 */
async function searchBestMatch(song) {
  const youtube = getYoutube();
  if (!youtube) {
    return {
      ...song,
      status: 'matched',
      match: {
        videoId: `demo-${song.id}`,
        title: `${song.title} (데모 매칭)`,
        channelTitle: song.composer || 'Demo Channel',
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
      },
    };
  }

  const isHymn =
    song.number ||
    /하나님|예수|성령|찬송|은혜|나그네|죄악/.test(song.title || '');

  const q = [
    song.title,
    song.composer,
    isHymn ? '찬송가 OR 찬양' : 'official audio OR piano OR music',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const res = await youtube.search.list({
      part: ['snippet'],
      q,
      type: ['video'],
      maxResults: 5,
      videoEmbeddable: 'true',
    });

    const item = res.data.items?.[0];
    if (!item?.id?.videoId) {
      return { ...song, status: 'not_found' };
    }

    return {
      ...song,
      status: 'matched',
      match: {
        videoId: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        thumbnailUrl:
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          '',
      },
    };
  } catch (err) {
    return {
      ...song,
      status: 'error',
      match: undefined,
      error: err.message,
    };
  }
}

async function matchSongs(songs) {
  const results = [];
  for (const song of songs) {
    // API quota 보호를 위해 순차 호출
    // eslint-disable-next-line no-await-in-loop
    results.push(await searchBestMatch(song));
  }
  return results;
}

/**
 * 비공개/비목록 플레이리스트 생성 후 영상 추가
 * accessToken(OAuth) 필수 — API 키만으로는 playlist insert 불가
 */
async function createPlaylist({ title, description, videoIds, accessToken }) {
  const token = accessToken || process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) {
    const err = new Error(
      '플레이리스트 생성에는 YouTube OAuth access token이 필요합니다. server/.env에 YOUTUBE_ACCESS_TOKEN을 설정하거나 앱에서 전달하세요.',
    );
    err.code = 'OAUTH_REQUIRED';
    throw err;
  }

  const youtube = getYoutube(token);
  if (!youtube) {
    throw new Error('YouTube 클라이언트를 초기화할 수 없습니다.');
  }

  const playlist = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title || '악보플레이 플레이리스트',
        description: description || '악보 PDF에서 생성됨',
      },
      status: {
        privacyStatus: 'unlisted',
      },
    },
  });

  const playlistId = playlist.data.id;
  let added = 0;

  for (const videoId of videoIds) {
    if (!videoId || String(videoId).startsWith('demo')) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: 'youtube#video',
              videoId,
            },
          },
        },
      });
      added += 1;
    } catch {
      // 개별 실패는 건너뜀
    }
  }

  return {
    playlistId,
    playlistUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    title: playlist.data.snippet?.title || title,
    videoCount: added,
  };
}

module.exports = {
  isConfigured,
  matchSongs,
  createPlaylist,
};
