FROM node:24-bookworm-slim

WORKDIR /app
RUN mkdir -p /var/data && chown node:node /var/data
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node db/ ./db/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/saude', { signal: AbortSignal.timeout(4000) }).then(r => { if (r.status !== 200) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]

CMD ["node", "src/server.js"]
