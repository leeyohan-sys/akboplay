/**
 * youtube-sr 래퍼 — 영상 하나 파싱 실패가 검색 전체를 죽이지 않게 보정
 *
 * youtube-sr(4.3.12, 유지보수 중단)는 채널 정보가 일반 형식이 아닌 영상
 * (공동 작업 영상 등: ownerText에 browseEndpoint 없음)을 만나면 TypeError로
 * 검색 결과 전체를 버린다. parseVideo를 감싸 그 영상만 건너뛴다.
 * (Formatter는 parseVideo가 falsy면 해당 항목을 continue 함)
 */
const mod = require('youtube-sr');

const { Util } = mod;
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
