// ==UserScript==
// @name         华医网自动化考试助手 (V2.3.9 - 连续考试与随机选项版)
// @namespace    http://tampermonkey.net/
// @version      2.3.9
// @description  按课程、题干和选项内容识别试题，核对本次提交记录，避免重考乱序串题。
// @author       Gemini (Key Optimized)
// @match        *://*.91huayi.com/pages/course.aspx*
// @match        *://*.91huayi.com/pages/exam.aspx*
// @match        *://*.91huayi.com/pages/exam_result.aspx*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置项 ---
    const BASE_ANSWER_DELAY_MS = 500;
    const BASE_SUBMIT_DELAY_MS = 2000;
    const BASE_RETRY_DELAY_MS = 3000;
    const SCRIPT_STATE_KEY = 'exam_script_state_v11'; // 版本号更新
    const COURSE_LIST_URL_FRAGMENT = '/pages/course.aspx';
    const PROJECT_CONTEXT_KEY = 'exam_queue_project_v12';
    let executionGeneration = 0;

    // --- 辅助函数 ---
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const getRandomDelay = (base, range = 1500) => base + Math.random() * range;

    // --- 数据存储模块 ---
    const db = {
        load: (key, defaultValue) => {
            const value = GM_getValue(key);
            return value === undefined ? defaultValue : JSON.parse(value);
        },
        save: (key, data) => GM_setValue(key, JSON.stringify(data)),
        clear: (key) => GM_deleteValue(key)
    };

    // --- 数据库定义 (版本号更新) ---
    // 使用独立的新题库，保留旧库原始数据，避免沿用可能串题的历史判断。
    const correctAnswersDB = { key: 'correct_answers_db_v12', get: () => db.load(correctAnswersDB.key, {}), set: (data) => db.save(correctAnswersDB.key, data) };
    const wrongAttemptsDB = { key: 'wrong_attempts_db_v12', get: () => db.load(wrongAttemptsDB.key, {}), set: (data) => db.save(wrongAttemptsDB.key, data), clear: () => db.clear(wrongAttemptsDB.key) };
    const examQueueDB = { key: 'exam_queue_db_v11', get: () => db.load(examQueueDB.key, []), set: (data) => db.save(examQueueDB.key, data), clear: () => db.clear(examQueueDB.key) };
    const returnUrlDB = { key: 'return_url_db_v11', get: () => db.load(returnUrlDB.key, null), set: (data) => db.save(returnUrlDB.key, data), clear: () => db.clear(returnUrlDB.key) };
    const questionOptionMapDB = { key: 'question_option_map_v12', get: () => db.load(questionOptionMapDB.key, null), set: (data) => db.save(questionOptionMapDB.key, data), clear: () => db.clear(questionOptionMapDB.key) };
    const debugKeysDB = { key: 'debug_keys_db_v11', get: () => db.load(debugKeysDB.key, []), set: (data) => db.save(debugKeysDB.key, data), clear: () => db.clear(debugKeysDB.key) };


    // --- 核心逻辑 ---

    // --- V2.3.3 核心修改：优化Key的构造逻辑 ---
    function normalizeQuestion(text) {
        return String(text || '').normalize('NFKC').trim()
            .replace(/^(?:第\s*\d+\s*题\s*[:、.]?|\(\d+\)\s*[:、.]?|\d+\s*(?:[、:]|\.(?!\d)))\s*/, '')
            .replace(/\s+/g, '');
    }

    function normalizeOption(text) {
        return String(text || '').normalize('NFKC').trim()
            .replace(/^(?:\([A-Z]\)|[A-Z][、.:)])\s*/i, '')
            .replace(/\s+/g, '');
    }

    const currentCourseId = () => (new URL(location.href).searchParams.get('cwid') || '').toLowerCase();
    const textOf = element => element?.innerText ?? element?.textContent ?? '';
    function questionIdentity(stem, options) {
        return JSON.stringify([currentCourseId(), stem, options.map(o => o.content).sort()]);
    }
    function stopExam(reason) {
        console.error(`自动考试已停止：${reason}`);
        setScriptState(false);
        updatePanel();
    }

    function collectCourseStates() {
        return Array.from(document.querySelectorAll('.course')).map(courseEl => {
            const link = courseEl.querySelector('.cw-title-link, h3 a.f14blue');
            const progress = courseEl.querySelector('.cw-progress-row[data-studystate]');
            const statusElement = courseEl.querySelector('.cw-status button') || courseEl.querySelector('h3 > span');
            const status = (progress?.getAttribute('data-studystate') || statusElement?.textContent || '').trim();
            let cwid = null;
            try { cwid = new URL(link?.getAttribute('href') || '', location.href).searchParams.get('cwid'); } catch (error) { /* 标记为无法识别 */ }
            return { cwid, name: link?.textContent.trim() || '', status,
                recognized: !!link && /^[a-f0-9-]{36}$/i.test(cwid || '') && ['待考试', '学习中', '未学习', '已完成'].includes(status) };
        });
    }

    function getOptionInfo(optionEl) {
        if (!optionEl) return null;
        const label = optionEl.querySelector('label');
        if (!label) return null;
        const rawText = textOf(label).normalize('NFKC').trim();
        const match = rawText.match(/^(?:\(([A-Z])\)|([A-Z])[、.:)])/i);
        return {
            letter: match ? (match[1] || match[2]).toUpperCase() : null,
            content: normalizeOption(rawText), // 使用标准化的选项内容
            element: optionEl.querySelector('input.qo_name')
        };
    }

    function handleCourseListPage() {
        console.log("脚本：进入课程列表页面。");
        const courses = collectCourseStates();
        if (courses.length === 0 || courses.some(course => !course.recognized)) {
            setScriptState(false);
            updatePanel();
            alert('课程列表尚未加载完整或存在无法识别的课程状态，请检查页面后重新启动。');
            return;
        }
        const pendingExams = [...new Map(courses.filter(course => course.status === '待考试')
            .map(course => [course.cwid.toLowerCase(), { cwid: course.cwid, name: course.name }])).values()];

        if (pendingExams.length > 0) {
            console.log(`脚本：发现 ${pendingExams.length} 个待考课程。已创建考试队列。`);
            examQueueDB.set(pendingExams);
            returnUrlDB.set(window.location.href);
            db.save(PROJECT_CONTEXT_KEY, { cid: new URL(location.href).searchParams.get('cid'), url: location.href });
            updatePanel();
            processNextInQueue();
        } else {
            const allCompleted = courses.every(course => course.status === '已完成');
            console.log(allCompleted ? '脚本：所有课程均已完成。' : '脚本：当前没有待考试课程，仍有课件需要学习。');
            examQueueDB.clear(); returnUrlDB.clear(); db.clear(PROJECT_CONTEXT_KEY);
            alert(allCompleted ? '所有课程均已完成。' : '当前没有待考试课程，仍有课件需要学习。');
            setScriptState(false);
            updatePanel();
        }
    }

    async function handleExamPage() {
        const generation = executionGeneration;
        const stillRunning = () => getScriptState() && executionGeneration === generation;
        console.log("脚本：进入考试页面。开始根据内容智能作答...");
        const correctAnswers = correctAnswersDB.get();
        const wrongAttempts = wrongAttemptsDB.get();
        const questions = document.querySelectorAll('.tablestyle');
        const attempt = { version: 12, courseId: currentCourseId(), submitted: false, questions: [] };
        const examPageGeneratedKeys = [];
        if (!attempt.courseId) { stopExam('未识别到当前课件标识。'); return; }

        for (const questionEl of Array.from(questions)) {
            if (!stillRunning()) return;
            const stem = normalizeQuestion(textOf(questionEl.querySelector('.q_name')));
            const pageOptions = Array.from(questionEl.querySelectorAll('tbody tr')).map(getOptionInfo).filter(Boolean);
            if (!stem || pageOptions.length < 2 || pageOptions.some(o => !o.letter || !o.content || !o.element || o.element.type !== 'radio' || o.element.disabled)
                || new Set(pageOptions.map(o => o.content)).size !== pageOptions.length
                || new Set(pageOptions.map(o => o.letter)).size !== pageOptions.length
                || attempt.questions.some(q => q.stem === stem)) {
                stopExam('题干、单选项或重复题目无法唯一识别，未提交。'); return;
            }
            const questionKey = questionIdentity(stem, pageOptions);
            examPageGeneratedKeys.push(questionKey);
            const knownCorrects = correctAnswers[questionKey] || [];
            const knownWrongs = wrongAttempts[questionKey] || [];
            const correctContents = new Set(knownCorrects.map(item => item.content));
            const wrongContents = new Set(knownWrongs.map(item => item.content));
            if (correctContents.size > 1 || [...correctContents].some(content => wrongContents.has(content))) {
                stopExam('题库中存在互相矛盾的判断，未提交。'); return;
            }
            const candidates = pageOptions.filter(o => !wrongContents.has(o.content));
            const selected = pageOptions.find(o => correctContents.has(o.content))
                || candidates[Math.floor(Math.random() * candidates.length)];
            if (!selected) { stopExam('所有选项均已记为错误，需要检查本次结果，未重复选择第一个选项。'); return; }
            selected.element.click();
            if (!selected.element.checked || pageOptions.filter(o => o.element.checked).length !== 1) {
                stopExam('选项未实际选中，未提交。'); return;
            }
            attempt.questions.push({ key: questionKey, stem,
                options: pageOptions.map(({ letter, content }) => ({ letter, content })),
                selectedContent: selected.content, selectedLetter: selected.letter });
            console.log('本次选择（按内容）', stem, selected.content, `当前字母 ${selected.letter}`);
            await sleep(getRandomDelay(BASE_ANSWER_DELAY_MS, 1000));
        }

        if (!stillRunning() || questions.length === 0) {
            if (questions.length === 0) { setScriptState(false); updatePanel(); console.error('未识别到试题，已停止，未提交。'); }
            return;
        }

        console.log("脚本：保存本次考试的<问题-选项内容-字母>映射表...");
        questionOptionMapDB.set(attempt);
        debugKeysDB.set(examPageGeneratedKeys);

        const submitDelay = getRandomDelay(BASE_SUBMIT_DELAY_MS, 2000);
        console.log(`脚本：作答完毕，将在约 ${(submitDelay / 1000).toFixed(1)} 秒后提交...`);
        await sleep(submitDelay);
        if (!stillRunning()) return;
        const submit = document.getElementById('btn_submit');
        if (!submit || submit.disabled) { stopExam('提交按钮不可用。'); return; }
        // 延迟期间若用户改过选择，不再拿旧选择解释结果。
        const currentQuestions = Array.from(document.querySelectorAll('.tablestyle'));
        if (currentQuestions.length !== attempt.questions.length || currentQuestions.some((el, index) => {
            const options = Array.from(el.querySelectorAll('tbody tr')).map(getOptionInfo).filter(Boolean);
            const selected = options.filter(o => o.element?.checked);
            return questionIdentity(normalizeQuestion(textOf(el.querySelector('.q_name'))), options) !== attempt.questions[index].key
                || selected.length !== 1 || selected[0].content !== attempt.questions[index].selectedContent;
        })) { stopExam('提交前检测到题目或选择变化，请重新启动。'); return; }
        attempt.submitted = true;
        attempt.submittedAt = Date.now();
        questionOptionMapDB.set(attempt);
        console.log('脚本：开始点击提交按钮，等待结果页。');
        submit.click();
        console.log('脚本：提交点击已执行。如未跳页，请检查页面提示或确认弹窗。');
    }

    async function handleResultPage() {
        const generation = executionGeneration;
        const stillRunning = () => getScriptState() && executionGeneration === generation;
        console.log("脚本：进入结果页面，准备进行高保真学习。");
        const previousExamKeys = debugKeysDB.get();
        if (previousExamKeys.length > 0) {
            console.log("--- 考试页Key摘要 (用于对比) ---");
            console.table(previousExamKeys);
            console.log("---------------------------------");
            debugKeysDB.clear();
        }

        const isPassed = !!document.querySelector('.tips_text')?.innerText.includes('考试通过');

        if (isPassed) {
            console.log("考试通过！准备处理下一个课程...");
            console.log("正在清除本次考试的答案库（适配不同考试）...");
            db.clear(correctAnswersDB.key);
            wrongAttemptsDB.clear();

            questionOptionMapDB.clear();
            const cwidMatch = window.location.href.match(/cwid=([a-f0-9-]+)/);
            if (cwidMatch) {
                const completedCwid = cwidMatch[1];
                let queue = examQueueDB.get();
                queue = queue.filter(exam => exam.cwid.toLowerCase() !== completedCwid.toLowerCase());
                examQueueDB.set(queue);
            }
            await sleep(1000);
            if (!stillRunning()) return;
            returnToCourseListAfterPass();
        } else {
            console.log("考试未通过。正在更新智能题库并准备重试...");
            const attempt = questionOptionMapDB.get();
            if (!/未通过|没有通过|不及格|未合格|不合格|考试失败/.test(textOf(document.querySelector('.tips_text')))) {
                stopExam('尚未识别到明确的考试结果。'); return;
            }
            if (attempt?.version !== 12 || !attempt.submitted || attempt.courseId !== currentCourseId() || !attempt.questions?.length) {
                stopExam('没有当前课件的本次提交记录，请从考试页重新启动。'); return;
            }
            const correctAnswers = correctAnswersDB.get();
            const wrongAttempts = wrongAttemptsDB.get();
            const feedback = [], seen = new Set();
            for (const item of document.querySelectorAll('.state_cour_ul .state_cour_lis')) {
                const texts = item.querySelectorAll('.state_lis_text');
                const elements = Array.from(texts);
                const matches = attempt.questions.filter(q => elements.some(el =>
                    normalizeQuestion(el.title) === q.stem || normalizeQuestion(textOf(el)) === q.stem));
                const questionElement = matches.length === 1 ? elements.find(el =>
                    normalizeQuestion(el.title) === matches[0].stem || normalizeQuestion(textOf(el)) === matches[0].stem) : null;
                const answerCandidates = elements.filter(el => el !== questionElement && textOf(el).trim()
                    && !/^\d+\s*[、.：:]?$/.test(textOf(el).trim()));
                const answerElement = answerCandidates.find(el => /您的答案/.test(textOf(el)))
                    || (answerCandidates.length === 1 ? answerCandidates[0] : null);
                const mark = item.querySelector('.state_error');
                const source = mark?.getAttribute('src') || mark?.querySelector('img')?.getAttribute('src');
                if (matches.length !== 1 || !answerElement || !source || seen.has(matches[0]?.key)) {
                    console.error('结果匹配诊断', { matchingQuestions: matches.length, answerCandidates: answerCandidates.length,
                        hasAnswer: !!answerElement, markerSource: source || null, duplicate: seen.has(matches[0]?.key),
                        resultTexts: elements.map(el => ({ title: el.title, text: textOf(el) })),
                        submittedStems: attempt.questions.map(q => q.stem) });
                    stopExam('结果页题目或正误标记无法与本次提交唯一对应，未更新题库。'); return;
                }
                const question = matches[0];
                const raw = textOf(answerElement).normalize('NFKC').trim()
                    .replace(/^【?\s*您的答案\s*:\s*/, '').replace(/】\s*$/, '').trim();
                // 字母仅用于解释刚提交的那一份试卷；下一次作答只认内容。
                const plain = raw.replace(/\s+/g, '');
                const answer = question.options.find(o => o.content === plain)
                    || (/^[A-Z]$/i.test(raw) ? question.options.find(o => o.letter === raw.toUpperCase())
                        : question.options.find(o => o.content === normalizeOption(raw)));
                if (!answer || answer.content !== question.selectedContent) {
                    stopExam('结果页答案与本次实际提交不一致，未更新题库。'); return;
                }
                seen.add(question.key);
                feedback.push({ questionKey: question.key, content: answer.content,
                    isCorrect: /(?:^|\/)bar_img\.png(?:[?#]|$)/i.test(source) });
            }
            if (feedback.length !== attempt.questions.length) {
                stopExam('结果页反馈不完整，未更新题库。'); return;
            }
            // 全卷核对成功后一次性更新，避免半张试卷的错误映射污染题库。
            for (const { questionKey, content, isCorrect } of feedback) {
                const knowledgeBit = { content };
                if (isCorrect) {
                    correctAnswers[questionKey] = [knowledgeBit];
                    if (wrongAttempts[questionKey]) {
                        wrongAttempts[questionKey] = wrongAttempts[questionKey].filter(k => k.content !== knowledgeBit.content);
                        if (wrongAttempts[questionKey].length === 0) delete wrongAttempts[questionKey];
                    }
                } else {
                    if (correctAnswers[questionKey]) {
                        correctAnswers[questionKey] = correctAnswers[questionKey].filter(k => k.content !== content);
                        if (!correctAnswers[questionKey].length) delete correctAnswers[questionKey];
                    }
                    if (!wrongAttempts[questionKey]) wrongAttempts[questionKey] = [];
                    if (!wrongAttempts[questionKey].some(k => k.content === knowledgeBit.content)) {
                        wrongAttempts[questionKey].push(knowledgeBit);
                    }
                }
            }
            correctAnswersDB.set(correctAnswers);
            wrongAttemptsDB.set(wrongAttempts);
            await sleep(getRandomDelay(BASE_RETRY_DELAY_MS, 2000));
            if (!stillRunning()) return;

            const retryButton = Array.from(document.querySelectorAll('input.state_foot_btn')).find(btn => btn.value === '重新考试');
            if(retryButton) retryButton.click(); else console.error("找不到“重新考试”按钮！");
        }
    }

    function returnToCourseListAfterPass() {
        if (!getScriptState()) return;
        const urls = [returnUrlDB.get(), db.load(PROJECT_CONTEXT_KEY, null)?.url,
            ...Array.from(document.querySelectorAll('a[href]'), a => a.href)];
        for (const value of urls) {
            if (!value) continue;
            try {
                const url = new URL(value, location.href);
                if (url.origin !== location.origin || url.pathname !== COURSE_LIST_URL_FRAGMENT || !url.searchParams.get('cid')) continue;
                // 保持运行，回列表重新读取实时状态，不凭旧队列宣告全部完成。
                returnUrlDB.set(url.href);
                db.save(PROJECT_CONTEXT_KEY, { cid: url.searchParams.get('cid'), url: url.href });
                window.location.href = url.href;
                return;
            } catch (error) { /* 跳过无效链接 */ }
        }
        stopExam('无法确定目标项目，请返回项目课程列表启动，才能连续处理剩余待考试课程。');
    }

    function processNextInQueue() {
        if (!getScriptState()) return;
        const project = db.load(PROJECT_CONTEXT_KEY, null);
        if (!project?.cid || project.url !== returnUrlDB.get()) {
            setScriptState(false); updatePanel();
            alert('本次考试已处理。请返回目标项目列表重新启动，以免使用旧项目队列。');
            return;
        }
        const queue = examQueueDB.get();
        if (queue.length > 0) {
            const nextExam = queue[0];
            console.log(`脚本：正在导航到下一个考试，课程名: ${nextExam.name}`);
            window.location.href = `/pages/exam.aspx?cwid=${nextExam.cwid}`;
        } else {
            console.log("队列已清空！所有考试均已完成！");
            const returnUrl = returnUrlDB.get();
            examQueueDB.clear(); returnUrlDB.clear(); db.clear(PROJECT_CONTEXT_KEY); wrongAttemptsDB.clear(); questionOptionMapDB.clear();
            setScriptState(false);
            alert("所有待考课程均已完成！脚本已停止。即将返回课程列表页。");
            setTimeout(() => { if (returnUrl) window.location.href = returnUrl; }, 2000);
        }
    }

    // --- UI 控制面板 ---
    function setupUI() {
        if (document.getElementById('exam-helper-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'exam-helper-panel'; document.body.appendChild(panel);
        const dbViewer = document.createElement('div');
        dbViewer.id = 'db-viewer-panel';
        dbViewer.style.display = 'none';
        dbViewer.innerHTML = `<div id="db-viewer-header"><h3>数据库信息 (只读)</h3><span id="db-viewer-close-btn">&times;</span></div><div id="db-viewer-content"></div>`;
        document.body.appendChild(dbViewer);
        dbViewer.querySelector('#db-viewer-close-btn').addEventListener('click', () => dbViewer.style.display = 'none');
        GM_addStyle(`
            #exam-helper-panel { position: fixed; bottom: 20px; right: 20px; background-color: #f0f9ff; border: 2px solid #1e90ff; border-radius: 8px; padding: 15px; z-index: 9999; font-family: sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.15); width: 260px; font-size: 14px; }
            #exam-helper-panel h3 { margin: 0 0 12px 0; color: #1e90ff; text-align: center; font-size: 16px; }
            #exam-helper-panel button { width: 100%; padding: 8px; margin-bottom: 10px; border: none; border-radius: 5px; color: white; cursor: pointer; font-size: 14px; transition: background-color 0.2s; }
            #exam-helper-panel button:hover { opacity: 0.9; }
            #toggle-script-btn { background-color: #28a745; } #toggle-script-btn.running { background-color: #dc3545; }
            #clear-queue-btn { background-color: #007bff; } #view-db-btn { background-color: #6c757d; } #clear-db-btn { background-color: #ffc107; }
            #exam-helper-panel p { margin: 5px 0; line-height: 1.4; } #exam-helper-panel strong { color: #333; }
            #queue-list-container { background-color: #fff; border: 1px solid #ddd; border-radius: 4px; padding: 5px 10px; margin-top: 10px; max-height: 150px; overflow-y: auto; font-size: 12px; }
            #db-viewer-panel { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 80%; max-width: 800px; height: 80%; max-height: 600px; background-color: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.5); z-index: 10001; flex-direction: column; }
            #db-viewer-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background-color: #f7f7f7; border-bottom: 1px solid #eee; }
            #db-viewer-close-btn { font-size: 24px; color: #888; cursor: pointer; font-weight: bold; }
            #db-viewer-content { padding: 15px; overflow: auto; flex-grow: 1; font-family: Consolas, Monaco, monospace; font-size: 13px; background-color: #fafafa; }
            #db-viewer-content h4 { margin-top: 0; color: #1e90ff; border-bottom: 1px solid #ddd; padding-bottom: 5px;}
            #db-viewer-content pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
        `);
        updatePanel();
    }

    function updatePanel() {
        const panel = document.getElementById('exam-helper-panel');
        if (!panel) return;
        const isRunning = getScriptState();
        const queue = examQueueDB.get();
        const currentExam = queue.length > 0 ? queue[0].name : "无";
        const remainingQueue = queue.slice(1);
        let queueHtml = '<p style="color:#888;text-align:center;font-style:italic;">队列为空</p>';
        if (remainingQueue.length > 0) queueHtml = '<ol style="margin:0;padding-left:20px;">' + remainingQueue.map(exam => `<li style="margin-bottom:5px;color:#555;">${exam.name}</li>`).join('') + '</ol>';
        panel.innerHTML = `
            <h3>自动考试控制 V2.3.9</h3>
            <button id="toggle-script-btn">${isRunning ? '暂停自动考试' : '开始自动考试'}</button>
            <button id="clear-queue-btn">清空队列</button>
            <button id="view-db-btn">查看数据库</button>
            <button id="clear-db-btn">清除全部数据(重要)</button>
            <p><strong>脚本状态:</strong> <span style="color: ${isRunning ? '#28a745' : '#dc3545'}; font-weight: bold;">${isRunning ? '运行中' : '已停止'}</span></p>
            <p><strong>当前操作:</strong> <span style="color: #007bff; font-weight: bold;">${currentExam}</span></p>
            <strong>待考列表:</strong>
            <div id="queue-list-container" style="background-color:#fff;border:1px solid #ddd;border-radius:4px;padding:5px 10px;margin-top:10px;max-height:150px;overflow-y:auto;font-size:12px;">${queueHtml}</div>
        `;
        if (isRunning) panel.querySelector('#toggle-script-btn').classList.add('running');
        panel.querySelector('#toggle-script-btn').addEventListener('click', toggleScript);
        panel.querySelector('#view-db-btn').addEventListener('click', showDbInfo);
        panel.querySelector('#clear-queue-btn').addEventListener('click', () => { if (confirm('确定要清空当前的考试队列吗？')) { setScriptState(false); examQueueDB.clear(); returnUrlDB.clear(); db.clear(PROJECT_CONTEXT_KEY); updatePanel(); } });
        panel.querySelector('#clear-db-btn').addEventListener('click', () => {
            if (confirm('【！！！重要！！！】\n确定要清除所有本地数据吗？\n\n这会清除新版题库和当前队列。旧版本题库备份不受影响。此操作不可逆！')) {
                setScriptState(false); db.clear(PROJECT_CONTEXT_KEY);
                db.clear(correctAnswersDB.key); db.clear(wrongAttemptsDB.key); db.clear(examQueueDB.key); db.clear(returnUrlDB.key); db.clear(questionOptionMapDB.key); db.clear(debugKeysDB.key);
                alert('所有数据已清除！脚本现在可以正常运行。'); updatePanel();
            }
        });
    }

    function showDbInfo() {
        const viewer = document.getElementById('db-viewer-panel');
        const contentEl = document.getElementById('db-viewer-content');
        if (!viewer || !contentEl) return;
        const correct = correctAnswersDB.get(); const wrong = wrongAttemptsDB.get();
        contentEl.innerHTML = `<h4>✔️ 正确答案库</h4><pre>${JSON.stringify(correct, null, 2)}</pre><hr style="margin:20px 0;"><h4>❌ 错题本</h4><pre>${JSON.stringify(wrong, null, 2)}</pre>`;
        viewer.style.display = 'flex';
    }

    function getScriptState() { return db.load(SCRIPT_STATE_KEY, false); }
    function setScriptState(isRunning) { executionGeneration++; db.save(SCRIPT_STATE_KEY, isRunning); }

    function toggleScript() {
        const currentState = getScriptState(); setScriptState(!currentState);
        if (!currentState) main(); else console.log("脚本已由用户暂停。");
        updatePanel();
    }

    function main() {
        setupUI();
        if (!getScriptState()) {
            console.log("脚本当前为停止状态，请在课程列表页点击【开始自动考试】按钮启动。");
            return;
        }
        const urlPath = window.location.pathname;
        if (urlPath.includes(COURSE_LIST_URL_FRAGMENT)) handleCourseListPage();
        else if (urlPath.includes('/exam.aspx')) handleExamPage();
        else if (urlPath.includes('/exam_result.aspx')) handleResultPage();
    }

    main();
})();
