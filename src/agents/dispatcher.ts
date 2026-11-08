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
  
  // Делаем явный формат сообщений, чтобы ИИ видел последовательность
  const inboxText = unreadMessages.map(m => `Студент: ${m.content}`).join('\n');

  const now = new Date();
  const timeString = now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const dayOfWeek = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' });

  const prompt = `Ты диспетчер сообщений.
Собеседник (Бот): Имя ${persona.name}, профессия ${persona.profession}.
Текущее время в Германии: ${timeString}, ${dayOfWeek}.

Неотвеченные сообщения от пользователя (сверху вниз, самое нижнее - последнее):
${inboxText}

Оцени ситуацию и выбери одно из действий.
ПРАВИЛА:
1. Если в сообщениях есть вопрос, новая тема или мысль, требующая ответа -> "reply_now".
2. Если бот сейчас должен быть на работе или глубокая ночь -> "delay".
3. Если пользователь попросил подождать ("момент", "щас", "секунду") -> "user_busy".
4. Если вся эта серия сообщений — это просто "Ок", "Ага" или смайлик без вопросов -> "ignore".
5. НОВОЕ ПРАВИЛО (ЯЗЫК): Если пользователь пишет на РУССКОМ языке:
   - Если это просьба что-то объяснить, перевести или вопрос по грамматике -> "reply_now" (разрешаем).
   - Если это просто обычный разговор на русском (например, "как дела", "пошли гулять", "что делаешь") -> "enforce_german" (запрещаем).

Верни СТРОГО JSON:
{
  "action": "reply_now" | "delay" | "ignore" | "user_busy" | "enforce_german",
  "delayMinutes": 0,
  "reason": "Кратко объясни причину"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  return JSON.parse(completion.choices[0]?.message?.content || '{"action":"reply_now", "delayMinutes": 0}');
}