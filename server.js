const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 数据库（持久化聊天记录） =====
const DB_PATH = path.join(__dirname, 'data', 'chat.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 建表
db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        topic TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// 初始化配置表
const initConfig = (key, defaultValue) => {
    const exists = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    if (!exists) {
        db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(key, defaultValue);
    }
};
initConfig('provider', process.env.AI_PROVIDER || 'deepseek');
initConfig('apiUrl', process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions');
initConfig('model', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
initConfig('apiKey', process.env.DEEPSEEK_API_KEY || '');
initConfig('ollamaUrl', 'http://localhost:11434/api/chat');
initConfig('ollamaModel', 'deepseek-r1:7b');

// ===== 知识库 =====
const KNOWLEDGE_FILE = path.join(__dirname, 'data', 'knowledge.txt');
let knowledgeChunks = [];

function loadKnowledge() {
    try {
        const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
        const lines = raw.split('\n');
        let currentChunk = '';
        let currentTitle = '开头';
        const chunks = [];

        for (const line of lines) {
            const match = line.match(/^(对话\d+|第\s*\d+\s*轮)/);
            if (match) {
                if (currentChunk.trim().length > 20) {
                    chunks.push({ title: currentTitle, text: currentChunk.trim() });
                }
                currentTitle = match[1];
                currentChunk = line + '\n';
            } else {
                currentChunk += line + '\n';
            }
        }
        if (currentChunk.trim().length > 20) {
            chunks.push({ title: currentTitle, text: currentChunk.trim() });
        }
        knowledgeChunks = chunks;
        console.log(`✅ 知识库: ${chunks.length} 个片段, ${(raw.length / 1024 / 1024).toFixed(1)}MB`);
    } catch (e) {
        console.log('⚠️ 知识库文件不存在，仅依靠对话历史');
        knowledgeChunks = [];
    }
}

loadKnowledge();

// 关键词搜索
function searchKnowledge(query) {
    const words = query.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return [];

    // 也搜索历史对话
    const historyResults = [];
    try {
        const historyRows = db.prepare(
            "SELECT role, content FROM conversations ORDER BY id"
        ).all();
        // 把历史对话也切成片段（每轮QA为一个片段）
        let tempQ = '';
        for (const row of historyRows) {
            if (row.role === 'user') {
                tempQ = row.content;
            } else if (row.role === 'assistant' && tempQ) {
                let score = 0;
                const text = tempQ + ' ' + row.content;
                for (const word of words) {
                    const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    const matches = text.match(regex);
                    if (matches) score += matches.length * word.length;
                }
                if (score > 0) {
                    historyResults.push({
                        title: '历史对话',
                        text: `问：${tempQ}\n答：${row.content.substring(0, 500)}`,
                        score
                    });
                }
                tempQ = '';
            }
        }
    } catch {}

    // 搜索知识库
    const kbResults = knowledgeChunks.map(chunk => {
        let score = 0;
        for (const word of words) {
            const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const matches = chunk.text.match(regex);
            if (matches) score += matches.length * word.length;
        }
        return { ...chunk, score };
    }).filter(c => c.score > 0);

    // 合并结果，取前 10 个
    const all = [...kbResults, ...historyResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    return all;
}

// ===== AI API 调用 =====
function getConfig(key) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : '';
}

function setConfig(key, value) {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

async function callAI(messages) {
    const provider = getConfig('provider');

    if (provider === 'deepseek') {
        const apiKey = getConfig('apiKey');
        if (!apiKey) throw new Error('请先设置 API Key');
        return await fetch(getConfig('apiUrl') || 'https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: getConfig('model') || 'deepseek-chat',
                messages,
                stream: true
            })
        });
    } else if (provider === 'ollama') {
        return await fetch(getConfig('ollamaUrl'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: getConfig('ollamaModel'),
                messages,
                stream: true
            })
        });
    } else {
        const apiKey = getConfig('apiKey');
        return await fetch(getConfig('apiUrl'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: getConfig('model'),
                messages,
                stream: true
            })
        });
    }
}

// ===== API 路由 =====

