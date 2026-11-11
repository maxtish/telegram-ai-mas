import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================================================
// ДИСПЕТЧЕР 1: ЛИНГВИСТ (РАБОТАЕТ ТОЛЬКО С РУССКИМ ЯЗЫКОМ)
// ============================================================================
async function evaluateRussianInbox(inboxText: string, persona: any) {
  const prompt = `Ты диспетчер-лингвист. Твоя единственная задача — контролировать попытки пользователя использовать русский язык.
Собеседник (Бот): Имя ${persona.name}, профессия ${persona.profession}.

Входящие сообщения (написаны на русском):
${inboxText}

Оцени ситуацию.
ПРАВИЛА:
1. ИСКЛЮЧЕНИЕ (Обучение): Если пользователь просит перевести слово, объяснить правило, или спрашивает "как сказать по-немецки..." -> возвращай "reply_now".
2. ЗАПРЕТ (Болтовня): Если пользователь просто общается на русском ("привет", "как дела", "я пошел спать") -> возвращай "enforce_german".
3. ОЖИДАНИЕ: Если просит подождать ("сек", "минуту") -> "user_busy".

Верни СТРОГО JSON:
{
  "action": "reply_now" | "enforce_german" | "user_busy",
  "delayMinutes": 0,
  "useVoice": false,
  "reason": "Краткая причина"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o", // Флагманская модель для точного понимания контекста
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  return JSON.parse(completion.choices[0]?.message?.content || '{"action":"enforce_german", "delayMinutes": 0, "useVoice": false}');
}


// ============================================================================
// ДИСПЕТЧЕР 2: ПОВЕДЕНЧЕСКИЙ (РАБОТАЕТ ТОЛЬКО С НЕМЕЦКИМ ЯЗЫКОМ)
// ============================================================================
async function evaluateGermanInbox(inboxText: string, persona: any, timeString: string, dayOfWeek: string) {
  const prompt = `Ты старший диспетчер диалогов. Твоя задача — управлять естественным потоком общения на немецком языке.
Собеседник (Бот): Имя ${persona.name}, профессия ${persona.profession}.
Текущее время в Германии: ${timeString}, ${dayOfWeek}.

Входящие сообщения:
${inboxText}

Оцени ситуацию и выбери одно из действий.
ПРАВИЛА:
1. Если есть вопрос, новая тема или мысль, требующая реакции -> "reply_now".
2. РЕЖИМ ОТДЫХА: 
   - Вечер (до 00:00) -> "reply_now". 
   - Глубокая ночь (00:00 - 08:00) -> "delay" (минимум 30 мин). 
   - НАСТОЙЧИВОСТЬ: Если ночь, но написано 2+ сообщения подряд -> "reply_now".
3. ОЖИДАНИЕ: Попросил подождать ("warte", "moment") -> "user_busy".
4. ИГНОР: Просто междометия ("Ok", "Ja", "Aha", "Genau") или смайлик без смысла -> "ignore".
5. ГОЛОСОВЫЕ СООБЩЕНИЯ (useVoice):
   - По умолчанию false. 
   - true, если прямо просит аудио. 
   - С вероятностью 10% ставь true спонтанно.

Верни СТРОГО JSON:
{
  "action": "reply_now" | "delay" | "ignore" | "user_busy",
  "delayMinutes": 0,
  "useVoice": false,
  "reason": "Краткая причина"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o", // Флагманская модель для эмоционального интеллекта
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  return JSON.parse(completion.choices[0]?.message?.content || '{"action":"reply_now", "delayMinutes": 0, "useVoice": false}');
}


// ============================================================================
// ГЛАВНЫЙ РОУТЕР (Точка входа)
// ============================================================================
export async function evaluateInbox(userId: bigint) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { persona: true }
  });

  if (!user || !user.persona) throw new Error("User not found");

  const recentMessages = await prisma.message.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  const lastBotMsgIndex = recentMessages.findIndex(m => m.sender === 'BOT');
  const unreadMessages = lastBotMsgIndex === -1 ? recentMessages : recentMessages.slice(0, lastBotMsgIndex);

  if (unreadMessages.length === 0) return { action: "ignore", delayMinutes: 0 };

  unreadMessages.reverse();

  // ИСПОЛЬЗУЕМ НЕЙТРАЛЬНОЕ "User:", чтобы не триггерить детектор языков!
  const inboxText = unreadMessages.map(m => `User: ${m.content}`).join('\n');

  // ПРОГРАММНЫЙ ФИЛЬТР: Проверяем кириллицу ТОЛЬКО в самом тексте сообщений
  const pureUserText = unreadMessages.map(m => m.content).join(' ');
  const hasCyrillic = /[А-Яа-яЁё]/.test(pureUserText);

  const now = new Date();
  const timeString = now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const dayOfWeek = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' });

  // Распределяем задачи
  if (hasCyrillic) {
    return await evaluateRussianInbox(inboxText, user.persona);
  } else {
    return await evaluateGermanInbox(inboxText, user.persona, timeString, dayOfWeek);
  }
}