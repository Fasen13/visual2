const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Используем встроенный fetch в Node.js 18+ или полифил
const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

const ROOT = process.cwd();
const configPath = path.join(ROOT, 'config.json');

let config = {};
try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (err) {
    console.error('Config read error:', err.message);
}

const PORT = process.env.PORT || config.port || 3000;
const API_URL = process.env.API_URL || config.apiUrl || 'https://api.proxyapi.ru/openai/v1/chat/completions';
const API_KEY = process.env.API_KEY || config.apiKey;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
};

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(payload));
}

function resolveStaticPath(urlPath) {
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(process.cwd(), safePath === path.sep ? 'index.html' : safePath);
    return filePath;
}

async function callLLM(messages) {
    if (!API_KEY) throw new Error('API_KEY is missing');
    
    const proxyFetch = async (auth) => {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': auth
            },
            body: JSON.stringify({ model: 'gpt-3.5-turbo', messages })
        });
        const data = await response.json();
        return { status: response.status, data };
    };

    let res = await proxyFetch(`Bearer ${API_KEY}`);
    if (res.status === 401) {
        res = await proxyFetch(API_KEY);
    }
    return res;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (url.pathname === '/api' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const result = await callLLM(parsed.messages || []);
                sendJson(res, result.status, result.data);
            } catch (err) {
                sendJson(res, 500, { error: { message: err.message } });
            }
        });
        return;
    }

    if (url.pathname === '/product-evaluate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const productUrl = parsed.productUrl;
                const result = await callLLM([
                    { role: 'system', content: 'Ты эксперт по анализу товаров.' },
                    { role: 'user', content: `Товар: ${productUrl}` }
                ]);
                sendJson(res, result.status, result.data);
            } catch (err) {
                sendJson(res, 500, { error: { message: err.message } });
            }
        });
        return;
    }

    const filePath = resolveStaticPath(url.pathname);
    console.log(`Request: ${url.pathname} -> ${filePath}`);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache' 
        });
        fs.createReadStream(filePath).pipe(res);
    } else {
        const index = path.join(process.cwd(), 'index.html');
        if (fs.existsSync(index)) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            fs.createReadStream(index).pipe(res);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
});

const PORT_TO_LISTEN = process.env.PORT || 3000;
server.listen(PORT_TO_LISTEN, () => {
    console.log(`Server running on port ${PORT_TO_LISTEN}`);
});


function isAllowedProductUrl(productUrl) {
    try {
        const u = new URL(productUrl);
        if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'bad_protocol' };

        const hostname = u.hostname.toLowerCase();
        if (!ALLOWED_PRODUCT_HOSTS.has(hostname)) return { ok: false, reason: 'host_not_allowed' };

        // Блокируем localhost/внутренние сети.
        if (net.isIP(hostname)) {
            return { ok: false, reason: 'ip_not_allowed' };
        }
        return { ok: true };
    } catch {
        return { ok: false, reason: 'bad_url' };
    }
}

function findFirstProductJsonLd(node) {
    const seen = new Set();
    const walk = (obj) => {
        if (!obj) return null;
        if (typeof obj !== 'object') return null;
        if (seen.has(obj)) return null;
        seen.add(obj);

        const t = obj['@type'];
        const types = Array.isArray(t) ? t : (typeof t === 'string' ? [t] : []);
        if (types.some(x => typeof x === 'string' && x.toLowerCase() === 'product')) {
            return obj;
        }

        if (Array.isArray(obj)) {
            for (const it of obj) {
                const r = walk(it);
                if (r) return r;
            }
        } else {
            for (const k of Object.keys(obj)) {
                const r = walk(obj[k]);
                if (r) return r;
            }
        }
        return null;
    };
    return walk(node);
}

function pickArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

