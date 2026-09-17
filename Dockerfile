FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN [ -f assets/master.mp4 ] || node scripts/make-test-master.js
ENV QUEUE=redis
EXPOSE 4000
CMD ["node", "worker/server.js"]
