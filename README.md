# 악보플레이 (AkboPlay)

PDF 악보를 첨부하면 곡을 찾아 **유튜브 플레이리스트**로 만들어 주는 웹/모바일 앱입니다.

## 온라인 접속

| 구분 | URL |
|------|-----|
| **웹 앱 (GitHub Pages)** | https://leeyohan-sys.github.io/akboplay/ |
| **API 서버 (Render)** | https://akboplay-api.onrender.com |

> 무료 Render API는 잠시 잠든 뒤 **첫 요청이 20~60초** 걸릴 수 있습니다.

## 로컬 실행 (Windows)

`run.bat` 더블클릭 → API + Expo 웹 실행

```bash
npm install
npm run server   # 터미널 1
npm start        # 터미널 2
```

## 구성

| 구분 | 기술 |
|------|------|
| 프론트 | Expo (React Native Web) → GitHub Pages |
| API | Express → Render |
| PDF | pdf-parse + 찬송가 휴리스틱 |
| 유튜브 | youtube-sr (API 키 불필요) + watch_videos |

## 사용 흐름

1. PDF 악보 첨부
2. 인식된 곡 확인·수정
3. **유튜브 앱으로 플레이리스트 만들기** → 새 창에서 자동 재생 목록 오픈
4. 유튜브에서 [저장]으로 내 플레이리스트에 보관

## 배포

- 프론트: `.github/workflows/deploy-pages.yml` (push 시 자동)
- API: `render.yaml` (Render에서 이 저장소 연결)

```bash
# 웹 정적보내기 로컬 확인
npm run export:web
```
