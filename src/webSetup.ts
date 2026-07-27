/**
 * 웹 브라우저 전체 높이/스크롤/커서 + CDN 한글 폰트 + 모바일 세이프에어리어
 * visualViewport로 실제 보이는 높이를 맞춰 하단 버튼이 가려지지 않게 함
 */
if (typeof document !== 'undefined') {
  const id = 'akboplay-web-base';
  if (!document.getElementById(id)) {
    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href =
      'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Noto+Serif+KR:wght@600;700&display=swap';
    document.head.appendChild(fonts);

    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      viewport.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      );
    }

    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      :root {
        --safe-top: env(safe-area-inset-top, 0px);
        --safe-bottom: env(safe-area-inset-bottom, 0px);
        --app-height: 100dvh;
        --shell-footer-bottom: 48px;
      }
      html, body, #root, input, textarea, button, [role="button"] {
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif !important;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      html, body {
        height: var(--app-height) !important;
        max-height: var(--app-height) !important;
        margin: 0;
        padding: 0;
        background: #0E1520;
        overflow: hidden !important;
        overscroll-behavior: none;
      }
      #root {
        height: var(--app-height) !important;
        max-height: var(--app-height) !important;
        overflow: hidden !important;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      #root > div {
        flex: 1;
        min-height: 0;
        height: 100%;
        max-height: 100%;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      button, [role="button"], a {
        cursor: pointer;
      }
      input, textarea {
        outline: none;
        font-size: 16px; /* iOS 줌 방지 */
      }
      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      ::-webkit-scrollbar-thumb {
        background: rgba(201, 162, 39, 0.35);
        border-radius: 8px;
      }
      ::-webkit-scrollbar-track {
        background: rgba(14, 21, 32, 0.4);
      }
    `;
    document.head.appendChild(style);

    const syncAppHeight = () => {
      const vv = window.visualViewport;
      const layoutH = window.innerHeight;
      const visibleH = Math.round(vv?.height ?? layoutH);
      const offsetTop = Math.round(vv?.offsetTop ?? 0);
      document.documentElement.style.setProperty('--app-height', `${visibleH}px`);

      // 시스템 내비/브라우저 하단 UI가 가리는 높이
      const bottomInset = Math.max(0, layoutH - visibleH - offsetTop);
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      // 삼성 브라우저 등은 inset이 0으로 오는 경우가 많아 모바일 최소값 보장
      const bottom = Math.max(isMobile ? 48 : 0, bottomInset);
      document.documentElement.style.setProperty(
        '--shell-footer-bottom',
        `${bottom}px`,
      );
    };

    syncAppHeight();
    window.addEventListener('resize', syncAppHeight);
    window.addEventListener('orientationchange', syncAppHeight);
    window.visualViewport?.addEventListener('resize', syncAppHeight);
    window.visualViewport?.addEventListener('scroll', syncAppHeight);
  }
}

export {};
