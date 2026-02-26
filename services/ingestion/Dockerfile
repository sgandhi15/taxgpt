FROM node:20-slim

RUN apt-get update && apt-get install -y \
    catdoc \
    unzip \
    libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npx", "tsx", "src/index.ts"]
