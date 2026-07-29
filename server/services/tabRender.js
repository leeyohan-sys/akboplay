/**
 * 기타 탭 악보 SVG → PNG / PDF 렌더
 * Flat·Soundslice처럼 6선 탭 + 프렛 숫자 표기
 */

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E']; // 위→아래 (1현→6현)

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} score
 * @param {string} [score.title]
 * @param {string} [score.composer]
 * @param {string} [score.key]
 * @param {number} [score.tempo]
 * @param {string} [score.timeSignature]
 * @param {Array} score.measures
 */
function buildTabSvg(score) {
  const measures = Array.isArray(score.measures) ? score.measures : [];
  const beatsPerBar = parseBeats(score.timeSignature || '4/4');
  const colsPerBeat = 3;
  const colW = 18;
  const measurePad = 10;
  const lineGap = 16;
  const staffH = lineGap * 5;
  const systemGap = 56;
  const leftGutter = 44;
  const topMargin = 88;
  const rightPad = 28;
  const measuresPerSystem = 4;
  const systems = [];
  for (let i = 0; i < measures.length; i += measuresPerSystem) {
    systems.push(measures.slice(i, i + measuresPerSystem));
  }
  if (systems.length === 0) {
    systems.push([{ events: [] }]);
  }

  const measureInnerW = beatsPerBar * colsPerBeat * colW;
  const measureW = measureInnerW + measurePad * 2;
  const contentW =
    leftGutter + measuresPerSystem * measureW + rightPad;
  const width = Math.max(720, contentW);
  // 시스템(줄)이 많아도 잘리지 않게 높이 확보
  const height = Math.max(
    320,
    topMargin + systems.length * (staffH + systemGap) + 48,
  );

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="#F7F3E8"/>`);

  // 헤더
  parts.push(
    `<text x="${width / 2}" y="36" text-anchor="middle" font-family="Georgia, 'Noto Serif KR', serif" font-size="26" font-weight="700" fill="#1A2433">${escapeXml(score.title || 'Guitar Tab')}</text>`,
  );
  const meta = [
    score.composer ? escapeXml(score.composer) : '',
    score.key ? `Key ${escapeXml(score.key)}` : '',
    score.tempo ? `♩=${Number(score.tempo)}` : '',
    score.timeSignature ? escapeXml(score.timeSignature) : '',
    'Standard Tuning',
  ]
    .filter(Boolean)
    .join('  ·  ');
  parts.push(
    `<text x="${width / 2}" y="60" text-anchor="middle" font-family="Arial, 'Noto Sans KR', sans-serif" font-size="13" fill="#5A6575">${meta}</text>`,
  );
  parts.push(
    `<text x="${width / 2}" y="78" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#8A93A0">TAB · ${measures.length} measures</text>`,
  );

  systems.forEach((sysMeasures, sysIdx) => {
    const y0 = topMargin + sysIdx * (staffH + systemGap);

    // 현 라벨
    STRING_LABELS.forEach((lab, si) => {
      const y = y0 + si * lineGap;
      parts.push(
        `<text x="12" y="${y + 4}" font-family="Consolas, Monaco, monospace" font-size="12" fill="#3D4A5C">${lab}</text>`,
      );
      parts.push(
        `<line x1="${leftGutter}" y1="${y}" x2="${width - rightPad}" y2="${y}" stroke="#2A3544" stroke-width="1.1"/>`,
      );
    });

    let x = leftGutter;
    // 시작 세로선
    parts.push(
      `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + staffH}" stroke="#2A3544" stroke-width="1.6"/>`,
    );

    sysMeasures.forEach((measure) => {
      const events = Array.isArray(measure?.events) ? measure.events : [];
      const byBeat = new Map();
      for (const ev of events) {
        const beat = Math.max(0, Math.min(beatsPerBar - 0.01, Number(ev.beat) || 0));
        const string = Math.max(1, Math.min(6, Number(ev.string) || 1));
        const fret = Math.max(0, Math.min(24, Number(ev.fret) || 0));
        const key = `${beat.toFixed(2)}|${string}`;
        byBeat.set(key, { beat, string, fret });
      }

      for (const { beat, string, fret } of byBeat.values()) {
        const cx =
          x +
          measurePad +
          beat * colsPerBeat * colW +
          colW * 0.6;
        const cy = y0 + (string - 1) * lineGap;
        const label = String(fret);
        // 선 위 숫자 가독성용 배경
        parts.push(
          `<rect x="${cx - 7}" y="${cy - 8}" width="${label.length > 1 ? 16 : 14}" height="14" rx="2" fill="#F7F3E8"/>`,
        );
        parts.push(
          `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="Consolas, Monaco, monospace" font-size="13" font-weight="700" fill="#15202E">${label}</text>`,
        );
      }

      x += measureW;
      parts.push(
        `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + staffH}" stroke="#2A3544" stroke-width="1.4"/>`,
      );
    });
  });

  parts.push(`</svg>`);
  return parts.join('\n');
}

