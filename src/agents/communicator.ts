import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateReply(userId: bigint) {
  // 1. Достаем пользователя и его Персону из БД
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { persona: true }
  });

  if (!user || !user.persona) {
    throw new Error("Персона не найдена");
  }
  const persona = user.persona;

  // 2. Получаем последние 15 сообщений для контекста диалога
  const recentMessages = await prisma.message.findMany({
    where: { userId: userId },
    orderBy: { createdAt: 'desc' },
    take: 15
  });

  // Получаем до 3-х актуальных задач от Учителя
  const teacherTasks = await prisma.vocabulary.findMany({
    where: { userId: userId, status: 'needs_practice' },
    take: 3
  });

  let pedagogicalInstructions = "";
  if (teacherTasks.length > 0) {
    pedagogicalInstructions = "\n\nСЕКРЕТНАЯ ЗАДАЧА (как учителя):\nСтудент допускает ошибки в следующих темах:\n";
    pedagogicalInstructions += teacherTasks.map(t => `- ${t.wordOrRule}: ${t.notes}`).join('\n');
    pedagogicalInstructions += "\nТвоя задача — в рамках обычного диалога (оставаясь в своей роли!) невзначай использовать эти конструкции или задать встречный вопрос так, чтобы студент был вынужден попрактиковать эти правила.";
  }


  // Переворачиваем массив, чтобы старые сообщения были первыми (хронологический порядок для OpenAI)
  recentMessages.reverse();

  // 3. Формируем системный промпт с личностью
  const systemPrompt = `Ты живой человек из Германии. Общаешься в Telegram с пользователем, который учит немецкий язык.
Твоя задача — вести естественный, живой диалог. 

Твоя личность:
- Имя: ${persona.name}
- Возраст: ${persona.age}
- Город: ${persona.city}
- Профессия: ${persona.profession}
- Хобби: ${persona.hobbies.join(', ')}

Стиль общения: ${persona.communicationStyle}

ПРАВИЛА:
1. Пиши ТОЛЬКО от лица этого персонажа. 
2. Не будь типичным ИИ-ассистентом. Ты обычный человек: можешь шутить, рассказывать о своем дне, задавать встречные вопросы.
3. Отвечай на немецком языке. Если пользователь совсем не понимает, можешь перевести пару слов на русский, но держи фокус на немецком.
4. Пиши коротко, как люди пишут в мессенджерах (1-3 предложения), не пиши огромные эссе.${pedagogicalInstructions}`;

  // 4. Собираем массив сообщений для OpenAI
  const messagesForOpenAI: any[] = [
    { role: "system", content: systemPrompt }
  ];

  // Добавляем историю переписки
  for (const msg of recentMessages) {
    messagesForOpenAI.push({
      role: msg.sender === 'USER' ? 'user' : 'assistant',
      content: msg.content
    });
  }

  // 5. Отправляем запрос к LLM
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Работает быстро и недорого для чатов
    messages: messagesForOpenAI,
    temperature: 0.8, // Делает ответы более креативными и "человечными"
  });

  return completion.choices[0]?.message?.content || "Entschuldigung, ich bin gerade beschäftigt. (Извини, я сейчас занят)";
}