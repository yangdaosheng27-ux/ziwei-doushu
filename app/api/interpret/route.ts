/**
* POST /api/interpret — AI 解读接口（开源版自实现）
*
* 前端（components/ChatPanel.tsx、components/InsightPanel.tsx）契约：
* 请求：JSON { chart: ZiweiChart, messages: { role, content}[]}
* 响应：SSE 流，每行 `data: {"delta":{"text":"..."}}`，以 `data: [DONE]` 结束
* 状态码：404 = 接口缺失（前端会提示"开源版不含接口"），其他非 2xx = 配置/请求错误
* —— 因此未配置 API Key 时返回 500，绝不能返回 404。
*
* 上游：OpenAI 兼容的 chat/completions 流式接口，默认 DeepSeek。
* 环境变量：
* DEEPSEEK_API_KEY 必填（缺失时 fallback AI_API_KEY）
* AI_API_KEY DEEPSEEK_API_KEY 未设置时的备选
* DEEPSEEK_BASE_URL 可选，默认 https://api.deepseek.com
* DEEPSEEK_MODEL 可选，默认 deepseek-chat
*/

import type { NextRequest} from 'next/server';
import type { Palace, Star, ZiweiChart} from '@/lib/ziwei/types';
import { BRANCHES, SHICHEN, SI_HUA_TABLE, STEMS} from '@/lib/ziwei/constants';

export const maxDuration = 60;

// ─── 命盘序列化 ──────────────────────────────────────────────

const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];

function siHuaText(stemIndex: number | undefined): string {
if (stemIndex === undefined || stemIndex === null) return '';
const arr = SI_HUA_TABLE[stemIndex];
if (!arr) return '';
return `${arr[0]}化禄、${arr[1]}化权、${arr[2]}化科、${arr[3]}化忌`;
}

function formatStar(star: Star): string {
const marks: string[] = [];
if (star.brightnessRaw) marks.push(star.brightnessRaw);
if (star.siHua) marks.push(`化${star.siHua}`);
return marks.length? `${star.name}(${marks.join('·')})`: star.name;
}

function formatPalace(p: Palace): string {
const branchName = BRANCHES[p.branch]?? '';
const stemName = STEMS[p.stem]?? '';
const tags: string[] = [];
if (p.isShenGong) tags.push('身宫');
if (p.isCurrentDaXian) tags.push('当前大限所在宫');

const stars = Array.isArray(p.stars)? p.stars: [];
const majors = stars.filter(s => s.type === 'major');
const others = stars.filter(s => s.type!== 'major');

const parts: string[] = [`${p.name}（${branchName}宫${stemName? `·宫干${stemName}`: ''}）`];
if (tags.length) parts.push(``);
if (majors.length) {
parts.push(`主星 ${majors.map(formatStar).join('、')}`);
} else if (p.isEmpty) {
const borrowed = p.borrowedStars?.length
? p.borrowedStars.join('、')
: others.length
? ''
: '';
parts.push(
`空宫${p.borrowedFromName? `，借对宫${p.borrowedFromName}`: ''}${borrowed? `主星 ${borrowed}`: ''}`,
);
}
if (others.length) parts.push(`辅星/煞星 ${others.map(formatStar).join('、')}`);
if (p.selfSihua?.length) {
parts.push(`宫干自化 ${p.selfSihua.map(m => `${m.starName}自化${m.siHua}`).join('、')}`);
}
if (p.daXianAge) parts.push(`大限 ${p.daXianAge[0]}–${p.daXianAge[1]}岁`);
return parts.join('；');
}

