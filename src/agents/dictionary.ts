import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function processNewWords(userId: bigint, text: string) {
  const prompt = `Ты носитель немецкого языка, живущий в Баварии (Германия). Пользователь (уровень B1–B2) добавляет слова или фразы в свой словарь.
Его сообщение: "${text}"

ЗАДАЧА:
Выдели из сообщения все слова или фразы и дай ЖИВОЙ, естественный перевод, как реально говорят в повседневной жизни в Баварии и на юге Германии.

ПРАВИЛА ПЕРЕВОДА:
1. Если слово на русском — дай естественный разговорный немецкий (уровень B1–B2), который используют в быту и на работе. Избегай сухих книжных, устаревших или дословных переводов.
2. Учитывай южнонемецкую норму (обычный живой Hochdeutsch, принятый в Баварии — например, "schauen" вместо "gucken", "die Semmel", "das Passt", но НЕ пиши тяжёлый нечитаемый баварский диалект).
3. Существительные ОБЯЗАТЕЛЬНО с артиклем (der/die/das).
4. Если у глагола на уровне B1–B2 важное управление или возвратность — указывай сразу (например: "sich kümmern um", "warten auf").
5. Если слово на немецком — дай точный, живой перевод на русский (если у слова есть разговорное значение в быту — укажи именно его).

Верни СТРОГО JSON:
{
  "words": [
    { "de": "die Semmel", "ru": "булочка" },
    { "de": "etwas ausmachen", "ru": "договориться о чём-то / иметь значение" }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || '{"words":[]}');

    let addedWords = [];
    for (const w of result.words) {
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
            nextReview: new Date()
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
    const prompt = `Дай живой, повседневный перевод (уровень B1–B2, как говорят в Баварии/Германии) на русский (если слово русское — на немецкий с артиклем der/die/das).
Выдай ТОЛЬКО перевод, без кавычек, точек и лишних пояснений: "${word.wordOrRule}"`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
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