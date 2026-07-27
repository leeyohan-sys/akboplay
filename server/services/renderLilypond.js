/**
 * LilyPond(.ly) 소스 → PDF/PNG 렌더
 * 서버(Docker 이미지)에 설치된 lilypond 바이너리를 직접 실행한다.
 */
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LILYPOND_BIN = process.env.LILYPOND_PATH || 'lilypond';
const RENDER_TIMEOUT_MS = Number(process.env.LILYPOND_TIMEOUT_MS || 50000);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * @param {string} lilypondSource
 * @returns {Promise<{ pdf: Buffer|null, png: Buffer|null }>}
 */
async function renderLilypond(lilypondSource) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alto-ly-'));
  const id = crypto.randomBytes(4).toString('hex');
  const lyPath = path.join(dir, `${id}.ly`);
  const outBase = path.join(dir, id);

  await fs.writeFile(lyPath, lilypondSource, 'utf8');

  try {
    await run(LILYPOND_BIN, ['--pdf', '-o', outBase, lyPath]);

    try {
      await run(LILYPOND_BIN, [
        '-dbackend=cairo',
        '-fpng',
        '-dresolution=200',
        '-o',
        outBase,
        lyPath,
      ]);
    } catch {
      // cairo 백엔드 실패 시 기본 백엔드로 재시도
      await run(LILYPOND_BIN, ['--png', '-dresolution=200', '-o', outBase, lyPath]);
    }

    const files = await fs.readdir(dir);
    const pngName = files
      .filter((f) => f.startsWith(id) && f.endsWith('.png'))
      .sort()[0];

    const [pdf, png] = await Promise.all([
      fs.readFile(`${outBase}.pdf`).catch(() => null),
      pngName ? fs.readFile(path.join(dir, pngName)).catch(() => null) : null,
    ]);

    if (!pdf && !png) {
      throw new Error('LilyPond 렌더 결과 파일이 없습니다.');
    }

    return { pdf, png };
  } catch (err) {
    const detail = String(err.stderr || err.message || err)
      .split('\n')
      .filter((l) => /error/i.test(l) || l.trim())
      .slice(-6)
      .join(' ')
      .slice(0, 500);
    const e = new Error(`악보 렌더에 실패했습니다: ${detail || '알 수 없는 오류'}`);
    e.code = 'RENDER_FAILED';
    throw e;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = { renderLilypond };
