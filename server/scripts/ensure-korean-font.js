/**
 * Render(Linux) 등에서 SVG→이미지 시 한글이 깨지지 않도록
 * Noto Sans KR 서브셋 폰트를 준비합니다.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = path.join(__dirname, '../assets/fonts');
const FILES = [
  {
    name: 'NotoSansKR-Regular.otf',
    url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf',
  },
  {
    name: 'NotoSansKR-Bold.otf',
    url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf',
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      const lib = u.startsWith('http://') ? http : https;
      lib
        .get(
          u,
          {
            headers: {
              'User-Agent': 'akboplay-font-setup',
              Accept: '*/*',
            },
          },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location &&
              redirects < 8
            ) {
              res.resume();
              return follow(res.headers.location, redirects + 1);
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} · ${u}`));
              res.resume();
              return;
            }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
          },
        )
        .on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(DIR, f.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100_000) {
      console.log(`[fonts] 유지 ${f.name}`);
      continue;
    }
    console.log(`[fonts] 다운로드 ${f.name}…`);
    const tmp = `${dest}.part`;
    try {
      await download(f.url, tmp);
      fs.renameSync(tmp, dest);
      console.log(
        `[fonts] 완료 ${f.name} (${fs.statSync(dest).size} bytes)`,
      );
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // fontconfig가 찾을 수 있게 홈 폰트 디렉터리에도 복사
  const homeFonts = path.join(require('os').homedir(), '.fonts');
  fs.mkdirSync(homeFonts, { recursive: true });
  for (const f of FILES) {
    const src = path.join(DIR, f.name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(homeFonts, f.name);
    fs.copyFileSync(src, dest);
  }
  console.log(`[fonts] ~/.fonts 등록 완료`);
}

main().catch((err) => {
  console.warn('[fonts] 실패(설치는 계속):', err.message);
  process.exit(0);
});
