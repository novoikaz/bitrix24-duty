FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN mkdir -p /app/data
ENV NODE_ENV=production DATABASE_PATH=/app/data/duty.sqlite PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
