FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json lexicons.json ./
COPY lexicons ./lexicons
RUN npm ci

COPY tsconfig.json tsconfig.build.json tsconfig.test.json vitest.config.ts ./
COPY migrations ./migrations
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node
CMD ["node", "dist/main.js"]
