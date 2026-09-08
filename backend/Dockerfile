FROM node:20-alpine

# ffmpeg for transcoding WhatsApp voice notes (Ogg/Opus → MP3) so Safari can play them
RUN apk update && apk add --no-cache ffmpeg

WORKDIR /app

# Build context is the repo ROOT (see docker-compose.yml: context: .) so the
# boot-time migration runner can copy db/migrations into the image.
COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/src/ ./src/
COPY backend/scripts/ ./scripts/
COPY db/migrations/ ./db/migrations/

ENV NODE_ENV=production
EXPOSE 3011

# Phase 13: readiness gates traffic (PG + migrations + Redis); liveness alone
# would route to a half-alive process. Compose also wires depends_on on this.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3011')+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
