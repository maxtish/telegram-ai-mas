import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function analyzeMistakes(userId: bigint) {
  console.log(`[Teacher] Запуск фонового анализа для пользователя ${userId}...`);

  // 1. Берем последние 10 сообщений диалога
  const recentMessages = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  // Если диалог еще слишком короткий, анализировать нечего
  if (recentMessages.length < 4) return;

  // 2. Формируем текст диалога для анализа
  const dialogText = recentMessages
    .reverse()
    .map(m => `${m.sender === 'USER' ? 'Студент' : 'Бот'}: ${m.content}`)
    .join('\n');

  // 3. Строгий промпт, чтобы ИИ вернул только JSON
  const systemPrompt = `Ты методист немецкого языка. 
Проанализируй диалог между Студентом и Ботом. 
Найди 1-2 главные грамматические или лексические ошибки Студента.
Верни результат СТРОГО в формате JSON. Если ошибок нет, верни пустой массив.
Формат:
{
  "items": [
    {
      "wordOrRule": "Название правила или слово (например: Dativ с предлогом mit)",
      "notes": "Короткая подсказка для бота (например: Студент забывает менять артикль. Задай вопрос с предлогом mit)"
    }
  ]
}`;

  try {
    // 4. Запрос к дешевой и быстрой модели
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: dialogText }
      ],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"items":[]}');

    // 5. Сохраняем найденные ошибки в базу
    for (const item of result.items) {
      // Проверяем, не добавляли ли мы уже это правило
      const existing = await prisma.vocabulary.findFirst({
        where: { userId, wordOrRule: item.wordOrRule }
      });

      if (!existing) {
        await prisma.vocabulary.create({
          data: {
            userId,
            wordOrRule: item.wordOrRule,
            status: 'needs_practice',
            notes: item.notes
          }
        });
        console.log(`[Teacher] Найдена ошибка. В словарь добавлено: ${item.wordOrRule}`);
      }
    }
  } catch (error) {
    console.error("[Teacher] Ошибка при анализе текста:", error);
  }
}