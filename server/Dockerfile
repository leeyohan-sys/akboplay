# Render.com Web Service용 (LilyPond 렌더를 위해 Debian 기반 + apt lilypond 사용)
FROM node:22-bookworm-slim
WORKDIR /app

# LilyPond 본체 + 폰트 (fontconfig 캐시는 apt 후처리 시 자동 생성됨)
RUN apt-get update && apt-get install -y --no-install-recommends \
      lilypond \
      fontconfig \
      fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "index.js"]
