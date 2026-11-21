import OpenAI from 'openai';
import prisma from '../database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function analyzeUserProfile(userId: bigint, messageText: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const currentProfile = {
        realName: user.realName || null,
        interests: user.interests || [],
        about: user.about || ""
    };

    const prompt = `Ты — редактор долговременной памяти (досье) пользователя.
Твоя задача: поддерживать досье в актуальном состоянии на основе нового сообщения.

ТЕКУЩЕЕ ДОСЬЕ:
${JSON.stringify(currentProfile, null, 2)}

НОВОЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${messageText}"

ПРАВИЛА РЕДАКТИРОВАНИЯ:
1. УДАЛЕНИЕ УСТАРЕВШЕГО: Если новое сообщение отменяет или исправляет старый факт (например, в досье написано "болеет / болит голова", а пользователь пишет "я выздоровел", "уже лучше", "всё прошло") — ОБЯЗАТЕЛЬНО удали устаревший факт из поля "about".
2. ФИЛЬТР ВРЕМЕННОГО: НЕ записывай в досье разовые и сиюминутные состояния ("болит голова", "устал сегодня", "иду в магазин", "пью кофе"). В "about" хранятся только долгосрочные факты (работа, семья, город, техника, важные проекты).
3. ОБНОВЛЕНИЕ: Если появились новые долгосрочные факты или хобби — аккуратно впиши их. Если изменилась работа, город или статус — замени старое на новое, не дублируй.
4. ЧИСТОТА: Поле "about" должно быть коротким (до 3-4 предложений), без воды и повторов.
5. Если в сообщении нет ничего, что требует менять досье — верни "hasChanges": false.

Верни СТРОГО JSON:
{
  "hasChanges": boolean,
  "realName": string | null,
  "interests": string[],
  "about": string
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-6-luna",
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" },

        });

        const data = JSON.parse(completion.choices[0]?.message?.content || '{"hasChanges": false}');

        if (!data.hasChanges) return;

        await prisma.user.update({
            where: { id: userId },
            data: {
                realName: data.realName ?? user.realName,
                interests: Array.isArray(data.interests) ? data.interests : user.interests,
                about: typeof data.about === 'string' ? data.about : user.about
            }
        });

        console.log(`[Profiler] Досье пользователя ${userId} обновлено/исправлено.`);
    } catch (error) {
        console.error("[Profiler] Ошибка обновления профиля:", error);
    }
}