function parseBeats(ts) {
  const m = String(ts || '4/4').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return 4;
  return Math.max(1, Math.min(12, Number(m[1]) || 4));
}

/** ASCII 탭 텍스트 생성 (미리보기/폴백용) */
function buildAsciiTab(score) {
  const measures = Array.isArray(score.measures) ? score.measures : [];
  const beatsPerBar = parseBeats(score.timeSignature || '4/4');
  const slots = beatsPerBar * 2; // 8분음 해상도
  const lines = STRING_LABELS.map((lab) => `${lab}|`);

  for (const measure of measures) {
    const grid = Array.from({ length: 6 }, () =>
      Array.from({ length: slots }, () => '-'),
    );
    for (const ev of measure?.events || []) {
      const beat = Number(ev.beat) || 0;
      const slot = Math.min(slots - 1, Math.round(beat * 2));
      const si = Math.max(0, Math.min(5, (Number(ev.string) || 1) - 1));
      const fret = String(Math.max(0, Number(ev.fret) || 0));
      grid[si][slot] = fret;
      if (fret.length > 1 && slot + 1 < slots) grid[si][slot + 1] = '';
    }
    for (let si = 0; si < 6; si++) {
      const body = grid[si]
        .map((c) => (c === '' ? '' : c === '-' ? '--' : c.length === 1 ? `${c}-` : c))
        .join('');
      lines[si] += `${body}|`;
    }
  }

  const header = [
    score.title || 'Guitar Tab',
    [score.key && `Key ${score.key}`, score.tempo && `♩=${score.tempo}`]
      .filter(Boolean)
      .join(' · '),
  ]
    .filter(Boolean)
    .join('\n');
  return `${header}\n\n${lines.join('\n')}`;
}

/** SVG 문자열 → PNG Buffer (sharp) */
async function svgToPng(svg, { width } = {}) {
  const sharp = require('sharp');
  let pipeline = sharp(Buffer.from(svg));
  if (width) {
    pipeline = pipeline.resize({ width, withoutEnlargement: false });
  }
  return pipeline.png().toBuffer();
}

/**
 * PNG → JPEG → 간단 PDF
 */
async function pngToPdf(pngBuffer) {
  const sharp = require('sharp');
  const meta = await sharp(pngBuffer).metadata();
  const w = meta.width || 800;
  const h = meta.height || 600;
  const jpeg = await sharp(pngBuffer).jpeg({ quality: 88 }).toBuffer();

  // PDF 포인트: 1px ≈ 스케일, 최대 A4 가로
  const maxW = 842;
  const maxH = 595;
  const scale = Math.min(maxW / w, maxH / h, 1);
  const drawW = Math.round(w * scale);
  const drawH = Math.round(h * scale);
  const pageW = drawW + 40;
  const pageH = drawH + 40;

  const stream = `q\n${drawW} 0 0 ${drawH} 20 20 cm\n/Im0 Do\nQ\n`;
  const chunks = [];
  const push = (b) => chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b));

  push('%PDF-1.4\n');
  const offsets = [];

  const writeObj = (num, bodyBuf) => {
    offsets[num] = Buffer.concat(chunks).length;
    push(`${num} 0 obj\n`);
    push(bodyBuf);
    push('\nendobj\n');
  };

  writeObj(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  writeObj(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  writeObj(
    3,
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`,
    ),
  );
  writeObj(
    4,
    Buffer.concat([
      Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n`),
      Buffer.from(stream),
      Buffer.from('endstream'),
    ]),
  );
  writeObj(
    5,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
  );

  const xrefStart = Buffer.concat(chunks).length;
  const maxObj = 5;
  let xref = `xref\n0 ${maxObj + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= maxObj; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return Buffer.concat(chunks);
}

function demoScore() {
  return {
    title: 'Demo Tab',
    composer: '악보플레이',
    key: 'G',
    tempo: 90,
    timeSignature: '4/4',
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'],
    measures: [
      {
        events: [
          { string: 3, fret: 0, beat: 0 },
          { string: 2, fret: 0, beat: 1 },
          { string: 1, fret: 0, beat: 2 },
          { string: 2, fret: 0, beat: 3 },
        ],
      },
      {
        events: [
          { string: 3, fret: 2, beat: 0 },
          { string: 2, fret: 0, beat: 1 },
          { string: 1, fret: 3, beat: 2 },
          { string: 2, fret: 0, beat: 3 },
        ],
      },
      {
        events: [
          { string: 4, fret: 0, beat: 0 },
          { string: 3, fret: 0, beat: 1 },
          { string: 2, fret: 0, beat: 2 },
          { string: 3, fret: 0, beat: 3 },
        ],
      },
      {
        events: [
          { string: 4, fret: 2, beat: 0 },
          { string: 3, fret: 0, beat: 1 },
          { string: 2, fret: 3, beat: 2 },
          { string: 1, fret: 0, beat: 3 },
        ],
      },
    ],
  };
}

module.exports = {
  buildTabSvg,
  buildAsciiTab,
  svgToPng,
  pngToPdf,
  demoScore,
};
