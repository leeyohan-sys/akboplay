/**
 * youtube-sr 래퍼 — 영상 하나 파싱 실패가 검색 전체를 죽이지 않게 보정
 *
 * youtube-sr(4.3.12, 유지보수 중단)는 채널 정보가 일반 형식이 아닌 영상
 * (공동 작업 영상 등: ownerText에 browseEndpoint 없음)을 만나면 TypeError로
 * 검색 결과 전체를 버린다. parseVideo를 감싸 그 영상만 건너뛴다.
 * (Formatter는 parseVideo가 falsy면 해당 항목을 continue 함)
 *
 * 또 유튜브 검색 페이지의 응답 헤더가 Node fetch 기본 한도(16KB)를 넘어
 * HeadersOverflowError로 모든 검색이 실패하므로, 헤더 한도를 늘린
 * undici fetch로 HTML을 받도록 getHTML을 교체한다.
 */
const { fetch: undiciFetch, Agent } = require('undici');
const mod = require('youtube-sr');

const { Util } = mod;

const bigHeaderAgent = new Agent({ maxHeaderSize: 128 * 1024 });

if (Util && typeof Util.getHTML === 'function' && !Util.getHTML.__safe) {
  const safeGetHTML = async (url, requestOptions = {}) => {
    const res = await undiciFetch(url, {
      ...requestOptions,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0',
        ...(requestOptions?.headers || {}),
      },
      dispatcher: bigHeaderAgent,
    });
    if (!res.ok) throw new Error(`Rejected with status code: ${res.status}`);
    return res.text();
  };
  safeGetHTML.__safe = true;
  Util.getHTML = safeGetHTML;
}
if (Util && typeof Util.parseVideo === 'function' && !Util.parseVideo.__safe) {
  const original = Util.parseVideo.bind(Util);
  const safeParseVideo = (data) => {
    try {
      return original(data);
    } catch {
      return null;
    }
  };
  safeParseVideo.__safe = true;
  Util.parseVideo = safeParseVideo;
}

module.exports = mod.default;
