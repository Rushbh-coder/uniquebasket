# Stage 1: build the admin/billing screens
FROM node:20-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY vite.config.mjs ./
COPY client ./client
RUN npx vite build

# Stage 2: cloud API + web screens
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY cloud.js ./
COPY --from=build /app/client/dist ./client/dist
ENV NODE_ENV=production
EXPOSE 4310
CMD ["node", "cloud.js"]
