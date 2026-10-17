const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../kuanping.user.js'), 'utf8');
const capture = source.slice(source.indexOf('    function installCanvasReadingCapture()'), source.indexOf('    function findReadingCharacter('));
const sentence = source.slice(source.indexOf('    function findReadingSentence('), source.indexOf('    function renderReadingMark()'));
class Context {
    constructor(canvas) { this.canvas = canvas; this.globalAlpha = 1; this.textAlign = 'left'; this.direction = 'ltr'; }
    fillText() { this.drawCalls = (this.drawCalls || 0) + 1; }
    clearRect() {}
    reset() {}
    drawImage() {}
    getTransform() { return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }; }
    measureText(text) { return { width: [...text].length * 10, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }; }
}
const canvas = (left = 100) => ({ width: 400, height: 200, isConnected: true,
    getBoundingClientRect: () => ({ left, top: 50, right: left + 200, bottom: 150, width: 200, height: 100 }) });
const context = { canvasReadingText: new WeakMap(), window: { CanvasRenderingContext2D: Context },
    location: { href: '/reader/test' }, getCurrentReviewChapterTitle: () => '测试' };
vm.createContext(context);
vm.runInContext(capture + sentence + '\ninstallCanvasReadingCapture();', context);
const page = canvas();
const ctx = new Context(page);
ctx.fillText('前句。后句，', 0, 10);
ctx.fillText('跨行结束！尾句。', 0, 30);
const host = { querySelectorAll: () => [page] };
let mark = context.findCanvasReadingSentence(host, 135, 55);
assert.equal(mark.canvasRects.map(g => g.text).join(''), '后句');
assert.equal(ctx.drawCalls, 2, 'original canvas rendering is preserved');
assert.equal(context.findCanvasReadingSentence(host, 290, 140), null, 'blank space does not select');
assert.equal(context.canvasGlyphClientRect(mark.canvasRects[0]).left, 130, 'high-DPI coordinates map to CSS pixels');
const wrapped = canvas();
const wrappedContext = new Context(wrapped);
wrappedContext.fillText('跨行的', 0, 10);
wrappedContext.fillText('文字，下一段。', 0, 30);
const wrappedMark = context.findCanvasReadingSentence({ querySelectorAll: () => [wrapped] }, 105, 75);
assert.equal(wrappedMark.canvasRects.map(g => g.text).join(''), '跨行的文字', 'visual wrapping is not punctuation');
const quoted = canvas();
const quotedContext = new Context(quoted);
quotedContext.fillText('前景。 ”', 0, 10);
quotedContext.fillText('一位官员说：新话。', 0, 50);
const quotedMark = context.findCanvasReadingSentence({ querySelectorAll: () => [quoted] }, 115, 95);
assert.equal(quotedMark.canvasRects.map(g => g.text).join(''), '一位官员说', 'previous paragraph closing quote is excluded');
const otherPage = canvas(400);
new Context(otherPage).fillText('不属于左栏。', 0, 10);
mark = context.findCanvasReadingSentence({ querySelectorAll: () => [page, otherPage] }, 135, 55);
assert.equal(mark.canvasRects.map(g => g.text).join(''), '后句', 'separate canvas columns stay separate');
const copy = canvas();
new Context(copy).drawImage(page, 0, 0, 200, 100);
assert.ok(context.canvasReadingText.get(copy).glyphs.length > 0, 'temporary canvas copies retain glyphs');
ctx.clearRect(0, 0, 200, 100);
assert.equal(context.findCanvasReadingSentence(host, 135, 55), null, 'cleared text is no longer clickable');
ctx.fillText('新句。', 0, 10);
page.width = 800;
assert.equal(context.findCanvasReadingSentence(host, 105, 55), null, 'canvas reset invalidates stale glyphs');
for (const [text, clicked, expected] of [
    ['他说：“走吧！”下一句。', '走', '走吧'],
    ['数字3.14，仍在本句。下一句。', '4', '数字3.14'],
    ['等等……真的？！下一句。', '真', '真的'],
    ['前段\n后段', '后', '后段'],
    ['据说，上世纪中叶，核弹引爆时，发生变化。', '引', '核弹引爆时'],
    ['甲；乙：丙、丁。', '乙', '乙'],
    ['甲；乙：丙、丁。', '丁', '丁'],
    ['前景。 ”\n一位联合国官员说：“你们应该放进‘糖衣’中去，下一段。”', '官', '一位联合国官员说'],
    ['前景。 ”一位官员说：“你们应该放进‘糖衣’中去。”', '你', '你们应该放进'],
    ['前景。 ”一位官员说。', '”', '前景'],
    ['甲，乙。', '，', '甲'],
    ['甲（乙）丙——丁', '乙', '乙'],
    ['甲（乙）丙——丁', '丁', '丁'],
    ['Hello, world; next: done!', 'w', 'world'],
    ['“引号内的片段”', '“', '引号内的片段'],
    ['……？！ ”', '”', ''],
]) {
    const range = context.findReadingSentence(text, text.indexOf(clicked));
    assert.equal(text.slice(range.start, range.end), expected);
}
console.log('PASS: canvas capture, coordinates, wrapped sentences, columns, copying, clearing, reset and punctuation');
