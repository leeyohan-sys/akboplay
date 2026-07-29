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
const { decodeUploadFileName } = require('./utils/fileName');
const { convertScoreToTab } = require('./services/tabConvert');
const { isConfigured: isGeminiConfigured } = require('./services/geminiClient');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);
// Express 5 + path-to-regexp는 '*' 와일드카드 불가 → cors 미들웨어가 OPTIONS 처리
app.use(express.json({ limit: '2mb' }));

// JSON 응답 UTF-8 명시
app.use((_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return originalJson(body);
  };
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    youtubeConfigured: isConfigured(),
    oauthConfigured: Boolean(process.env.YOUTUBE_ACCESS_TOKEN),
    geminiConfigured: isGeminiConfigured(),
    version: 'tab-convert-20260729',
  });
});

app.get('/api/demo', (_req, res) => {
  res.json(getDemoResult('demo-score.pdf'));
});

/** PDF 악보 업로드 → 곡 후보 추출 */
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  // 전체 페이지 Gemini 인식에 맞춰 여유 타임아웃
  res.setTimeout(110000);
  try {
    // 프론트가 보낸 UTF-8 fileName을 우선 (multipart originalname 깨짐 방지)
    const fileName = decodeUploadFileName(
      req.body?.fileName || req.file?.originalname || 'score.pdf',
    );

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

    const result = await Promise.race([
      analyzePdfBuffer(req.file.buffer, fileName),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('분석 시간이 초과되었습니다.')),
          100000,
        ),
      ),
    ]);
    return res.json(result);
  } catch (err) {
    console.error('[analyze]', err);
    // 타임아웃/OCR 실패여도 앱이 멈추지 않도록 빈 목록 반환
    if (/초과|timeout|aborted/i.test(String(err.message || ''))) {
      return res.json({
        fileName: decodeUploadFileName(
          req.body?.fileName || req.file?.originalname || 'score.pdf',
        ),
        method: 'heuristic',
        note: '서버에서 문서 인식이 오래 걸려 중단되었습니다. 곡을 직접 추가해 주세요.',
        songs: [],
      });
    }
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
        key: s.key ? String(s.key) : undefined,
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

/** 악보 이미지/PDF → 기타 TAB (PNG·PDF) */
app.post('/api/tab-convert', upload.single('file'), async (req, res) => {
  res.setTimeout(160000);
  try {
    const fileName = decodeUploadFileName(
      req.body?.fileName || req.file?.originalname || 'score.png',
    );
    if (!req.file) {
      return res.status(400).json({
        error: '악보 이미지 또는 PDF 파일이 필요합니다.',
      });
    }

    console.log(
      `[tab-convert] ${fileName} (${req.file.size} bytes, ${req.file.mimetype})`,
    );

    const result = await Promise.race([
      convertScoreToTab(req.file.buffer, fileName, req.file.mimetype),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('탭 변환 시간이 초과되었습니다.')),
          150000,
        ),
      ),
    ]);

    return res.json({
      fileName,
      ...result,
    });
  } catch (err) {
    console.error('[tab-convert]', err);
    const msg = String(err.message || err);
    if (err.code === 'RATE_LIMIT' || /요청이 많습니다|429/i.test(msg)) {
      return res.status(429).json({ error: msg });
    }
    return res.status(500).json({
      error: msg || '탭 변환에 실패했습니다.',
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
