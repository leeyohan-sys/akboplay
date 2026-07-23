const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const { analyzePdfBuffer, getDemoResult } = require('./services/scoreParser');
const {
  isConfigured,
  matchSongs,
  createPlaylist,
} = require('./services/youtube');
const { buildAutoPlaylist } = require('./services/autoPlaylist');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    youtubeConfigured: isConfigured(),
    oauthConfigured: Boolean(process.env.YOUTUBE_ACCESS_TOKEN),
  });
});

app.get('/api/demo', (_req, res) => {
  res.json(getDemoResult('demo-score.pdf'));
});

/** PDF 악보 업로드 → 곡 후보 추출 */
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  try {
    const fileName = req.file?.originalname || req.body?.fileName || 'score.pdf';

    // 명시적 데모만 허용 (파일 없이 오면 더 이상 조용히 데모 반환하지 않음)
    if (!req.file) {
      if (fileName === 'demo-score.pdf' || req.body?.demo === '1') {
        return res.json(getDemoResult(fileName));
      }
      return res.status(400).json({
        error:
          'PDF 파일이 전달되지 않았습니다. 웹에서는 파일을 다시 첨부해 주세요.',
      });
    }

    console.log(
      `[analyze] ${fileName} (${req.file.size} bytes, ${req.file.mimetype})`,
    );
    const result = await analyzePdfBuffer(req.file.buffer, fileName);
    return res.json(result);
  } catch (err) {
    console.error('[analyze]', err);
    return res.status(500).json({
      error: err.message || 'PDF 분석에 실패했습니다.',
    });
  }
});

/** 곡 목록 → YouTube 매칭 */
app.post('/api/match', async (req, res) => {
  try {
    const songs = req.body?.songs;
    if (!Array.isArray(songs) || songs.length === 0) {
      return res.status(400).json({ error: 'songs 배열이 필요합니다.' });
    }

    const matched = await matchSongs(
      songs.slice(0, 30).map((s) => ({
        id: String(s.id),
        title: String(s.title || '').trim(),
        composer: s.composer ? String(s.composer) : undefined,
        confidence: Number(s.confidence) || 0.5,
        selected: true,
      })),
    );

    return res.json({ songs: matched, demo: !isConfigured() });
  } catch (err) {
    console.error('[match]', err);
    return res.status(500).json({ error: err.message || '매칭 실패' });
  }
});

/** API 키 없이: 곡 검색 → watch_videos 플레이리스트 URL */
app.post('/api/playlist/auto', async (req, res) => {
  try {
    const { title, songs } = req.body || {};
    if (!Array.isArray(songs) || songs.length === 0) {
      return res.status(400).json({ error: 'songs 배열이 필요합니다.' });
    }

    console.log(`[playlist/auto] ${songs.length}곡 검색 시작…`);
    const result = await buildAutoPlaylist({
      title: title || '악보플레이 플레이리스트',
      songs: songs.slice(0, 25).map((s) => ({
        id: s.id,
        title: String(s.title || '').trim(),
        composer: s.composer ? String(s.composer) : undefined,
        number: s.number ? String(s.number) : undefined,
      })),
    });
    console.log(
      `[playlist/auto] 완료 · ${result.videoCount}곡 · ${result.playlistUrl.slice(0, 80)}…`,
    );
    return res.json(result);
  } catch (err) {
    console.error('[playlist/auto]', err);
    return res.status(500).json({
      error: err.message || '자동 플레이리스트 생성에 실패했습니다.',
    });
  }
});

/** (선택) OAuth API로 플레이리스트 생성 — 기본 플로우에서는 사용하지 않음 */
app.post('/api/playlist', async (req, res) => {
  try {
    const { title, description, videoIds, accessToken } = req.body || {};
    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return res.status(400).json({ error: 'videoIds가 필요합니다.' });
    }

    const result = await createPlaylist({
      title,
      description,
      videoIds: videoIds.map(String),
      accessToken,
    });
    return res.json(result);
  } catch (err) {
    console.error('[playlist]', err);
    const status = err.code === 'OAUTH_REQUIRED' ? 401 : 500;
    return res.status(status).json({ error: err.message || '플레이리스트 생성 실패' });
  }
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`악보플레이 API 서버 http://0.0.0.0:${PORT}`);
  console.log(`YouTube API Key: ${isConfigured() ? '설정됨' : '미설정(데모 매칭)'}`);
});