async function scrapeProductData(productUrl) {
    // Вместо реального скрейпинга (который требует Chromium), 
    // мы передаем ссылку нейросети, чтобы она проанализировала её на основе своих знаний.
    return {
        ok: true,
        extracted: {
            name: "Товар по ссылке",
            brand: "Определяется...",
            description: "Анализ содержимого через AI...",
            price: "Уточняется",
            ratingValue: "4.5", // Заглушка для логики
            reviewCount: "10",
            reviewSnippets: ["Нейросеть анализирует общее мнение о товаре по этой ссылке..."]
        }
    };
}
const server = http.createServer((req, res) => {    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (url.pathname === '/api' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                // Т.к. /api пока используется старым клиентом, проксируем “как есть”,
                // но с авто-попыткой формата Authorization.
                const parsed = JSON.parse(body || '{}');
                const messages = parsed.messages || [];
                const model = parsed.model || 'gpt-3.5-turbo';

                const llmRes = await (async () => {
                    const proxyFetch = async (authorizationHeaderValue) => {
                        const response = await fetch(API_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': authorizationHeaderValue
                            },
                            body: JSON.stringify({ model, messages })
                        });
                        const data = await response.text();
                        return { status: response.status, data };
                    };

                    const first = await proxyFetch(`Bearer ${API_KEY}`);
                    const result = first.status === 401
                        ? await proxyFetch(API_KEY)
                        : first;
                    return { status: result.status, data: JSON.parse(result.data) };
                })();

                res.writeHead(llmRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(llmRes.data));
            } catch (err) {
                sendJson(res, 502, { error: { message: 'Ошибка прокси: ' + err.message } });
            }
        });
        return;
    }

    if (url.pathname === '/product-evaluate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const productUrl = String(parsed.productUrl || '').trim();
                const manualInfo = String(parsed.manualInfo || '').trim();
                const mode = String(parsed.mode || 'by_link');

                if (!productUrl) {
                    sendJson(res, 400, { error: { message: 'productUrl обязателен' } });
                    return;
                }

                if (mode === 'by_link') {
                    const allowed = isAllowedProductUrl(productUrl);
                    if (!allowed.ok) {
                        sendJson(res, 400, { error: { message: 'URL не разрешен: ' + allowed.reason } });
                        return;
                    }

                    const scraped = await scrapeProductData(productUrl);
                    const ex = scraped.extracted;
                    const system = [
                        'Ты эксперт по техническому анализу товаров. Твоя база знаний содержит данные о миллионах устройств.',
                        'Тебе прислали ССЫЛКУ на товар. Твоя задача — по тексту ссылки понять, что это за товар, и использовать свои знания о нем.',
                        'КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать "уточняется" или "не указано". Если ты узнал модель — пиши всё, что о ней знаешь.',
                        'ВАЖНО: Начни свой ответ строго со строки в формате: [NAME: Краткое название товара]',
                        'Затем предоставь подробный отчет:',
                        '1. ТЕХНИЧЕСКИЕ ХАРАКТЕРИСТИКИ: Опиши всё (процессор, материалы, экран, сенсоры и т.д.).',
                        '2. СРАВНЕНИЕ: Сравни с 2 конкретными конкурентами (назови их модели).',
                        '3. ПЛЮСЫ И МИНУСЫ: На основе технических данных.',
                        '4. ВЕРДИКТ: Стоит ли брать.',
                        'Ответ дай на русском языке, максимально подробно.'
                    ].join('\n');
                    const llm = await callLLM([
                        { role: 'system', content: system },
                        { role: 'user', content: `Проанализируй товар. Ссылка: ${productUrl}. Подсказка по названию: ${manualInfo || 'не указана, определи по ссылке'}` }
                    ]);

                    const report = llm.json?.choices?.[0]?.message?.content || 'Готово.';
                    sendJson(res, 200, {
                        ok: true,
                        report,
                        extracted: ex
                    });
                    return;                }

                if (mode === 'by_manual') {
                    if (!manualInfo) {
                        sendJson(res, 400, { error: { message: 'manualInfo обязателен в mode=by_manual' } });
                        return;
                    }

                    const system = [
                        'Ты эксперт по оценке товаров.',
                        'Пользователь предоставил данные (название/характеристики/описание и при наличии рейтинг/отзывы).',
                        'Сделай оценку и рекомендации так же, как если бы данные были извлечены с карточки.',
                        'Если данных недостаточно — скажи, что нужно уточнить.'
                    ].join('\\n');

                    const llm = await callLLM([
                        { role: 'system', content: system },
                        {
                            role: 'user',
                            content: JSON.stringify({ productUrl, manualInfo }, null, 2)
                        }
                    ]);

                    const report = llm.json?.choices?.[0]?.message?.content || 'Готово.';
                    sendJson(res, 200, { ok: true, report });
                    return;
                }

                sendJson(res, 400, { error: { message: 'Неверный mode' } });
            } catch (err) {
                sendJson(res, 500, { error: { message: err.message } });
            }
        });
        return;
    }

    const filePath = resolveStaticPath(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain; charset=utf-8' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен!`);
    console.log(`Локально: http://localhost:${PORT}`);
    
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`С других устройств: http://${net.address}:${PORT}`);
            }
        }
    }
});
