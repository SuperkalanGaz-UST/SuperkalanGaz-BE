ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /srv/app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /srv/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /srv/app/dist ./dist
USER node

EXPOSE 3001
CMD ["node", "dist/main.js"]
