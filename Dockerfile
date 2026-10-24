FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    AUDIO_STORAGE_ROOT=/data/audio \
    FFMPEG_PATH=ffmpeg

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --include=dev

COPY --chown=node:node . .
RUN npm run build

EXPOSE 7860

CMD ["npm", "start"]