// 聊天接口
app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: '消息不能为空' });

    // 存储用户消息
    db.prepare('INSERT INTO conversations (role, content) VALUES (?, ?)').run('user', message);

    // 搜索相关知识
    const relevant = searchKnowledge(message);
    const contextStr = relevant.length > 0
        ? relevant.map(c => `【${c.title}】\n${c.text.substring(0, 1500)}`).join('\n\n')
        : '暂无直接相关的历史记录。';

    const systemPrompt = `你是一个深度了解用户的 AI 助手。

## 用户背景资料（从历史聊天中提取，按相关度排序）

${contextStr}

## 指令

请基于以上用户背景资料来回答他的问题。如果背景资料明确提到了相关信息（如用户的专业、工作、经历、性格等），你必须直接引用并基于这些信息回答。如果背景资料没有足够信息，你可以如实说不知道。回答要自然、贴心，像老朋友一样。

关键：用户问"你了解我吗"或"你知道我什么"之类的问题时，请从背景资料中提取关于用户的关键信息进行回应。`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).slice(-30),
        { role: 'user', content: message }
    ];

    try {
        const aiResp = await callAI(messages);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let fullResponse = '';
        const provider = getConfig('provider');

        if (provider === 'ollama') {
            const reader = aiResp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            res.write(json.message.content);
                            fullResponse += json.message.content;
                        }
                    } catch {}
                }
            }
        } else {
            const reader = aiResp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
                for (const line of lines) {
                    const data = line.substring(6).trim();
                    if (data === '[DONE]') break;
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.delta?.content || '';
                        if (content) {
                            res.write(content);
                            fullResponse += content;
                        }
                    } catch {}
                }
            }
        }
        res.end();

        // 存储 AI 回复
        db.prepare('INSERT INTO conversations (role, content) VALUES (?, ?)').run('assistant', fullResponse);
        console.log(`💬 已保存对话: "${message.substring(0, 40)}..." → ${fullResponse.length} 字回复`);

    } catch (err) {
        console.error('AI 调用失败:', err.message);
        res.write(`\n\n⚠️ 错误: ${err.message}`);
        res.write('\n\n请在「设置」中检查 API Key 是否正确配置，或切换 AI 后端。');
        res.end();
    }
});

// 配置管理
app.get('/api/config', (req, res) => {
    res.json({
        provider: getConfig('provider'),
        model: getConfig('model'),
        hasKey: !!getConfig('apiKey')
    });
});

app.post('/api/config', (req, res) => {
    const { provider, apiKey, model, apiUrl, ollamaUrl, ollamaModel } = req.body;
    if (provider) setConfig('provider', provider);
    if (apiKey !== undefined) setConfig('apiKey', apiKey);
    if (model) setConfig('model', model);
    if (apiUrl) setConfig('apiUrl', apiUrl);
    if (ollamaUrl) setConfig('ollamaUrl', ollamaUrl);
    if (ollamaModel) setConfig('ollamaModel', ollamaModel);
    res.json({ ok: true });
});

// 知识库统计
app.get('/api/knowledge', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) as c FROM conversations').get();
    const knowledgeSize = knowledgeChunks.reduce((s, c) => s + c.text.length, 0);
    res.json({
        kbChunks: knowledgeChunks.length,
        kbSizeMB: (knowledgeSize / 1024 / 1024).toFixed(1),
        totalChats: count.c,
        historyChats: count.c
    });
});

// 导出数据
app.get('/api/export', (req, res) => {
    const rows = db.prepare('SELECT id, role, content, created_at FROM conversations ORDER BY id').all();
    const exportData = {
        exportTime: new Date().toISOString(),
        totalConversations: rows.length,
        conversations: rows.map(r => ({
            role: r.role,
            content: r.content,
            time: r.created_at
        })),
        knowledgePieces: knowledgeChunks.length
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=deepseek_knowledge_backup.json');
    res.json(exportData);
});

// 搜索测试（调试用）
app.post('/api/search', (req, res) => {
    const { query } = req.body;
    if (!query) return res.json({ results: [] });
    const results = searchKnowledge(query);
    res.json({
        query,
        count: results.length,
        results: results.map(r => ({ title: r.title, score: r.score, preview: r.text.substring(0, 200) }))
    });
});

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 DeepSeek 知识助手已启动！`);
    console.log(`   地址: http://localhost:${PORT}`);
    console.log(`   知识库: ${knowledgeChunks.length} 个片段`);
    const count = db.prepare('SELECT COUNT(*) as c FROM conversations').get();
    console.log(`   已保存 ${count.c} 条对话记录\n`);
});
