FROM node:22-alpine

WORKDIR /app
COPY github-stats-card/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY github-stats-card/server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
