require('dotenv').config();
import { Markup, Telegraf } from 'telegraf';
import prisma from '../database';
import { mainMenu, cancelKeyboard, quizKeyboard } from './keyboards';
import { messageQueue } from '../workers/scheduler';

import { processNewWords } from '../agents/dictionary';
import { checkWordQuiz } from '../agents/examiner';
import { analyzeMistakes } from '../agents/teacher';
import OpenAI from 'openai';
import { analyzeUserProfile } from '../agents/profiler';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function setupMessageHandlers(bot: Telegraf) {

    bot.on('text', async (ctx) => {
        const text = ctx.message.text;
        const telegramId = BigInt(ctx.from.id);
        const user = await prisma.user.findUnique({ where: { id: telegramId } });
        if (!user) return;

        // 1. ОБРАБОТКА КНОПОК ОТМЕНЫ
        if (text === '❌ Отмена' || text === '❌ Завершить тренировку') {
            await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });
            return ctx.reply("Тренировка прервана. Возвращаемся к диалогу!", mainMenu);
        }

        // 2. КНОПКА: ДОБАВИТЬ СЛОВА
        if (text === '📘 Добавить слова') {
            await prisma.user.update({ where: { id: telegramId }, data: { botState: 'WAITING_WORDS' } });
            return ctx.reply("Отправь мне слова, которые хочешь выучить (на русском или немецком). Можно списком или в строчку.", Markup.keyboard([['❌ Отмена']]).resize());
        }

        // 3. КНОПКА: ПОВТОРЯТЬ СЛОВА (ЗАПУСК СЕССИИ)
        if (text === '🧠 Повторять слова') {
            // Ищем до 20 слов, которые пора повторять
            const wordsToReview = await prisma.vocabulary.findMany({
                where: {
                    userId: telegramId,
                    nextReview: { lte: new Date() },
                    translation: { not: null }
                },
                orderBy: { nextReview: 'asc' },
                take: 20
            });

            if (wordsToReview.length === 0) {
                return ctx.reply("Все слова повторены! Пока нет новых слов для проверки. Можешь отдыхать ☕", mainMenu);
            }

            // Сохраняем состояние сессии в формате JSON в поле botState
            // queue - массив ID слов, которые нужно спросить
            // current - ID текущего слова
            // correct/wrong - статистика для финального отчета
            const sessionState = {
                type: 'QUIZ_SESSION',
                queue: wordsToReview.map(w => w.id),
                current: wordsToReview[0].id,
                correct: 0,
                wrong: 0,
                total: wordsToReview.length
            };

            await prisma.user.update({
                where: { id: telegramId },
                data: { botState: JSON.stringify(sessionState) }
            });

            return ctx.reply(`🧠 Начинаем тренировку!\nСлов в очереди: <b>${wordsToReview.length}</b>.\n\nКак будет по-немецки: <b>${wordsToReview[0].translation}</b>?`, {
                parse_mode: 'HTML',
                ...Markup.keyboard([['❌ Завершить тренировку']]).resize()
            });
        }

        // 4. КНОПКА: МОЙ СЛОВАРЬ
        if (text === '📜 Мой словарь') {
            // Достаем все слова с переводом, сортируем по дате добавления (новые внизу)
            const words = await prisma.vocabulary.findMany({
                where: { userId: telegramId, translation: { not: null } },
                orderBy: { id: 'asc' }
            });

            if (words.length === 0) {
                return ctx.reply("Твой словарь пока пуст. Нажми «📘 Добавить слова», чтобы это исправить!", mainMenu);
            }

            let responseText = "📚 <b>Твой словарь:</b>\n\n";

            words.forEach((w, index) => {
                const progress = '🟢'.repeat(w.score) + '⚪'.repeat(5 - w.score);
                responseText += `${index + 1}. 🇩🇪 <b>${w.wordOrRule}</b> — 🇷🇺 ${w.translation} <i>[${progress}]</i>\n`;
            });

            // Подсказка по командам
            responseText += `\n<i>💡 Чтобы удалить слово, напиши <b>/del номер</b> (например, /del 1).\nОчистить весь словарь: <b>/clear_dict</b></i>`;

            // Защита от лимита Telegram (4096 символов). Разбиваем текст на части.
            const maxLength = 3900;
            if (responseText.length > maxLength) {
                // Режем текст на куски так, чтобы не обрывать на середине слова
                const chunks = responseText.match(new RegExp(`[\\s\\S]{1,${maxLength}}`, 'g')) || [];
                for (const chunk of chunks) {
                    await ctx.reply(chunk, { parse_mode: 'HTML', ...mainMenu });
                }
                return;
            }

            return ctx.reply(responseText, { parse_mode: 'HTML', ...mainMenu });
        }

        // --- КНОПКА: СМЕНИТЬ СОБЕСЕДНИКА ---
        if (text === '🔄 Сменить собеседника') {
            await ctx.reply("🔄 Собираю вещи... Ищу тебе нового собеседника в Германии 🚄");

            // 1. Полностью чистим историю переписки
            await prisma.message.deleteMany({ where: { userId: telegramId } });

            // 2. Чистим отловленные ошибки грамматики. 
            // Словарь остается, так как у обычных слов есть поле translation.
            await prisma.vocabulary.deleteMany({
                where: {
                    userId: telegramId,
                    translation: null
                }
            });

            // 3. Удаляем старую анкету (Persona)
            await prisma.persona.deleteMany({ where: { userId: telegramId } });

            // 4. Генерируем нового персонажа через LLM
            try {
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    response_format: { type: "json_object" }, // <-- ЗАСТАВЛЯЕМ ВЕРНУТЬ ЧИСТЫЙ JSON
                    messages: [{
                        role: "system",
                        content: 'Сгенерируй случайного жителя Германии (желательно из Баварии и девушку). Верни СТРОГО валидный JSON: {"name": "Имя", "age": 30, "city": "Город", "profession": "Профессия", "hobbies": ["Хобби 1", "Хобби 2"], "communicationStyle": "Стиль общения (например: веселый, строгий, саркастичный)"}'
                    }]
                });

                // Получаем текст ответа
                let rawContent = completion.choices[0]?.message?.content || '{}';

                // Срезаем Markdown-оформление (```json и ```), если модель вдруг его добавила
                rawContent = rawContent.replace(/```json/gi, '').replace(/```/gi, '').trim();

                const personaData = JSON.parse(rawContent);

                // 5. Сохраняем новую персону в базу, используя правильные поля
                const newPersona = await prisma.persona.create({
                    data: {
                        userId: telegramId,
                        name: personaData.name || 'Hans',
                        age: personaData.age || 35,
                        city: personaData.city || 'München',
                        profession: personaData.profession || 'Ingenieur',
                        hobbies: Array.isArray(personaData.hobbies) ? personaData.hobbies : ['Bier', 'Fußball'],
                        communicationStyle: personaData.communicationStyle || 'freundlich'
                    }
                });

                return ctx.reply(
                    `🎉 Твой новый собеседник на связи!\n\n` +
                    `🗣 <b>Имя:</b> ${newPersona.name} (${newPersona.age} лет)\n` +
                    `💼 <b>Профессия:</b> ${newPersona.profession}\n` +
                    `🏙 <b>Город:</b> ${newPersona.city}\n` +
                    `🎯 <b>Хобби:</b> ${newPersona.hobbies.join(', ')}\n` +
                    `🎭 <b>Характер:</b> ${newPersona.communicationStyle}\n\n` +
                    `Напиши <i>"Hallo"</i>, чтобы познакомиться! История переписки очищена.`,
                    { parse_mode: 'HTML', reply_markup: mainMenu.reply_markup }
                );

            } catch (error) {
                console.error("Ошибка при смене собеседника:", error);
                return ctx.reply("Произошла ошибка при поиске нового собеседника. Попробуй еще раз.");
            }
        }

        // --- КНОПКА: ПОМОЩЬ ---
        if (text === '🆘 Помощь') {
            const helpText = `
🛠 <b>Доступные команды:</b>

📚 <b>Словарь и Грамматика</b>
/del [номер] — Удалить слово из словаря по его номеру (например: <i>/del 5</i>)
/clear_dict — Полностью очистить словарь
/fixdb — Починить сломанные или зависшие слова в словаре

🧠 <b>Память и Настройки</b>
/profile — Посмотреть, что бот запомнил о тебе (имя, хобби, факты)
/clear_profile — Стереть всю информацию о себе из памяти бота

<i>Ты всегда можешь вызвать это меню командой /help</i>
      `;
            return ctx.reply(helpText, { parse_mode: 'HTML' });
        }



        // 5. РЕЖИМ ОЖИДАНИЯ СЛОВ
        if (user.botState === 'WAITING_WORDS') {
            await ctx.sendChatAction('typing');
            const addedWords = await processNewWords(telegramId, text);

            // Возвращаем состояние в обычный режим
            await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });

            if (addedWords.length > 0) {
                return ctx.reply(`✅ Добавлено в словарь:\n\n${addedWords.join('\n')}\n\nБуду периодически спрашивать их перевод!`, Markup.keyboard([['📘 Добавить слова']]).resize());
            } else {
                return ctx.reply("Не нашел новых слов для добавления (возможно, они уже есть в словаре).", Markup.keyboard([['📘 Добавить слова']]).resize());
            }
        }

        // 6. РЕЖИМ КВИЗА (ЭКЗАМЕН)
        if (user.botState.includes('QUIZ_SESSION')) {
            await ctx.sendChatAction('typing');

            // Читаем текущее состояние сессии
            const session = JSON.parse(user.botState);
            const wordId = session.current;

            // Проверяем ответ через LLM (функция checkWordQuiz делает всё как раньше)
            const result = await checkWordQuiz(telegramId, wordId, text);

            if (result.isTypo) {
                // Если опечатка — даем второй шанс, не меняем состояние сессии
                return ctx.reply(result.feedback, Markup.keyboard([['❌ Завершить тренировку']]).resize());
            }

            // Если ответ точный или совсем неверный, обновляем статистику
            if (result.feedback.includes("wrong") || result.newState === 'IDLE') {
                // Небольшой хак: checkWordQuiz возвращает IDLE при correct и wrong. 
                // Мы сами посчитаем статистику, просто опираясь на внутреннюю логику.
                // Но для надежности лучше доверять базе (score): если он стал 0, значит ответил неверно.
                const updatedWord = await prisma.vocabulary.findUnique({ where: { id: wordId } });
                if (updatedWord && updatedWord.score > 0) {
                    session.correct += 1;
                } else {
                    session.wrong += 1;
                }
            }

            // Убираем проверенное слово из очереди
            session.queue = session.queue.filter((id: number) => id !== wordId);

            // Проверяем, остались ли еще слова
            if (session.queue.length > 0) {
                // Берем следующее слово
                session.current = session.queue[0];

                // Сохраняем обновленную сессию
                await prisma.user.update({
                    where: { id: telegramId },
                    data: { botState: JSON.stringify(session) }
                });

                // Достаем текст следующего слова
                const nextWord = await prisma.vocabulary.findUnique({ where: { id: session.current } });

                return ctx.reply(`${result.feedback}\n\nСледующее слово (${session.total - session.queue.length + 1}/${session.total}):\nКак будет по-немецки: <b>${nextWord?.translation}</b>?`, {
                    parse_mode: 'HTML',
                    ...Markup.keyboard([['❌ Завершить тренировку']]).resize()
                });
            } else {
                // Очередь пуста! Выдаем отчет и возвращаем IDLE
                await prisma.user.update({ where: { id: telegramId }, data: { botState: 'IDLE' } });

                const report = `🏁 <b>Тренировка завершена!</b>\n\n` +
                    `✅ Правильно: <b>${session.correct}</b>\n` +
                    `❌ Ошибок: <b>${session.wrong}</b>\n\n` +
                    `Возвращаемся к обычному общению.`;

                return ctx.reply(`${result.feedback}\n\n${report}`, { parse_mode: 'HTML', ...mainMenu });
            }
        }

        // 7. ОБЫЧНЫЙ ДИАЛОГ -> ОТПРАВЛЯЕМ ДИСПЕТЧЕРУ
        await prisma.message.create({ data: { userId: telegramId, sender: 'USER', content: text } });

        // Запускаем Профайлер в фоне (без await, чтобы не тормозить бота!)
        analyzeUserProfile(telegramId, text).catch(console.error);        // --- ОТМЕНЯЕМ ПИНГ ---
        // Если мы ждали пользователя 10 минут, а он пришел сам на 5-й минуте,
        // мы должны отменить напоминание, чтобы не выглядеть глупо.
        const pingJobId = `ping-${telegramId}`;
        const pingJob = await messageQueue.getJob(pingJobId);
        if (pingJob) {
            await pingJob.remove();
            console.log(`[Debounce] Пользователь вернулся сам. Напоминание отменено.`);
        }

        // --- СТАВИМ новый таймер (Накопитель/Debounce) ---
        const jobId = `reply-${telegramId}`;
        const oldJob = await messageQueue.getJob(jobId);
        if (oldJob) await oldJob.remove();

        await messageQueue.add('process-inbox', {
            type: 'process-inbox',
            userId: telegramId.toString()
        }, {
            delay: 5000, // Ждем 5 секунд (или 5000, если хочешь 5 секунд)
            jobId: jobId
        });

        // --- ТРИГГЕР УЧИТЕЛЯ ---
        const userMsgCount = await prisma.message.count({ where: { userId: telegramId, sender: 'USER' } });
        if (userMsgCount % 5 === 0) {
            analyzeMistakes(telegramId).catch(console.error);
        }

    });
}