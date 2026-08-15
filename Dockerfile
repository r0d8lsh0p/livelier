# Standalone image for the Livelier bridge worker (Railway deploys build this).
# Local iteration uses docker-compose.yml, which mounts the repo instead.
#
#   docker build -t livelier .
FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/bridge/package.json packages/bridge/
RUN npm ci

COPY . .

CMD ["npm", "start", "-w", "packages/bridge"]
