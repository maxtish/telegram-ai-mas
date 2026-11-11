
import { bot } from './bot'; // Импортируем готового бота
import './workers/scheduler'; // Подключаем и запускаем воркер

async function startApp() {
  try {
    console.log('🚀 Запуск Multi-Agent Telegram Bot...');

    // Запускаем бота
    bot.launch();
    console.log('✅ Бот успешно подключен к Telegram и ждет сообщений!');

    // Корректная остановка при выключении сервера (Ctrl+C или PM2 stop)
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

  } catch (error) {
    console.error('❌ Ошибка при запуске приложения:', error);
  }
}

startApp();