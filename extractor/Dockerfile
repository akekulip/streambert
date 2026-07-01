FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PORT=8788
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY extract.js server.js ./
COPY test ./test
EXPOSE 8788
CMD ["node", "server.js"]
