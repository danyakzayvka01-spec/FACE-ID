// ... в начале файла
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Вот где он берет свой адрес. Из переменных окружения.
const baseUrl = process.env.BASE_URL; 

// ... дальше по коду

// А вот где он его использует, чтобы собрать ссылку
const trapLink = `${baseUrl}/trap.html?id=${uniqueId}`; 

// ...