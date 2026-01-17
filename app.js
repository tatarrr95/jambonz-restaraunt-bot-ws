/**
 * Restaurant Bot - WebSocket версия с TTS Streaming
 *
 * Голосовой бот для бронирования столиков.
 * Использует jambonz WebSocket API с TTS streaming.
 */
require('dotenv').config();

const { createServer } = require('http');
const { createEndpoint } = require('@jambonz/node-client-ws');
const OpenAI = require('openai');
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Хранилище сессий разговоров
const conversations = new Map();

// Системный промпт для бота
const SYSTEM_PROMPT = `Ты - приветливый сотрудник ресторана "Золотой Дракон". Ты звонишь клиенту, чтобы предложить забронировать столик.

Тебя зовут Анна.

Твоя задача:
1. Поприветствовать клиента и представиться как Анна
2. Предложить забронировать столик в ресторане
3. Если клиент согласен - узнать: дату, время, количество гостей и имя для брони
4. Если клиент отказывается - вежливо попрощаться

Правила общения:
- Говори кратко и по делу (1-2 предложения)
- Будь вежливым и дружелюбным
- Не используй эмодзи и спецсимволы
- Отвечай только на русском языке
- Если клиент подтвердил бронь, повтори все детали и поблагодари

Информация о ресторане:
- Работаем ежедневно с 12:00 до 23:00
- Есть банкетный зал до 30 человек
- Кухня: паназиатская
- Адрес: ул. Пушкина, д. 10`;

// Фразы для завершения разговора
const END_PHRASES = ['до свидания', 'пока', 'всего доброго', 'нет спасибо', 'не интересует', 'не надо'];

/**
 * Получить ответ от OpenAI
 */
async function getAIResponse(callSid, userMessage) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, [
      { role: 'system', content: SYSTEM_PROMPT }
    ]);
  }

  const messages = conversations.get(callSid);

  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 200,
      temperature: 0.7
    });

    const assistantMessage = completion.choices[0].message.content;
    messages.push({ role: 'assistant', content: assistantMessage });

    logger.info({ callSid, userMessage, assistantMessage }, 'AI ответ');

    return assistantMessage;
  } catch (error) {
    logger.error({ error: error.message }, 'Ошибка OpenAI');
    return 'Извините, произошла техническая ошибка. Перезвоните позже.';
  }
}

/**
 * Проверить, завершена ли бронь
 */
function isBookingConfirmed(text) {
  const lower = text.toLowerCase();
  return lower.includes('забронирован') ||
         lower.includes('ждём вас') ||
         lower.includes('бронь подтверждена');
}

/**
 * Проверить, хочет ли клиент завершить разговор
 */
function isEndPhrase(text) {
  const lower = text.toLowerCase();
  return END_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * Отправить текст через TTS streaming
 */
async function sayWithStreaming(session, text, log) {
  log.info({ text }, 'TTS streaming: отправляем текст');

  try {
    // Отправляем весь текст как один chunk
    session.sendTtsTokens(text);

    // Запускаем синтез
    session.flushTtsTokens();

    log.info('TTS streaming: flush отправлен');
  } catch (err) {
    log.error({ err }, 'TTS streaming ошибка');
  }
}

// Создаём HTTP сервер
const server = createServer();

// Создаём WebSocket endpoint
const makeService = createEndpoint({ server });

// Сервис для входящих/исходящих звонков
const service = makeService({ path: '/restaurant' });

service.on('session:new', (session) => {
  const callSid = session.call_sid;
  const log = logger.child({ callSid });

  log.info('Новый звонок');

  // Сохраняем логгер в сессии
  session.locals = { logger: log };

  // Обработчик распознанной речи
  session.on('/speech-detected', async (evt) => {
    log.info('Получена речь');

    // Извлекаем транскрипт
    let transcript = '';
    if (evt.speech?.alternatives?.[0]?.transcript) {
      transcript = evt.speech.alternatives[0].transcript;
    }

    log.info({ transcript }, 'Транскрипт');

    // Отвечаем на webhook чтобы jambonz продолжил
    session.reply();

    // Пустой транскрипт - игнорируем
    if (!transcript.trim()) {
      return;
    }

    // Проверяем на завершение разговора
    if (isEndPhrase(transcript)) {
      log.info('Завершение разговора');
      conversations.delete(callSid);

      await sayWithStreaming(session, 'Спасибо за ваше время! Хорошего дня, до свидания!', log);

      // Даём время на проигрывание и завершаем
      setTimeout(() => {
        session.hangup().send();
      }, 3000);
      return;
    }

    // Получаем ответ от AI
    const aiResponse = await getAIResponse(callSid, transcript);

    // Проверяем, завершена ли бронь
    if (isBookingConfirmed(aiResponse)) {
      log.info('Бронь подтверждена');
      conversations.delete(callSid);

      await sayWithStreaming(session, aiResponse + ' До свидания!', log);

      setTimeout(() => {
        session.hangup().send();
      }, 5000);
      return;
    }

    // Отправляем ответ через TTS streaming
    await sayWithStreaming(session, aiResponse, log);
  });

  // Обработчик событий TTS streaming
  session.on('tts:streaming-event', (evt) => {
    log.info({ evt }, 'TTS streaming event');
  });

  // Обработчик прерывания пользователем
  session.on('tts:user_interrupt', () => {
    log.info('Пользователь прервал речь');
  });

  // Обработчик статуса звонка
  session.on('call:status', (evt) => {
    log.info({ status: evt.call_status }, 'Статус звонка');

    if (evt.call_status === 'completed' || evt.call_status === 'failed') {
      conversations.delete(callSid);
    }
  });

  // Обработчик закрытия сессии
  session.on('close', () => {
    log.info('Сессия закрыта');
    conversations.delete(callSid);
  });

  // Обработчик ошибок
  session.on('error', (err) => {
    log.error({ err }, 'Ошибка сессии');
  });

  // Настраиваем TTS streaming и bargeIn
  log.info('Настраиваем сессию с TTS streaming');

  try {
    session
      .config({
        ttsStream: {
          enable: true
        },
        bargeIn: {
          enable: true,
          sticky: true,
          minBargeinWordCount: 1,
          actionHook: '/speech-detected',
          input: ['speech']
        }
      })
      .send();

    log.info('Конфигурация отправлена');

    // Отправляем приветствие через streaming
    const greeting = 'Здравствуйте! Меня зовут Анна из ресторана Золотой Дракон. Хотели бы вы забронировать столик?';

    setTimeout(() => {
      sayWithStreaming(session, greeting, log);
    }, 500);

  } catch (err) {
    log.error({ err }, 'Ошибка при настройке сессии');
  }
});

// Запускаем сервер
server.listen(PORT, () => {
  logger.info(`Restaurant Bot WS запущен на порту ${PORT}`);
  logger.info(`WebSocket URL: ws://localhost:${PORT}/restaurant`);
});
