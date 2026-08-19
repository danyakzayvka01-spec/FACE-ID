const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

if (!token) {
  console.error('Не задан TELEGRAM_BOT_TOKEN. Запустите скрипт с --env-file=.env');
  process.exitCode = 1;
} else {
  const call = async (method) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.description || `HTTP ${response.status}`);
    return payload.result;
  };

  try {
    const bot = await call('getMe');
    const updates = await call('getUpdates?limit=100&timeout=0');
    const chats = new Map();
    for (const update of updates) {
      const chat = update.message?.chat || update.channel_post?.chat || update.my_chat_member?.chat || update.chat_member?.chat;
      if (chat) chats.set(String(chat.id), chat);
    }

    console.log(`Бот: @${bot.username}`);
    if (!chats.size) {
      console.log(`Чаты пока не найдены. Добавьте @${bot.username} в группу, отправьте там /start@${bot.username} и запустите скрипт ещё раз.`);
    } else {
      console.log('Найденные чаты:');
      for (const chat of chats.values()) {
        console.log(`${chat.id}\t${chat.title || chat.username || chat.first_name || 'Без названия'}\t${chat.type}`);
      }
    }
  } catch (error) {
    console.error(`Ошибка Telegram: ${error.message}`);
    process.exitCode = 1;
  }
}