/** 把 ZiweiChart 转成可读的中文命盘摘要，字段缺失时跳过对应行，绝不抛错。 */
export function serializeChart(chart: ZiweiChart): string {
const lines: string[] = [''];
try {
const bi = chart?.birthInfo;
const li = chart?.lunarInfo;

if (bi) {
if (bi.name) lines.push(`姓名：${bi.name}`);
const genderText = chart.yinYangGender
?? (bi.gender === 'female'? '女': bi.gender === 'male'? '男': '');
if (genderText) lines.push(`性别：${genderText}`);
const shichen = SHICHEN.find(s => s.branch === bi.hour);
lines.push(
`出生阳历：${bi.year}年${bi.month}月${bi.day}日 ${shichen? `${shichen.name}（${shichen.range}）`: `时辰索引${bi.hour}`}`,
);
if (bi.origInput) {
const o = bi.origInput;
lines.push(
`原始输入时间：${o.year}年${o.month}月${o.day}日 ${String(o.clockHour).padStart(2, '0')}:${String(o.clockMinute).padStart(2, '0')}（排盘日期已按子时换日规则处理）`,
);
}
const place = [bi.province, bi.city].filter(Boolean).join(' ');
if (place || bi.longitude!== undefined) {
lines.push(`出生地：${place}${bi.longitude!== undefined? `（经度 ${bi.longitude}）`: ''}`);
}
}

if (li) {
const stemName = STEMS[li.yearStem]?? '';
const branchName = BRANCHES[li.yearBranch]?? '';
const monthAbs = Math.abs(li.lunarMonth);
const monthName = LUNAR_MONTHS[monthAbs - 1]?? `${monthAbs}月`;
lines.push(
`农历：${stemName}${branchName}年 ${li.isLeapMonth || li.lunarMonth < 0? '闰': ''}${monthName}${li.lunarDay}日`,
);
if (li.fourPillars?.length) lines.push(`四柱（节气口径）：${li.fourPillars.join(' ')}`);
if (li.fourPillarsLunar?.length) lines.push(`四柱（农历口径）：${li.fourPillarsLunar.join(' ')}`);
const yearSiHua = siHuaText(li.yearStem);
if (yearSiHua) lines.push(`生年四化（${stemName}干）：${yearSiHua}`);
}

const mingBranch = chart?.mingGongBranch;
const shenBranch = chart?.shenGongBranch;
const mingName = mingBranch!== undefined? BRANCHES[mingBranch]: undefined;
const shenName = shenBranch!== undefined? BRANCHES[shenBranch]: undefined;
if (mingName || shenName) {
lines.push(`命宫：${mingName?? '?'}宫；身宫：${shenName?? '?'}宫`);
}
if (chart?.wuxingJuName) {
lines.push(`五行局：${chart.wuxingJuName}${chart.wuxingJu? `（${chart.wuxingJu}）`: ''}`);
}
if (chart?.mingZhu || chart?.shenZhu) {
lines.push(`命主：${chart.mingZhu?? '—'}；身主：${chart.shenZhu?? '—'}`);
}

// 十二宫：从命宫起按宫位顺序（命→兄弟→夫妻→…地支递减）排列
const palaces = Array.isArray(chart?.palaces)? chart.palaces: [];
if (palaces.length) {
lines.push('', '');
const start = mingBranch?? palaces[0]?.branch?? 0;
const ordered = [...palaces].sort(
(a, b) => ((start - a.branch + 12) % 12) - ((start - b.branch + 12) % 12),
);
for (const p of ordered) lines.push(formatPalace(p));
}

// 当前大限 / 流年
const daXians = Array.isArray(chart?.daXians)? chart.daXians: [];
const curIdx = chart?.currentDaXianIndex;
const curDx = curIdx!== undefined && curIdx >= 0? daXians[curIdx]: undefined;
if (chart?.currentAge!== undefined || curDx) {
lines.push('', '');
if (chart?.currentAge!== undefined) lines.push(`当前虚岁：${chart.currentAge}岁`);
if (curDx) {
let dxLine = `当前大限：${curDx.palaceName}（${curDx.startAge}–${curDx.endAge}岁）`;
if (curDx.siHua) {
dxLine += `；大限四化（${curDx.siHua.stemName?? ''}干）：${curDx.siHua.lu}化禄、${curDx.siHua.quan}化权、${curDx.siHua.ke}化科、${curDx.siHua.ji}化忌`;
} else if (curDx.stemName) {
const t = siHuaText(curDx.stemIndex);
if (t) dxLine += `；大限四化（${curDx.stemName}干）：${t}`;
}
lines.push(dxLine);
}
// 流年：虚岁推公历年（出生年 + 虚岁 - 1）
if (bi && chart?.currentAge) {
const liuYear = bi.year + chart.currentAge - 1;
const yStem = ((liuYear - 4) % 10 + 10) % 10;
const yBranch = ((liuYear - 4) % 12 + 12) % 12;
const liuPalace = palaces.find(p => p.branch === yBranch);
const liuSiHua = siHuaText(yStem);
lines.push(
`流年：${liuYear}年（${STEMS[yStem]}${BRANCHES[yBranch]}年），流年命宫在${liuPalace? liuPalace.name: `${BRANCHES[yBranch]}宫`}${liuSiHua? `；流年四化：${liuSiHua}`: ''}`,
);
}
}
} catch {
// 序列化失败时退化为原始 JSON，保证接口可用
try {
lines.push(JSON.stringify(chart).slice(0, 4000));
} catch { /* 忽略 */}
}
return lines.join('\n');
}

// ─── 系统提示词 ──────────────────────────────────────────────

