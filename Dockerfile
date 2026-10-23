FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

# The server uses only Node.js built-ins; no npm install is needed.
COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "server/healthcheck.js"]

CMD ["node", "server/index.js"]
