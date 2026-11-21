FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/data \
    && chown node:node /var/data
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node db/ ./db/
COPY --chown=node:node scripts/backup-sqlite.js scripts/restaurar-sqlite.js scripts/sqlite-util.js ./scripts/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# Deixa margem para o checkpoint antes do SIGKILL do docker stop padrão.
ENV CHATFLOW_DESLIGAR_MS=8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/saude', { signal: AbortSignal.timeout(4000) }).then(r => { if (r.status !== 200) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
