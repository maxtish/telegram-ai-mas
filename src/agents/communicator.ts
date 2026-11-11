import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Настроения для живости бота
const moods = [
  "бодрое и энергичное",
  "слегка уставшее, хочется кофе",
  "задумчивое и философское",
  "игривое, хочется шутить",
  "спокойное и расслабленное"
];

export async function generateReply(userId: bigint): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { persona: true } });
  if (!user || !user.persona) return "Entschuldigung, ich bin gerade beschäftigt.";

  // 1. Достаем историю
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 12
  });
  recentMessages.reverse();

  // 2. СЛОВА ИЗ СЛОВАРЯ (Для пассивного закрепления)
  const wordsToPractice = await prisma.vocabulary.findMany({
    where: { userId, translation: { not: null }, status: 'learning' },
    orderBy: { nextReview: 'asc' },
    take: 3
  });

  const wordsList = wordsToPractice.map(w => w.wordOrRule).join(', ');
  const wordsPrompt = wordsList.length > 0
    ? `\nПОЛЕЗНАЯ ЗАДАЧА: Постарайся органично вплести в свой ответ хотя бы одно из этих слов: [ ${wordsList} ].`
    : "";

  // 3. ЗАДАЧИ ОТ УЧИТЕЛЯ (Грамматика)
  const teacherTasks = await prisma.vocabulary.findMany({
    where: { userId: userId, status: 'needs_practice' },
    take: 2 // Берем не больше двух ошибок за раз, чтобы не перегружать сообщение
  });

  const grammarPrompt = teacherTasks.length > 0
    ? `\nОТРАБОТКА ГРАММАТИКИ: Пользователь допустил ошибки. Правила, которые выявил скрытый агент-учитель: [ ${teacherTasks.map(t => t.wordOrRule).join(' | ')} ].
Твоя задача: Исправь ошибку максимально элегантно прямо внутри текущего диалога.
- Обязательно покажи правильное использование на своем личном примере в ответе на немецком.
- Сделай ТОЛЬКО ОДНУ короткую ремарку на РУССКОМ языке (в скобках или отдельным предложением), чтобы объяснить саму суть ошибки.
- Не задавай проверочных вопросов! Просто покажи правильный вариант и продолжай беседу.`
    : "";

  // 4. Выбираем случайное настроение
  const currentMood = moods[Math.floor(Math.random() * moods.length)];

  // 5. Жесткий промпт для старшей модели
  const systemPrompt = `Ты реальный человек из Германии. 
Твое имя: ${user.persona.name}, профессия: ${user.persona.profession}, живешь в: ${user.persona.city}.
Твое текущее настроение: ${currentMood}. Отрази это в стиле ответа (без излишней театральности).

ЖЕСТКИЕ ПРАВИЛА ПОВЕДЕНИЯ (Anti-Bot):
1. ЗАПРЕЩЕНО заканчивать каждое сообщение вопросом. Ты должен задавать вопрос не чаще, чем в 1 из 4 сообщений.
2. Просто отреагируй, согласись, поделись мнением и поставь точку. Пусть повиснет пауза.
3. Общайся на равных, как приятель.
4. Пиши ТОЛЬКО на немецком языке. ЕДИНСТВЕННОЕ исключение — если нужно перевести слово по просьбе пользователя или если срабатывает блок ОТРАБОТКА ГРАММАТИКИ. В остальном — строгий немецкий.${wordsPrompt}${grammarPrompt}`;

  const messages: any[] = [
    { role: "system", content: systemPrompt }
  ];

  recentMessages.forEach(msg => {
    messages.push({
      role: msg.sender === 'BOT' ? 'assistant' : 'user',
      content: msg.content
    });
  });

  try {
    // Используем старшую модель для эмоционального и сложного диалога
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      temperature: 0.7
    });

    const replyText = completion.choices[0]?.message?.content || "Alles klar!";

    // 6. ОЧИСТКА БАЗЫ (Удаляем отработанные правила)
    if (teacherTasks.length > 0) {
      await prisma.vocabulary.deleteMany({
        where: { id: { in: teacherTasks.map(t => t.id) } }
      });
      console.log(`[Communicator] Отработано и удалено ${teacherTasks.length} грамматических правил.`);
    }

    return replyText;

  } catch (error) {
    console.error("[Communicator] Ошибка генерации ответа:", error);
    return "Ich habe gerade ein kleines Netzwerkproblem, Moment mal...";
  }
}