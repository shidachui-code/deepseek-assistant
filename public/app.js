// ===== 状态管理 =====
const state = {
    messages: [],
    history: [],    // {role, content} 用于 API
    sending: false,
    config: {},
    knowledge: {}
};

// ===== DOM 引用 =====
const $ = id => document.getElementById(id);
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const messagesEl = $('messages');
const welcomeEl = $('welcome');
const chatArea = $('chatArea');
const settingsBtn = $('settingsBtn');
const settingsModal = $('settingsModal');
const closeSettings = $('closeSettings');
const saveSettingsBtn = $('saveSettingsBtn');
const providerSelect = $('providerSelect');
const modelInfo = $('modelInfo');
const clearBtn = $('clearBtn');
const menuBtn = $('menuBtn');
const exportBtn = $('exportBtn');
const chatCount = $('chatCount');

// ===== 初始化 =====
async function init() {
    await loadConfig();
    await loadKnowledge();
    setupEventListeners();
    loadChatHistory();
    autoResizeInput();
}

async function loadConfig() {
    try {
        const resp = await fetch('/api/config');
        state.config = await resp.json();
        updateModelInfo();
    } catch (e) {
        modelInfo.textContent = '无法加载配置';
    }
}

async function loadKnowledge() {
    try {
        const resp = await fetch('/api/knowledge');
        state.knowledge = await resp.json();
        const stats = $('welcomeStats');
        const k = state.knowledge;
        if (k.kbChunks) {
            stats.innerHTML = `📚 ${k.kbChunks} 段知识 · ${k.kbSizeMB}MB · 已聊 ${k.totalChats} 轮`;
            $('kbInfo').textContent = `${k.kbChunks} 段`;
            if (chatCount) chatCount.textContent = k.totalChats || '-';
        }
    } catch (e) {
        console.log('知识库信息加载失败');
    }
}

function updateModelInfo() {
    const icons = { deepseek: '🧠', ollama: '💻', openai: '☁️' };
    modelInfo.textContent = `${icons[state.config.provider] || '🧠'} ${state.config.model || ''}`;
}

// ===== 事件绑定 =====
function setupEventListeners() {
    // 发送
    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    chatInput.addEventListener('input', autoResizeInput);

    // 设置
    settingsBtn.addEventListener('click', () => openSettings());
    closeSettings.addEventListener('click', () => closeSettingsModal());
    settingsModal.addEventListener('click', e => {
        if (e.target === settingsModal) closeSettingsModal();
    });
    providerSelect.addEventListener('change', toggleProviderConfig);
    saveSettingsBtn.addEventListener('click', saveSettings);
    $('toggleKeyBtn')?.addEventListener('click', toggleKeyVisibility);

    // 清空
    clearBtn.addEventListener('click', clearChat);

    // 导出数据
    exportBtn.addEventListener('click', exportData);

    // 快捷提问
    document.querySelectorAll('.tip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            chatInput.value = btn.dataset.msg;
            sendMessage();
        });
    });
}

// ===== 发送消息 =====
async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || state.sending) return;

    chatInput.value = '';
    autoResizeInput();
    hideWelcome();

    // 添加用户消息
    addMessage(text, 'user');
    state.history.push({ role: 'user', content: text });

    // 添加等待消息
    const thinkingId = addThinkingMessage();

    state.sending = true;
    sendBtn.disabled = true;
    document.body.classList.add('sending');

    try {
        const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                history: state.history.slice(-20)
            })
        });

        // 移除等待
        removeMessage(thinkingId);

        if (!resp.ok) {
            addMessage(`请求失败 (${resp.status})`, 'ai');
            state.sending = false;
            sendBtn.disabled = false;
            document.body.classList.remove('sending');
            return;
        }

        // 流式读取
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        const msgId = addMessage('', 'ai', true);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            fullContent += chunk;
            updateMessage(msgId, fullContent);
        }

        // 更新历史
        state.history.push({ role: 'assistant', content: fullContent });
        saveChatHistory();
    } catch (e) {
        removeMessage(thinkingId);
        addMessage(`网络错误: ${e.message}`, 'ai');
    }

    state.sending = false;
    sendBtn.disabled = false;
    document.body.classList.remove('sending');
    scrollToBottom();
}

