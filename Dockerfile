# The browser of the agent: Chromium from Debian under puppeteer-core, a Fastify API on port 3000.
# spec: BRIEF.md#интернет-и-браузер
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-noto-color-emoji ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10010 browser \
    && mkdir -p /profiles && chown browser:browser /profiles
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js guard.js ./
USER browser
ENV CHROMIUM_PATH=/usr/bin/chromium PROFILES_DIR=/profiles PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
