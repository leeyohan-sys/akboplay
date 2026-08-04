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
const { randomUUID } = require('crypto');
const { buildPlaylistScorePdf } = require('./services/playlistScorePdf');
const { decodeUploadFileName } = require('./utils/fileName');
const { convertScoreToTab } = require('./services/tabConvert');
const { isConfigured: isGeminiConfigured } = require('./services/geminiClient');

/** 재생목록 PDF 비동기 작업 (모바일 장시간 요청 타임아웃 방지) */
const pdfJobs = new Map();
const PDF_JOB_TTL_MS = 30 * 60 * 1000;

function cleanupPdfJobs() {
  const now = Date.now();
  for (const [id, job] of pdfJobs.entries()) {
    if (now - (job.updatedAt || job.createdAt || 0) > PDF_JOB_TTL_MS) {
      pdfJobs.delete(id);
    }
  }
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    message: job.message || '',
    stage: job.stage || '',
    current: job.current || 0,
    total: job.total || 0,
    error: job.error || null,
    result: job.result
      ? {
          fileName: job.result.fileName,
          playlistTitle: job.result.playlistTitle,
          playlistId: job.result.playlistId,
          pageCount: job.result.pageCount,
          songCount: job.result.songCount,
          foundCount: job.result.foundCount,
          mimePdf: job.result.mimePdf,
          songs: job.result.songs,
          // 큰 base64는 상태 응답에서 제외 (다운로드 엔드포인트 사용)
          hasPdf: Boolean(job.result.pdfBuffer || job.result.pdfBase64),
        }
      : null,
  };
}

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
    version: 'playlist-pdf-short-title-salvage-20260804',
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

    const forceRaw =
      req.query?.force ?? req.body?.force ?? req.headers['x-tab-force'];
    const force =
      forceRaw === true ||
      forceRaw === 1 ||
      String(forceRaw || '').toLowerCase() === '1' ||
      String(forceRaw || '').toLowerCase() === 'true';

    console.log(
      `[tab-convert] ${fileName} force=${force} bodyForce=${req.body?.force} queryForce=${req.query?.force}`,
    );

    const result = await Promise.race([
      convertScoreToTab(req.file.buffer, fileName, req.file.mimetype, {
        force,
      }),
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
      // 클라이언트가 강제 재변환 성공 여부 확인용
      forceApplied: force,
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

/** 유튜브 재생목록 → 악보 PDF (동기, 호환용) */
app.post('/api/playlist-score-pdf', async (req, res) => {
  res.setTimeout(180000);
  try {
    const playlistUrl = String(req.body?.playlistUrl || '').trim();
    if (!playlistUrl) {
      return res.status(400).json({
        error: '유튜브 재생목록 URL이 필요합니다.',
      });
    }

    console.log(`[playlist-score-pdf] 요청 · ${playlistUrl.slice(0, 80)}`);
    const result = await Promise.race([
      buildPlaylistScorePdf(playlistUrl),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('PDF 생성 시간이 초과되었습니다.')),
          170000,
        ),
      ),
    ]);
    console.log(
      `[playlist-score-pdf] 완료 · ${result.songCount}곡 · ${result.pageCount}페이지 · 악보 ${result.foundCount}`,
    );
    const { pdfBuffer, ...json } = result;
    return res.json(json);
  } catch (err) {
    console.error('[playlist-score-pdf]', err);
    const status =
      err.code === 'BAD_URL' || err.code === 'EMPTY' ? 400 : 500;
    return res.status(status).json({
      error: err.message || '재생목록 악보 PDF 생성에 실패했습니다.',
    });
  }
});

/** 모바일용: 작업 시작 → 즉시 jobId 반환 */
app.post('/api/playlist-score-pdf/jobs', async (req, res) => {
  cleanupPdfJobs();
  try {
    const playlistUrl = String(req.body?.playlistUrl || '').trim();
    if (!playlistUrl) {
      return res.status(400).json({
        error: '유튜브 재생목록 URL이 필요합니다.',
      });
    }

    const id = randomUUID();
    const job = {
      id,
      status: 'queued',
      stage: 'queued',
      message: '대기 중…',
      current: 0,
      total: 0,
      error: null,
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    pdfJobs.set(id, job);

    // 백그라운드 생성 (요청은 바로 반환)
    setImmediate(() => {
      job.status = 'running';
      job.message = '시작…';
      job.updatedAt = Date.now();
      buildPlaylistScorePdf(playlistUrl, {
        onProgress: (p) => {
          job.stage = p.stage || job.stage;
          job.message = p.message || job.message;
          if (typeof p.current === 'number') job.current = p.current;
          if (typeof p.total === 'number') job.total = p.total;
          job.updatedAt = Date.now();
        },
      })
        .then((result) => {
          // 상태 폴링 JSON용으로 base64 중복 보관 제거 (메모리)
          if (result && result.pdfBuffer) {
            delete result.pdfBase64;
          }
          job.status = 'done';
          job.stage = 'done';
          job.message = '완료';
          job.result = result;
          job.updatedAt = Date.now();
          console.log(
            `[playlist-score-pdf/jobs] ${id} 완료 · ${result.songCount}곡`,
          );
        })
        .catch((err) => {
          job.status = 'error';
          job.stage = 'error';
          job.error = err.message || 'PDF 생성 실패';
          job.message = job.error;
          job.updatedAt = Date.now();
          console.error(`[playlist-score-pdf/jobs] ${id}`, err);
        });
    });

    return res.status(202).json(publicJob(job));
  } catch (err) {
    console.error('[playlist-score-pdf/jobs]', err);
    return res.status(500).json({
      error: err.message || '작업 시작에 실패했습니다.',
    });
  }
});

/** 작업 상태 폴링 */
app.get('/api/playlist-score-pdf/jobs/:id', (req, res) => {
  cleanupPdfJobs();
  const job = pdfJobs.get(String(req.params.id || ''));
  if (!job) {
    return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  }
  return res.json(publicJob(job));
});

/** PDF 파일 다운로드 (모바일 Blob/새 탭용) */
app.get('/api/playlist-score-pdf/jobs/:id/file', (req, res) => {
  cleanupPdfJobs();
  const job = pdfJobs.get(String(req.params.id || ''));
  if (!job) {
    return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  }
  if (job.status !== 'done' || !job.result) {
    return res.status(409).json({ error: '아직 PDF가 준비되지 않았습니다.' });
  }

  const buf =
    job.result.pdfBuffer ||
    (job.result.pdfBase64
      ? Buffer.from(job.result.pdfBase64, 'base64')
      : null);
  if (!buf) {
    return res.status(500).json({ error: 'PDF 데이터가 없습니다.' });
  }

  const fileName = job.result.fileName || 'akboplay-score.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Content-Length', String(buf.length));
  return res.send(buf);
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
