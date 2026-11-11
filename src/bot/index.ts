require('dotenv').config();
import { Telegraf } from 'telegraf';
import { setupCommands } from './commands';
import { setupMessageHandlers } from './messages';

// Создаем инстанс бота
export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// Подключаем функционал
setupCommands(bot);
setupMessageHandlers(bot);

// Добавляем глобальную обработку ошибок (чтобы бот не падал)
bot.catch((err, ctx) => {
    console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
});