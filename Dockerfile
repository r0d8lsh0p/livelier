# Standalone image for the Livelier bridge worker (Railway deploys build this).
# Local iteration uses docker-compose.yml, which mounts the repo instead.
#
#   docker build -t livelier .
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npx", "ts-node", "src/index.ts"]
