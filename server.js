const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Исправленный импорт fetch
const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

const ROOT = process.cwd();

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

const API_URL = process.env.API_URL || 'https://api.proxyapi.ru/openai/v1/chat/completions';
const API_KEY = process.env.API_KEY;

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(payload));
}

async function callLLM(messages) {
    if (!API_KEY) throw new Error('API_KEY is missing in Environment Variables');
    
    const proxyFetch = async (auth) => {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': auth
            },
            body: JSON.stringify({ model: 'gpt-3.5-turbo', messages })
        });
        return { status: response.status, data: await response.json() };
    };

    let res = await proxyFetch(`Bearer ${API_KEY}`);
    if (res.status === 401) res = await proxyFetch(API_KEY);
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

    // API Routes
    if (url.pathname === '/api' || url.pathname === '/product-evaluate') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                let messages = parsed.messages || [];
                
                if (url.pathname === '/product-evaluate') {
                    messages = [
                        { role: 'system', content: 'Ты эксперт по анализу товаров.' },
                        { role: 'user', content: `Проанализируй товар: ${parsed.productUrl}` }
                    ];
                }

                const result = await callLLM(messages);
                sendJson(res, result.status, result.data);
            } catch (err) {
                sendJson(res, 500, { error: { message: err.message } });
            }
        });
        return;
    }

    // Static Files
    let relativePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(ROOT, relativePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    } else {
        const index = path.join(ROOT, 'index.html');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        fs.createReadStream(index).pipe(res);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

module.exports = server;
