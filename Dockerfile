FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY piano.html ./

EXPOSE 3000

CMD ["bun", "run", "server.js"]