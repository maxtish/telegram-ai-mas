import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Интервалы повторений в часах (индекс массива = текущий score)
// 0: через 10 минут, 1: 4 часа, 2: 24 часа, 3: 3 дня, 4: 7 дней, 5: выучено
const intervalsHours = [1/6, 4, 24, 72, 168]; 

export async function checkWordQuiz(userId: bigint, wordId: number, userAnswer: string) {
  const word = await prisma.vocabulary.findUnique({ where: { id: wordId } });
  if (!word) throw new Error("Слово не найдено");

  // 1. Умная проверка через LLM
  const prompt = `Ты строгий, но справедливый учитель немецкого.
Тебе нужно проверить, правильно ли ученик перевел слово.
Слово на русском: "${word.translation}"
Правильный перевод на немецкий: "${word.wordOrRule}"

Ученик ответил: "${userAnswer}"

ПРАВИЛА ОЦЕНКИ:
- Если ученик написал синоним, который тоже подходит -> "correct".
- Если ученик написал "не знаю", "weiß nicht", "idk" -> "wrong".
- Если перевод совсем неверный -> "wrong".
- Если перевод правильный, но ошибка в одной букве, или забыт/перепутан артикль (der/die/das), или неправильное окончание -> "typo".
- В поле feedback дай короткий комментарий на русском (максимум 1 предложение). Если "wrong", напиши правильный ответ. Если "typo", подскажи, где ошибка, но не пиши слово целиком, чтобы он сам исправил.

Верни СТРОГО JSON:
{
  "status": "correct" | "wrong" | "typo",
  "feedback": "твой комментарий"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
    response_format: { type: "json_object" }
  });

  const result = JSON.parse(completion.choices[0]?.message?.content || '{"status":"wrong", "feedback":"Ошибка сервера"}');

  // 2. Обновляем базу в зависимости от ответа
  let newState = 'IDLE'; // По умолчанию возвращаем пользователя в обычный режим

  if (result.status === 'correct') {
    const nextScore = Math.min(word.score + 1, 5);
    const addHours = intervalsHours[nextScore - 1] || 720; // 1 месяц, если уже выучил
    const nextReview = new Date(Date.now() + addHours * 60 * 60 * 1000);
    
    await prisma.vocabulary.update({
      where: { id: word.id },
      data: { score: nextScore, nextReview }
    });
  } 
  
  else if (result.status === 'wrong') {
    // Сбрасываем прогресс, повторим через 10 минут
    const nextReview = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.vocabulary.update({
      where: { id: word.id },
      data: { score: 0, nextReview }
    });
  } 
  
  else if (result.status === 'typo') {
    // При опечатке даем второй шанс, оставляем состояние QUIZ
    newState = `QUIZ_${word.id}`;
  }

  // Возвращаем результат проверки, чтобы отправить его в Телеграм
  return {
    isTypo: result.status === 'typo',
    newState: newState,
    feedback: result.feedback
  };
}