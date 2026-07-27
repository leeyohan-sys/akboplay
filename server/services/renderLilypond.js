/**
 * LilyPond(.ly) 소스 → PDF/PNG 렌더
 * PATH / LILYPOND_PATH / vendor 바이너리 순으로 lilypond를 찾는다.
 */
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { repairLilypond } = require('./altoLilypond');

const RENDER_TIMEOUT_MS = Number(process.env.LILYPOND_TIMEOUT_MS || 50000);

/** 설치된 lilypond 실행 파일 경로 찾기 */
function resolveLilypondBin() {
  if (process.env.LILYPOND_PATH && fs.existsSync(process.env.LILYPOND_PATH)) {
    return process.env.LILYPOND_PATH;
  }

  const vendorRoot = path.join(__dirname, '..', 'vendor');
  if (fs.existsSync(vendorRoot)) {
    for (const name of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, name, 'bin', 'lilypond');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  try {
    const which = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['lilypond'],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (which && fs.existsSync(which)) return which;
  } catch {
    /* PATH에 없음 */
  }

  return null;
}

function isLilypondAvailable() {
  return Boolean(resolveLilypondBin());
}

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

/** stderr에서 사용자에게 보여줄 핵심 오류만 추출 */
function summarizeLilypondError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => /:\d+:\d+:\s*error:/i.test(l));
  const fatal = lines.find((l) => /fatal error/i.test(l));
  const detail = [errLine, fatal].filter(Boolean).join(' · ').slice(0, 400);
  return detail || lines.slice(-3).join(' · ').slice(0, 400);
}

/**
 * @param {string} lilypondSource
 * @returns {Promise<{ pdf: Buffer|null, png: Buffer|null }>}
 */
async function renderLilypond(lilypondSource) {
  const bin = resolveLilypondBin();
  if (!bin) {
    const e = new Error(
      '서버에 LilyPond가 설치되어 있지 않습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.',
    );
    e.code = 'NO_LILYPOND';
    throw e;
  }

  // Gemini가 넣은 자연어/마크다운·맨몸 음표를 정리·감싼 뒤 렌더
  const source = repairLilypond(lilypondSource, 'score');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alto-ly-'));
  const id = crypto.randomBytes(4).toString('hex');
  const lyPath = path.join(dir, `${id}.ly`);
  const outBase = path.join(dir, id);

  await fsp.writeFile(lyPath, source, 'utf8');

  try {
    await run(bin, ['--pdf', '-o', outBase, lyPath]);

    try {
      await run(bin, [
        '-dbackend=cairo',
        '-fpng',
        '-dresolution=200',
        '-o',
        outBase,
        lyPath,
      ]);
    } catch {
      // cairo 백엔드 실패 시 기본 백엔드로 재시도
      await run(bin, ['--png', '-dresolution=200', '-o', outBase, lyPath]);
    }

    const files = await fsp.readdir(dir);
    const pngName = files
      .filter((f) => f.startsWith(id) && f.endsWith('.png'))
      .sort()[0];

    const [pdf, png] = await Promise.all([
      fsp.readFile(`${outBase}.pdf`).catch(() => null),
      pngName ? fsp.readFile(path.join(dir, pngName)).catch(() => null) : null,
    ]);

    if (!pdf && !png) {
      throw new Error('LilyPond 렌더 결과 파일이 없습니다.');
    }

    return { pdf, png };
  } catch (err) {
    if (err.code === 'NO_LILYPOND') throw err;
    const detail = summarizeLilypondError(err.stderr || err.message || err);
    // 디버그: 실패 줄 근처 소스 미리보기
    const lineMatch = String(detail).match(/:(\d+):\d+:\s*error:/i);
    if (lineMatch) {
      const n = Number(lineMatch[1]);
      const lines = source.split(/\r?\n/);
      const from = Math.max(0, n - 3);
      const snippet = lines
        .slice(from, n + 2)
        .map((l, i) => `${from + i + 1}| ${l}`)
        .join('\n');
      console.error('[renderLilypond] source near error:\n' + snippet);
    }
    console.error('[renderLilypond] failed:', detail);
    const e = new Error(
      detail
        ? `악보 렌더에 실패했습니다: ${detail}`
        : '악보 렌더에 실패했습니다. 알토 악보를 다시 생성해 주세요.',
    );
    e.code = 'RENDER_FAILED';
    throw e;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = { renderLilypond, isLilypondAvailable, resolveLilypondBin };
