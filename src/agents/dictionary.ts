import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function processNewWords(userId: bigint, text: string) {
  const prompt = `Ты лингвист-преподаватель немецкого языка. Пользователь хочет добавить слова в свой словарь.
Его сообщение: "${text}"

Выдели из сообщения все слова или фразы. 
Если слово на русском — дай точный перевод на немецкий (существительные ОБЯЗАТЕЛЬНО с артиклем der/die/das). 
Если слово на немецком — дай перевод на русский.

Верни СТРОГО JSON:
{
  "words": [
    { "de": "das Fenster", "ru": "окно" },
    { "de": "laufen", "ru": "бегать" }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"words":[]}');
    
    let addedWords = [];
    for (const w of result.words) {
      // Ищем, нет ли уже такого слова у пользователя
      const existing = await prisma.vocabulary.findFirst({
        where: { userId: userId, wordOrRule: w.de }
      });

      if (!existing) {
        await prisma.vocabulary.create({
          data: {
            userId: userId,
            wordOrRule: w.de,
            translation: w.ru,
            status: 'learning',
            score: 0,
            nextReview: new Date() // Готово к повторению прямо сейчас
          }
        });
        addedWords.push(`🇩🇪 ${w.de} — 🇷🇺 ${w.ru}`);
      }
    }
    return addedWords;
  } catch (error) {
    console.error("[Dictionary] Ошибка добавления слов:", error);
    return [];
  }
}

export async function fixBrokenWords(userId: bigint) {
  // Ищем только слова (learning), у которых пропал перевод
  const brokenWords = await prisma.vocabulary.findMany({
    where: { 
      userId: userId, 
      translation: null, 
      status: 'learning' 
    }
  });

  if (brokenWords.length === 0) return 0;

  let fixedCount = 0;
  for (const word of brokenWords) {
    const prompt = `Переведи это слово/фразу на русский (если это русское слово - переведи на немецкий с артиклем). 
Выдай ТОЛЬКО перевод, без кавычек, точек и лишних слов: "${word.wordOrRule}"`;
    
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3 // Низкая температура для строгого перевода без фантазий
      });
      
      const translation = completion.choices[0]?.message?.content?.trim();
      
      if (translation) {
        await prisma.vocabulary.update({
          where: { id: word.id },
          data: { translation: translation }
        });
        fixedCount++;
      }
    } catch (e) {
      console.error(`[Dictionary] Ошибка перевода для ${word.wordOrRule}:`, e);
    }
  }
  
  return fixedCount;
}
