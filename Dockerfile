FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app code + static assets (maps, data, vendor SDK comes from node_modules)
COPY server ./server
COPY public ./public

EXPOSE 3001
CMD ["node", "server/index.js"]