// ===== DOM 操作 =====
function addMessage(content, role, isStreaming = false) {
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);

    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.id = id;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? '我' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'msg-content';

    if (isStreaming) {
        bubble.textContent = '';
    } else if (role === 'user') {
        bubble.textContent = content;
    } else {
        bubble.textContent = content;
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();

    return id;
}

function updateMessage(id, content) {
    const el = document.getElementById(id);
    if (!el) return;
    const bubble = el.querySelector('.msg-content');
    if (bubble) bubble.textContent = content;
    scrollToBottom();
}

function removeMessage(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function addThinkingMessage() {
    const id = 'thinking-' + Date.now();
    const div = document.createElement('div');
    div.className = 'message ai';
    div.id = id;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'msg-content';
    bubble.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    scrollToBottom();

    return id;
}

function hideWelcome() {
    welcomeEl.style.display = 'none';
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = !chatInput.value.trim();
}

// ===== 设置 =====
function openSettings() {
    // 填充当前配置
    providerSelect.value = state.config.provider || 'deepseek';
    toggleProviderConfig();
    settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
    settingsModal.classList.add('hidden');
}

function toggleProviderConfig() {
    const val = providerSelect.value;
    $('deepseekConfig').classList.toggle('hidden', val !== 'deepseek');
    $('ollamaConfig').classList.toggle('hidden', val !== 'ollama');
    $('openaiConfig').classList.toggle('hidden', val !== 'openai');
}

function toggleKeyVisibility() {
    const input = $('apiKeyInput');
    const btn = $('toggleKeyBtn');
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '隐藏';
    } else {
        input.type = 'password';
        btn.textContent = '显示';
    }
}

async function saveSettings() {
    const body = {};
    const provider = providerSelect.value;
    body.provider = provider;

    if (provider === 'deepseek') {
        const key = $('apiKeyInput').value.trim();
        if (key) body.apiKey = key;
        body.model = $('modelSelect').value;
    } else if (provider === 'ollama') {
        body.ollamaUrl = $('ollamaUrlInput').value.trim() || 'http://localhost:11434/api/chat';
        body.ollamaModel = $('ollamaModelInput').value.trim() || 'deepseek-r1:7b';
    } else if (provider === 'openai') {
        body.apiUrl = $('openaiUrlInput').value.trim();
        body.apiKey = $('openaiKeyInput').value.trim();
        body.model = $('openaiModelInput').value.trim();
    }

    try {
        const resp = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (resp.ok) {
            showSaveStatus('✅ 保存成功', 'success');
            await loadConfig();
        } else {
            showSaveStatus('❌ 保存失败', 'error');
        }
    } catch (e) {
        showSaveStatus('❌ 保存失败: ' + e.message, 'error');
    }
}

function showSaveStatus(msg, type) {
    const el = $('saveStatus');
    el.textContent = msg;
    el.className = 'save-status ' + type;
    setTimeout(() => { el.textContent = ''; }, 3000);
}

// ===== 清空 & 历史 =====
function clearChat() {
    if (!confirm('确定清空当前对话？')) return;
    state.history = [];
    messagesEl.innerHTML = '';
    welcomeEl.style.display = 'block';
    localStorage.removeItem('chat_history');
}

function saveChatHistory() {
    try {
        localStorage.setItem('chat_history', JSON.stringify(state.history.slice(-50)));
    } catch {}
}

function loadChatHistory() {
    try {
        const saved = localStorage.getItem('chat_history');
        if (saved) {
            state.history = JSON.parse(saved);
        }
    } catch {}
}

// ===== 导出数据 =====
async function exportData() {
    try {
        const resp = await fetch('/api/export');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `deepseek_知识备份_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('导出失败: ' + e.message);
    }
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
