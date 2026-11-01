# Banbo TEE agent image. Build reproducibly and reference it by digest in
# docker-compose.yml: the compose file's hash is what the vault owner approves.
FROM node:22.11.0-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
