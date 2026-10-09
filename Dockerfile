FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production PORT=3030
EXPOSE 3030
USER node
CMD ["node", "src/http.ts"]
