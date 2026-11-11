import { Telegraf } from 'telegraf';
import prisma from '../database';
import { mainMenu } from './keyboards';
import { fixBrokenWords } from '../agents/dictionary';
import { generatePersona } from '../agents/persona';
import { planDay } from '../agents/planner';
// Импортируй тут другие нужные функции, например генерацию Persona, если она была в /start

export function setupCommands(bot: Telegraf) {

    // Команда /start
    bot.start(async (ctx) => {
        const telegramId = ctx.from.id;
        const username = ctx.from.username || null;
        const firstName = ctx.from.first_name || '';

        try {
            let user = await prisma.user.findUnique({
                where: { id: BigInt(telegramId) },
                include: { persona: true }
            });

            if (user && user.persona) {
                return ctx.reply(`Привет! Мы же уже знакомы, я ${user.persona.name} из ${user.persona.city}. Как дела? 😉`, mainMenu);
            }

            ctx.reply("Привет! Дай мне секундочку, я настраиваюсь на твою волну... ⚙️");

            if (!user) {
                user = await prisma.user.create({
                    data: {
                        id: BigInt(telegramId),
                        username: username,
                        firstName: firstName,
                    },
                    include: { persona: true }
                });
            }

            const newPersonaData = await generatePersona();

            const savedPersona = await prisma.persona.create({
                data: {
                    userId: user.id,
                    name: newPersonaData.name,
                    age: newPersonaData.age,
                    profession: newPersonaData.profession,
                    city: newPersonaData.city,
                    hobbies: newPersonaData.hobbies,
                    communicationStyle: newPersonaData.communicationStyle,
                }
            });

            await ctx.reply(
                `Всё готово! 🎉\n\nПривет, меня зовут ${savedPersona.name}...\n\nДавай общаться!`,
                mainMenu
            );

        } catch (error) {
            console.error("Ошибка при обработке /start:", error);
            ctx.reply("Ой, что-то пошло не так. Попробуй еще раз чуть позже.");
        }
    });


    // Команда /fixdb
    // команда для починки сломанных слов в словаре
    bot.command('fixdb', async (ctx) => {
        const telegramId = BigInt(ctx.from.id);

        const msg = await ctx.reply("🛠 Ищу сломанные слова в базе...");

        try {
            const fixedCount = await fixBrokenWords(telegramId);

            if (fixedCount === 0) {
                return ctx.reply("Всё чисто! Сломанных слов не найдено. ✅");
            }

            return ctx.reply(`Ремонт завершен! Успешно восстановлен перевод для ${fixedCount} слов. 🔧`);
        } catch (error) {
            console.error("Ошибка при починке БД:", error);
            ctx.reply("Упс, произошла ошибка при починке.");
        }
    });

    // Команда /del
    bot.command('del', async (ctx) => {
        const telegramId = BigInt(ctx.from.id);
        const args = ctx.message.text.split(' ');

        if (args.length < 2) {
            return ctx.reply("Напиши команду и номер слова из списка. Например: /del 5");
        }

        const num = parseInt(args[1]);
        if (isNaN(num) || num < 1) {
            return ctx.reply("Укажи правильный номер слова.");
        }

        // Получаем список в том же порядке, в каком он выводится в "Моем словаре"
        const words = await prisma.vocabulary.findMany({
            where: { userId: telegramId, translation: { not: null } },
            orderBy: { id: 'asc' }
        });

        if (num > words.length) {
            return ctx.reply(`В словаре нет такого номера. Всего слов: ${words.length}.`);
        }

        // Находим нужное слово (индекс в массиве на 1 меньше номера)
        const wordToDelete = words[num - 1];

        await prisma.vocabulary.delete({ where: { id: wordToDelete.id } });

        return ctx.reply(`🗑 Слово <b>${wordToDelete.wordOrRule}</b> успешно удалено!`, { parse_mode: 'HTML' });
    });

    // Команда /clear_dict
    bot.command('clear_dict', async (ctx) => {
        const telegramId = BigInt(ctx.from.id);

        // Удаляем только словарные слова (не трогаем грамматические правила от Teacher)
        const deleted = await prisma.vocabulary.deleteMany({
            where: {
                userId: telegramId,
                translation: { not: null }
            }
        });

        return ctx.reply(`🌪 Словарь полностью очищен! Удалено слов: ${deleted.count}.`, mainMenu);
    });

    // команда для запуска экзамена вручную
    bot.command('quiz', async (ctx) => {
        const telegramId = BigInt(ctx.from.id);

        // Ищем 1 слово, которое пора повторять (и у которого ЕСТЬ перевод)
        const wordToReview = await prisma.vocabulary.findFirst({
            where: {
                userId: telegramId,
                nextReview: { lte: new Date() },
                translation: { not: null } // <-- ИСПРАВЛЕНИЕ: игнорируем грамматику от Учителя
            },
            orderBy: { nextReview: 'asc' }
        });

        if (!wordToReview) {
            return ctx.reply("Пока нет слов для повторения! Можешь отдыхать ☕");
        }

        // Переводим бота в режим проверки конкретного слова
        await prisma.user.update({
            where: { id: telegramId },
            data: { botState: `QUIZ_${wordToReview.id}` }
        });

        ctx.reply(`🧠 Время проверки!\nКак будет по-немецки: <b>${wordToReview.translation}</b>?`, { parse_mode: 'HTML' });
    });

    // Секретная команда для запуска Планировщика вручную
    bot.command('plan', async (ctx) => {
        const telegramId = BigInt(ctx.from.id);
        ctx.reply("Запускаю генерацию расписания... ⏳");
        await planDay(telegramId);
        ctx.reply("Расписание создано! Жди сообщений от бота в ближайшие пару минут. 😉");
    });

    // ПРОСМОТР ДОСЬЕ
    bot.command('profile', async (ctx) => {
        const user = await prisma.user.findUnique({ where: { id: BigInt(ctx.from.id) } });
        if (!user) return;

        const name = user.realName || 'Не задано';
        const interests = user.interests.length > 0 ? user.interests.join(', ') : 'Пусто';
        const about = user.about || 'Пусто';

        return ctx.reply(
            `🗂 <b>Досье, которое собрал бот:</b>\n\n` +
            `🗣 Имя: ${name}\n` +
            `🎯 Интересы: ${interests}\n` +
            `📝 О себе: ${about}\n\n` +
            `<i>Чтобы очистить память, напиши /clear_profile</i>`,
            { parse_mode: 'HTML' }
        );
    });

    // ОЧИСТКА ДОСЬЕ
    bot.command('clear_profile', async (ctx) => {
        await prisma.user.update({
            where: { id: BigInt(ctx.from.id) },
            data: { realName: null, interests: [], about: null }
        });
        return ctx.reply("🌪 Память очищена! Бот забыл всё о тебе.");
    });

    // --- КОМАНДА: ПОМОЩЬ ---
    bot.command('help', async (ctx) => {
        const helpText = `
🛠 <b>Доступные команды:</b>

📚 <b>Словарь и Грамматика</b>
/del [номер] — Удалить слово из словаря по его номеру (например: <i>/del 5</i>)
/clear_dict — Полностью очистить словарь
/fixdb — Починить сломанные или зависшие слова в словаре

🧠 <b>Память и Настройки</b>
/profile — Посмотреть, что бот запомнил о тебе (имя, хобби, факты)
/clear_profile — Стереть всю информацию о себе из памяти бота

<i>Также ты можешь воспользоваться кнопками в меню ниже!</i>
    `;

        return ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: mainMenu.reply_markup });
    });




}