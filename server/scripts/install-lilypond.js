/**
 * Render(Linux) 빌드 시 LilyPond 공식 바이너리를 vendor/에 설치
 * (네이티브 Node 런타임에서도 PDF/PNG 렌더가 가능하도록)
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = '2.24.4';
const ARCHIVE = `lilypond-${VERSION}-linux-x86_64.tar.gz`;
const URL =
  `https://gitlab.com/lilypond/lilypond/-/releases/v${VERSION}/downloads/${ARCHIVE}`;
const VENDOR = path.join(__dirname, '..', 'vendor');
const EXTRACTED = path.join(VENDOR, `lilypond-${VERSION}`);
const BIN = path.join(EXTRACTED, 'bin', 'lilypond');

function log(...args) {
  console.log('[install-lilypond]', ...args);
}

function findBin() {
  if (fs.existsSync(BIN)) return BIN;
  if (!fs.existsSync(VENDOR)) return null;
  for (const name of fs.readdirSync(VENDOR)) {
    const candidate = path.join(VENDOR, name, 'bin', 'lilypond');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, { headers: { 'User-Agent': 'akboplay-install' } }, (res) => {
      // GitLab 리다이렉트 추적
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (err) => {
      try {
        file.close();
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

async function main() {
  if (process.platform !== 'linux') {
    log(`skip (platform=${process.platform})`);
    return;
  }

  // apt 등으로 이미 PATH에 있으면 다운로드 생략
  try {
    const which = execFileSync('which', ['lilypond'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0];
    if (which) {
      log('system lilypond found:', which);
      return;
    }
  } catch {
    /* continue to vendor install */
  }

  const existing = findBin();
  if (existing) {
    log('already present:', existing);
    return;
  }

  fs.mkdirSync(VENDOR, { recursive: true });
  const archivePath = path.join(VENDOR, ARCHIVE);

  log('downloading', URL);
  await download(URL, archivePath);
  const sizeMb = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
  log(`downloaded ${sizeMb} MB`);

  log('extracting…');
  execFileSync('tar', ['-xzf', archivePath, '-C', VENDOR], { stdio: 'inherit' });
  try {
    fs.unlinkSync(archivePath);
  } catch {
    /* ignore */
  }

  const bin = findBin();
  if (!bin) {
    throw new Error('extract succeeded but lilypond binary not found');
  }
  // 실행 권한 보장
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    /* ignore */
  }
  log('installed:', bin);
}

main().catch((err) => {
  console.error('[install-lilypond] FAILED:', err.message || err);
  // 빌드는 계속 진행 (헬스체크/런타임에서 안내)
  process.exit(0);
});
