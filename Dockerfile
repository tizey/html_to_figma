FROM node:20-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY tsconfig.json tsconfig.service.json ./
COPY src ./src

RUN npm run build:service && npm prune --omit=dev

ENV HOST=0.0.0.0

CMD ["node", "./service/dist/service/index.js"]
