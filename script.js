const UI = {
    container: document.getElementById('chat-container'),
    scroller: document.getElementById('chat-scroller'),
    input: document.getElementById('userInput'),
    welcome: document.getElementById('welcome-screen'),
    history: document.getElementById('historyList'),
    overlay: document.getElementById('overlay'),
    productOverlay: document.getElementById('productOverlay'),
    productUrl: document.getElementById('productUrl'),
    productNameHint: document.getElementById('productNameHint'),
    manualInfo: document.getElementById('manualInfo'),
    productStatus: document.getElementById('productStatus'),
    manualEvaluateBtn: document.getElementById('manualEvaluateBtn')
};

const IS_FILE_PROTOCOL = window.location.protocol === 'file:';
const USE_LOCAL_PROXY = window.location.protocol === 'http:' || window.location.protocol === 'https:';

const CONFIG = {
    URL: USE_LOCAL_PROXY ? '/api' : null
};

let chatsData = JSON.parse(localStorage.getItem('vision_v6')) || {};
let currentChatId = null;

window.onload = () => {
    Object.keys(chatsData).reverse().forEach(id => renderChatItem(id, chatsData[id].name));
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
        updateThemeUI(true);
    }
    if (IS_FILE_PROTOCOL) showFileProtocolWarning();
};

function showFileProtocolWarning() {
    const banner = document.createElement('div');
    banner.className = 'file-warning';
    banner.innerHTML = `
        <strong>API недоступен при открытии файла напрямую.</strong>
        Запустите <code>start.bat</code> в папке проекта — сервер откроется автоматически.
    `;
    document.body.prepend(banner);
    UI.input.disabled = true;
    UI.input.placeholder = 'Запустите start.bat для работы с API...';
}

function openProductPanel() {
    UI.productOverlay.style.display = 'flex';
    UI.productStatus.innerText = '';
    UI.manualEvaluateBtn.style.display = 'none';
    UI.manualEvaluateBtn.disabled = false;
    if (UI.manualInfo) UI.manualInfo.style.display = 'none';
}

function closeProductPanel() {
    UI.productOverlay.style.display = 'none';
    if (UI.manualInfo) UI.manualInfo.style.display = 'none';
}

function ensureChatExists(titlePrefix) {
    if (currentChatId) return currentChatId;
    const id = 'chat_' + Date.now();
    chatsData[id] = { name: (titlePrefix || 'Проект').slice(0, 20), messages: [] };
    renderChatItem(id, chatsData[id].name);
    selectChat(id);
    return id;
}

