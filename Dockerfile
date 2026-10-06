FROM node:20-alpine

WORKDIR /app

# 零外部依赖：直接拷贝源码，无需 npm install
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "server/index.js"]
