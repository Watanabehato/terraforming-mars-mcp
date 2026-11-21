ARG NODE_IMAGE=node:26-alpine3.23
FROM ${NODE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY e2e ./e2e
RUN npm run build

ENV NODE_ENV=production
USER node

EXPOSE 8765
CMD ["node", "dist/server.js"]