function buildSystemPrompt(chart: ZiweiChart): string {
return [
'你是一位精通紫微斗数的解读师，师承倪海厦《天纪》的论命体系。你熟悉十四主星的庙旺落陷、辅煞星的配合、生年四化与宫干自化、飞星与三方四正的参看方法，以及大限流年的推演。',
'',
'解读要求：',
'1. 一切论断必须落到下面给出的命盘数据上：点名具体的宫位、星曜、亮度和四化，说清依据，不说放之四海皆准的空话套话。',
'2. 结合三方四正与对宫参看；遇到空宫要说明借对宫主星论断；有自化、化忌冲照等关键结构要明确指出。',
'3. 用户问当前运势时，结合当前大限与流年四化分析；问某个生活领域时，定位到对应宫位及其三方四正。',
'4. 用中文回答（命理专名用中文原名，如紫微、天府、化禄、命宫），语气平实亲切，条理清楚，可用小标题或分段，但不要堆砌术语吓唬人。',
'5. 命理是传统文化视角的参考，不是命运判决：不作绝对化断言，健康问题只作传统命理角度的提醒，不替代医疗诊断；最后可给一两条具体可行的建议。',
'',
serializeChart(chart),
].join('\n');
}

// ─── 路由 ────────────────────────────────────────────────────

interface ChatMessage {
role: 'user' | 'assistant';
content: string;
}

export async function POST(req: NextRequest) {
let body: { chart?: ZiweiChart; messages?: unknown};
try {
body = await req.json();
} catch {
return Response.json({ error: '请求体不是合法 JSON'}, { status: 400});
}

const rawMessages = body?.messages;
if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
return Response.json({ error: 'messages 必须是非空数组'}, { status: 400});
}
const messages: ChatMessage[] = rawMessages
.filter((m): m is { role?: unknown; content?: unknown} =>!!m && typeof m === 'object')
.map(m => ({
role: m.role === 'assistant'? 'assistant' as const: 'user' as const,
content: typeof m.content === 'string'? m.content: String(m.content?? ''),
}))
.filter(m => m.content.trim().length > 0);
if (messages.length === 0) {
return Response.json({ error: 'messages 必须是非空数组'}, { status: 400});
}

const chart = body.chart;
if (!chart || typeof chart!== 'object') {
return Response.json({ error: '缺少 chart 命盘数据'}, { status: 400});
}

const apiKey = process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY;
if (!apiKey) {
// 注意：这里必须返回 500 而非 404 —— 前端把 404 视为"接口不存在"
return Response.json(
{ error: 'DEEPSEEK_API_KEY 未配置：请在.env.local 或部署环境中设置 DeepSeek API Key'},
{ status: 500},
);
}
const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

let upstream: Response;
try {
upstream = await fetch(`${baseUrl}/chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
Authorization: `Bearer ${apiKey}`,
},
body: JSON.stringify({
model,
stream: true,
messages: [
{ role: 'system', content: buildSystemPrompt(chart)},
...messages,
],
}),
});
} catch (err) {
return Response.json(
{ error: `无法连接模型接口：${err instanceof Error? err.message: String(err)}`},
{ status: 502},
);
}

if (!upstream.ok ||!upstream.body) {
const detail = await upstream.text().catch(() => '');
return Response.json(
{ error: `模型接口返回错误（HTTP ${upstream.status}）`, detail: detail.slice(0, 500)},
{ status: upstream.status},
);
}

// 把上游 OpenAI 格式 SSE 逐块转成前端格式：data: {"delta":{"text":"..."}}
const encoder = new TextEncoder();
const reader = upstream.body.getReader();
const stream = new ReadableStream<Uint8Array>({
async start(controller) {
const decoder = new TextDecoder();
let buffer = '';
const pushLine = (rawLine: string) => {
const line = rawLine.trim();
if (!line.startsWith('data:')) return;
const data = line.slice(5).trim();
if (!data || data === '[DONE]') return;
try {
const json = JSON.parse(data) as {
choices?: { delta?: { content?: unknown}}[];
};
const text = json.choices?.[0]?.delta?.content;
if (typeof text === 'string' && text) {
controller.enqueue(
encoder.encode(`data: ${JSON.stringify({ delta: { text}})}\n\n`),
);
}
} catch { /* 半包/非 JSON 行直接跳过 */}
};
try {
for (;;) {
const { done, value} = await reader.read();
if (done) break;
buffer += decoder.decode(value, { stream: true});
const lines = buffer.split('\n');
buffer = lines.pop()?? '';
for (const l of lines) pushLine(l);
}
if (buffer.trim()) pushLine(buffer);
} catch { /* 上游中断：直接收尾，前端会保留已收到的文本 */}
try {
controller.enqueue(encoder.encode('data: [DONE]\n\n'));
controller.close();
} catch { /* 客户端已断开 */}
},
cancel() {
reader.cancel().catch(() => undefined);
},
});

return new Response(stream, {
headers: {
'Content-Type': 'text/event-stream; charset=utf-8',
'Cache-Control': 'no-cache, no-transform',
Connection: 'keep-alive',
'X-Accel-Buffering': 'no',
},
});
}