async function productEvaluate({ productUrl, manualInfo, mode }) {
    if (!USE_LOCAL_PROXY) {
        throw new Error('Запустите start.bat — без сервера API недоступен из-за ограничений браузера.');
    }

    const res = await fetch('/product-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productUrl, manualInfo, mode })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
        const msg = data.error?.message || data.error || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    return data;
}

async function evaluateByLink() {
    const productUrl = (UI.productUrl?.value || '').trim();
    const nameHint = (UI.productNameHint?.value || '').trim();
    if (!productUrl) return alert('Введите ссылку на товар.');

    const chatId = ensureChatExists(nameHint || 'Товар');
    const botDiv = appendMessage('Анализирую технические характеристики...', 'bot');
    UI.productStatus.innerText = '';
    UI.manualEvaluateBtn.style.display = 'none';

    try {
        // Передаем подсказку о названии в manualInfo, чтобы сервер её увидел
        const result = await productEvaluate({ productUrl, manualInfo: nameHint, mode: 'by_link' });

        if (result.ok === true) {
            let report = result.report || 'Готово.';
            
            // Извлекаем название из тега [NAME: ...]
            const nameMatch = report.match(/\[NAME:\s*(.*?)\]/);
            if (nameMatch && nameMatch[1]) {
                const productName = nameMatch[1].trim();
                chatsData[chatId].name = productName.slice(0, 30);
                const historyItem = document.getElementById(chatId);
                if (historyItem) {
                    const span = historyItem.querySelector('span');
                    if (span) span.innerText = '◈ ' + chatsData[chatId].name;
                }
                // Убираем технический тег из текста сообщения
                report = report.replace(/\[NAME:.*?\]/, '').trim();
            }

            botDiv.innerText = report;
            chatsData[chatId].messages.push({ role: 'assistant', content: report });
            save();
            UI.productStatus.innerText = 'Готово.';
            closeProductPanel();
            return;
        }

        if (result.ok === false && result.reason === 'scrape_failed') {
            botDiv.innerText = 'Не получилось извлечь рейтинг/отзывы. Можно оценить по ручным данным ниже.';
            UI.productStatus.innerText = 'Заполните “ручные данные” и нажмите “Оценить по ручным данным”.';
            UI.manualEvaluateBtn.style.display = 'inline-block';
            if (UI.manualInfo) UI.manualInfo.style.display = 'block';
            return;
        }

        botDiv.innerText = 'Ошибка: ' + (result.reason || 'Неизвестная причина');
        UI.productStatus.innerText = 'Ошибка.';
    } catch (e) {
        botDiv.innerText = 'Ошибка: ' + e.message;
        UI.productStatus.innerText = 'Ошибка.';
    }
}

async function evaluateByManual() {
    const productUrl = (UI.productUrl?.value || '').trim();
    const manualInfo = (UI.manualInfo?.value || '').trim();

    if (!productUrl) return alert('Введите ссылку на товар.');
    if (!manualInfo) return alert('Введите ручные данные (название/характеристики/описание + при наличии рейтинг/отзывы).');

    const chatId = ensureChatExists('Товар');
    const botDiv = appendMessage('Оцениваю по ручным данным...', 'bot');

    try {
        const result = await productEvaluate({ productUrl, manualInfo, mode: 'by_manual' });

        if (result.ok === true) {
            const report = result.report || 'Готово.';
            botDiv.innerText = report;
            chatsData[chatId].messages.push({ role: 'assistant', content: report });
            save();
            UI.productStatus.innerText = 'Готово.';
            closeProductPanel();
            return;
        }

        botDiv.innerText = 'Ошибка: ' + (result.reason || 'Неизвестная причина');
        UI.productStatus.innerText = 'Ошибка.';
    } catch (e) {
        botDiv.innerText = 'Ошибка: ' + e.message;
        UI.productStatus.innerText = 'Ошибка.';
    }
}

async function callApi(messages) {
    if (!USE_LOCAL_PROXY) {
        throw new Error('Запустите start.bat — без сервера API недоступен из-за ограничений браузера.');
    }

    const res = await fetch(CONFIG.URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', messages })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
        const msg = data.error?.message || data.error || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    if (!data.choices?.[0]?.message?.content) {
        throw new Error('Пустой ответ от API');
    }

    return data.choices[0].message.content;
}

async function analyzeSentiment() {
    if (!currentChatId || chatsData[currentChatId].messages.length === 0) {
        return alert('Сначала введите текст отзыва или выберите проект с данными.');
    }

    const botDiv = appendMessage('Провожу глубокий анализ тональности...', 'bot');

    const historyText = chatsData[currentChatId].messages
        .map(m => `${m.role === 'user' ? 'Отзыв' : 'Ответ'}: ${m.content}`)
        .join('\n');

    try {
        const reply = await callApi([
            {
                role: 'system',
                content: 'Ты эксперт-аналитик. Проведи анализ тональности (позитивный, негативный, нейтральный) и выдели ключевые проблемы из предоставленных текстов. Ответ дай в виде краткого отчета с буллитами.'
            },
            { role: 'user', content: `Проанализируй следующие данные:\n${historyText}` }
        ]);

        botDiv.innerText = reply;
        chatsData[currentChatId].messages.push({ role: 'assistant', content: `[NLP ANALYSIS]: ${reply}` });
        save();
    } catch (e) {
        botDiv.innerText = 'Ошибка: ' + e.message;
    }
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeUI(isLight);
}

function updateThemeUI(isLight) {
    document.getElementById('theme-icon').innerText = isLight ? '🌙' : '☀️';
    document.getElementById('theme-text').innerText = isLight ? 'Темная тема' : 'Светлая тема';
}

function renderChatItem(id, name) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.id = id;
    div.innerHTML = `
        <span onclick="selectChat('${id}')" style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">◈ ${name}</span>
        <button onclick="deleteChat(event, '${id}')" style="background:none; border:none; color:var(--accent); cursor:pointer; padding:5px; opacity:0.5;">✕</button>
    `;
    UI.history.prepend(div);
}

function selectChat(id) {
    currentChatId = id;
    UI.welcome.style.display = 'none';
    UI.scroller.style.display = 'block';
    UI.container.innerHTML = '';
    chatsData[id].messages.forEach(m => appendMessage(m.content, m.role));
    document.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active', el.id === id));
    UI.scroller.scrollTop = UI.scroller.scrollHeight;
}

async function handleSend() {
    const text = UI.input.value.trim();
    if (!text) return;

    if (!currentChatId) {
        const id = 'chat_' + Date.now();
        chatsData[id] = { name: text.slice(0, 20), messages: [] };
        renderChatItem(id, chatsData[id].name);
        selectChat(id);
    }

    chatsData[currentChatId].messages.push({ role: 'user', content: text });
    appendMessage(text, 'user');
    UI.input.value = '';
    UI.input.style.height = 'auto';

    const botDiv = appendMessage('Печатает...', 'bot');

    try {
        const reply = await callApi(chatsData[currentChatId].messages.slice(-10));
        botDiv.innerText = reply;
        chatsData[currentChatId].messages.push({ role: 'assistant', content: reply });
        save();
    } catch (e) {
        botDiv.innerText = 'Ошибка: ' + e.message;
    }
}

function appendMessage(text, role) {
    const div = document.createElement('div');
    div.className = role === 'user' ? 'user-msg' : 'bot-msg';
    div.innerText = text;
    UI.container.appendChild(div);
    UI.scroller.scrollTop = UI.scroller.scrollHeight;
    return div;
}

function save() { localStorage.setItem('vision_v6', JSON.stringify(chatsData)); }
function openCreationPanel() { UI.overlay.style.display = 'flex'; }
function closePanel() { UI.overlay.style.display = 'none'; }
function saveChat() {
    const name = document.getElementById('newItemName').value || 'Проект';
    const id = 'chat_' + Date.now();
    chatsData[id] = { name, messages: [] };
    save();
    location.reload();
}
function deleteChat(e, id) {
    e.stopPropagation();
    if (confirm('Удалить проект?')) { delete chatsData[id]; save(); location.reload(); }
}

UI.input.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
UI.input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } };
