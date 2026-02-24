FROM node:lts-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev && \
    npm dedupe && \
    npm prune --omit=dev && \
    npm cache clean --force && \
    rm -rf /root/.npm
COPY . .
EXPOSE 8999
CMD ["node", "index.js"]
