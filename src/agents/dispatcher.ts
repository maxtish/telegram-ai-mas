import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function evaluateInbox(userId: bigint) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { persona: true }
  });

  if (!user || !user.persona) throw new Error("User not found");
  const persona = user.persona;

  const recentMessages = await prisma.message.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  const lastBotMsgIndex = recentMessages.findIndex(m => m.sender === 'BOT');
  const unreadMessages = lastBotMsgIndex === -1 ? recentMessages : recentMessages.slice(0, lastBotMsgIndex);

  if (unreadMessages.length === 0) return { action: "ignore", delayMinutes: 0 };

  unreadMessages.reverse();

  const inboxText = unreadMessages.map(m => `Студент: ${m.content}`).join('\n');

  const now = new Date();
  const timeString = now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const dayOfWeek = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' });

  const prompt = `Ты строгий диспетчер сообщений.
Собеседник (Бот): Имя ${persona.name}, профессия ${persona.profession}.
Текущее время в Германии: ${timeString}, ${dayOfWeek}.

Неотвеченные сообщения от пользователя (сверху вниз, самое нижнее - последнее):
${inboxText}

Оцени ситуацию и выбери одно из действий.
ПРАВИЛА:
1. Если в сообщениях есть вопрос, новая тема или мысль, требующая ответа -> "reply_now".
2. РЕЖИМ СНА И ОТДЫХА:
   - Вечер (вплоть до 00:00) — это нормальное время. НЕ уходи в спячку, смело отвечай ("reply_now").
   - Если сейчас глубокая ночь (с 00:00 до 08:00) или бот точно на работе -> "delay" (в поле "delayMinutes" укажи минимум 30).
   - ИСКЛЮЧЕНИЕ (НАСТОЙЧИВОСТЬ): Если сейчас ночь/работа, НО пользователь написал 2 или более сообщений подряд, значит он очень хочет пообщаться — "просыпайся" и отвечай ("reply_now").
3. Если пользователь попросил подождать ("момент", "щас", "секунду", "warte") -> "user_busy".
4. Если вся эта серия сообщений — это просто "Ок", "Ага", "Ja", "Gut" или смайлик без вопросов -> "ignore".
5. ЯЗЫКОВОЙ ПАТРУЛЬ (ВНИМАТЕЛЬНО ПРОЧТИ):
   Сначала физически проверь, какие буквы использует пользователь.
   - Если текст написан на НЕМЕЦКОМ языке (латиница) -> ПАТРУЛЬ НЕ СРАБАТЫВАЕТ! Запрещено выбирать "enforce_german". Переходи к правилу 1.
   - Если текст написан на РУССКОМ языке (кириллица):
     а) Если это просьба перевести слово, объяснить правило или задать вопрос по грамматике -> "reply_now" (разрешаем).
     б) Если это обычный разговор (например, "как дела", "я пошел спать", "что делаешь") -> "enforce_german" (запрещаем).

Верни СТРОГО JSON:
{
  "action": "reply_now" | "delay" | "ignore" | "user_busy" | "enforce_german",
  "delayMinutes": 0,
  "reason": "Кратко объясни причину"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  return JSON.parse(completion.choices[0]?.message?.content || '{"action":"reply_now", "delayMinutes": 0}');
}