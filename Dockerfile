FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app

# ffmpeg für die Video-Transkodierung des Umkleide-Displays
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]