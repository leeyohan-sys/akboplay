/**
 * 웹 브라우저 전체 높이/스크롤/커서 보정
 */
if (typeof document !== 'undefined') {
  const id = 'akboplay-web-base';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      html, body, #root {
        height: 100%;
        margin: 0;
        padding: 0;
        background: #0E1520;
        overflow: hidden;
      }
      #root, #root > div {
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      /* RN Pressable이 웹에서 클릭 영역/커서가 죽지 않도록 */
      button, [role="button"], a {
        cursor: pointer;
      }
      input, textarea {
        outline: none;
      }
      /* 스크롤바 가시성 */
      ::-webkit-scrollbar {
        width: 10px;
        height: 10px;
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
  }
}

export {};
