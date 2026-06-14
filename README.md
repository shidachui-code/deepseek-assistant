# DeepSeek 知识助手

读取你的全部 DeepSeek 聊天记录，构建一个"了解你"的 AI 聊天助手。

## 一、本地运行

```bash
# 安装依赖
npm install

# 启动
npm start
```

浏览器打开 `http://localhost:3000`。

## 二、部署到云端（手机随时随地访问）

### 方法：Zeabur（推荐，国内访问快）

1. **注册 GitHub**（如已有则跳过）
   - 打开 https://github.com 注册账号

2. **上传代码到 GitHub**
   - 登录 GitHub → 点右上角 `+` → `New repository`
   - 填仓库名（如 `deepseek-assistant`）→ 点 `Create repository`
   - 回到命令行执行以下命令（替换 `<你的用户名>`）：

```bash
cd "D:\building future files\01数据分析（应用层）\deepseek-knowledge-app"
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/deepseek-assistant.git
git push -u origin main
```

3. **部署到 Zeabur**
   - 打开 https://zeabur.com 用 GitHub 登录
   - 点 `Create Project` → `Deploy from GitHub`
   - 选择刚创建的 `deepseek-assistant` 仓库
   - Zeabur 会自动检测 Node.js 并部署
   - 部署完成后，Zeabur 会给你一个 `.zeabur.app` 结尾的链接

4. **设置 API Key**
   - 打开 Zeabur 给你的链接
   - 点「设置」→ 选择 DeepSeek API → 填入你的 API Key
   - 保存即可开始使用

### 获取 DeepSeek API Key

1. 打开 https://platform.deepseek.com
2. 注册账号 → 充值（5-10 元够用很久）
3. 左侧 `API Keys` → 创建新的 Key

## 三、数据说明

- 所有聊天记录保存在服务器数据库中
- 每次对话都会自动保存，新对话会作为知识参与后续回答
- 可在「设置」中点击「导出数据」下载全部聊天记录的 JSON 备份

## 四、文件结构

```
├── data/
│   ├── knowledge.txt    # 初始知识库（你的 DeepSeek 聊天记录）
│   └── chat.db          # 对话数据库（自动生成）
├── public/              # 前端页面
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server.js            # 后端服务
└── package.json
```
