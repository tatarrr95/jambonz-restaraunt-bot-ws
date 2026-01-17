FROM node:20-alpine

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Порт приложения
EXPOSE 3000

# Запуск
CMD ["node", "app.js"]
