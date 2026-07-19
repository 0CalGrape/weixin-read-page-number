// ==UserScript==
// @name    微信读书
// @icon    https://weread.qq.com/favicon.ico
// @namespace    https://greasyfork.org/users/878514
// @version    20260719.16
// @description    经典阅读器宽屏显示、自动阅读、空格翻页、右侧快捷按钮、目录位置调整与原生书友想法；双栏阅读器保留基础布局和书友想法按钮。
// @author    Velens
// @match    https://weread.qq.com/web/reader/*
// @require    https://code.jquery.com/jquery-3.6.0.min.js
// @run-at    document-start
// @license    MIT
// @grant    GM_addStyle
// @grant    GM_registerMenuCommand
// @grant    GM_setValue
// @grant    GM_getValue
// @grant    GM_addElement
// @grant    unsafeWindow
// @sandbox    raw
// @downloadURL https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.user.js
// @updateURL https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.meta.js
// ==/UserScript==


/* globals jQuery, $, waitForKeyElements, unsafeWindow */
const widths = [{titlew:"满列",width:"100%",align_items:"flex-end",margin_left:"45.5%"},{titlew:"宽列",width:"80%",align_items:"center",margin_left:"41.5%"},{titlew:"默认",width:"",align_items:"flex-start",margin_left:""}];
const SCROLL_BOOK_REVIEW_STATE_KEY = "scrollShowBookReviews";
const CATALOG_SHIFT_KEY = "catalogShiftPx";
const SPACE_PLAY_PAUSE_KEY = "spacePlayPauseEnabled";
const MAIN_REVIEW_STATE_ATTR = "data-lv-book-review-state";
const MAIN_REVIEW_COMMAND_ATTR = "data-lv-book-review-command";
const MAIN_REVIEW_COMMAND_EVENT = "lv-book-review-command";
const MAIN_REVIEW_LAYOUT_ATTR = "data-lv-book-review-layout";
const MAIN_REVIEW_LAYOUT_EVENT = "lv-book-review-layout";
const SCROLLBAR_MODES = [
    {title:"滚动条：显示",value:"visible"},
    {title:"滚动条：隐藏",value:"hidden"},
    {title:"滚动条：默认",value:"default"}
];
let iw = GM_getValue("numw",0);
let spacePlayPauseEnabled = GM_getValue(SPACE_PLAY_PAUSE_KEY,true) !== false;
let catalogShiftPx = Number(GM_getValue(CATALOG_SHIFT_KEY,0));
let scrollbarModeIndex = Number(GM_getValue("nums",0));
if(!Number.isFinite(catalogShiftPx)){catalogShiftPx = 0;}
if(!Number.isInteger(scrollbarModeIndex) || scrollbarModeIndex < 0 || scrollbarModeIndex >= SCROLLBAR_MODES.length){
    scrollbarModeIndex = 0;
}
if(widths[iw] && widths[iw].titlew !== "默认"){
    // 必须在微信读书第一次排版前写入宽度，否则正文画布与后加的下划线会使用两套坐标系。
    GM_addStyle(`.readerContent .app_content, .readerTopBar {max-width: ${widths[iw].width};}`);
    GM_addStyle(`.readerControls {align-items: ${widths[iw].align_items};margin-left: ${widths[iw].margin_left};}`);
}
var timePlay,timeStop,timeClick;
var flagPlay = false;
let timeStopmin = GM_getValue("timeStopmin",0);

function shiftCatalog(){
    const catalog = document.querySelector('.readerCatalog');
    if(!catalog){return;}
    catalog.style.setProperty('margin-left', `${catalogShiftPx}px`, 'important');
}

GM_registerMenuCommand(`目录左右偏移：${catalogShiftPx}px`,function(){
    const input = prompt('请输入目录左右偏移量（px；负数向左，正数向右）',String(catalogShiftPx));
    if(input === null){return;}
    const value = Number(input.trim());
    if(!Number.isFinite(value)){
        alert('请输入有效数字。');
        return;
    }
    catalogShiftPx = Math.round(value);
    GM_setValue(CATALOG_SHIFT_KEY,catalogShiftPx);
    shiftCatalog();
});

function initCatalogShift(){
    let scheduled = false;
    const scheduleShift = function(){
        if(scheduled){return;}
        scheduled = true;
        window.requestAnimationFrame(function(){
            scheduled = false;
            shiftCatalog();
        });
    };

    scheduleShift();
    window.addEventListener('resize', scheduleShift, {passive: true});
    new MutationObserver(scheduleShift).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
}

if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initCatalogShift, {once: true});
}else{
    initCatalogShift();
}

// 深色模式下微信读书会把正文图片降到 50% 不透明度，导致插图明显变暗。
// 浅色模式使用 wr_whiteTheme，因而只在非浅色主题中恢复图片原始明度。
GM_addStyle(`
    body:not(.wr_whiteTheme) .readerChapterContent img.wr_readerImage_opacity,
    body:not(.wr_whiteTheme) .renderTargetContent img.wr_readerImage_opacity {
        opacity: 1 !important;
        filter: none !important;
    }
`);

function isEditableTarget(target){
    if(!target){return false;}
    const tagName = target.tagName;
    return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

let scrollBookReviewsEnabled = Boolean(GM_getValue(SCROLL_BOOK_REVIEW_STATE_KEY,false));
let scrollBookReviewsRequestId = 0;
let scrollReaderVm = null;
let scrollBookReviewDataKey = '';
let scrollBookReviewData = [];
let scrollBookReviewDataPromise = null;
let scrollBookReviewDataPromiseKey = '';
let scrollBookReviewRenderTimer = 0;
let scrollBookReviewRenderEpoch = 0;
let scrollReaderVmLookupAttempts = 0;
let scrollBookReviewLastDataLogKey = '';
let scrollBookReviewObserverStarted = false;
let scrollBookReviewLastRenderLogKey = '';
let scrollBookReviewLastWaitingLogKey = '';
let scrollBookReviewLastChapterTitle = '';
let bookReviewControlLastHorizontal = null;
let simulatedHorizontalReviewKey = '';
let simulatedHorizontalReviewData = null;
let simulatedHorizontalReviewPromise = null;
let simulatedHorizontalReviewController = null;
let mainBookReviewLayoutRaw = '';
let mainBookReviewLayoutCache = null;
let lastLayoutCaptureRequestAt = 0;
const simulatedReviewPagePromises = new Map();
const observedReaderBookIds = [];

function recordReaderBookIdFromRequest(requestUrl){
    try{
        const url = new URL(requestUrl,location.origin);
        if(!/^\/web\/book\/(?:info|readInfo|underlines)$/.test(url.pathname)){return;}
        const bookId = url.searchParams.get('bookId');
        if(bookId && !observedReaderBookIds.includes(bookId)){observedReaderBookIds.push(bookId);}
    }catch(error){}
}

try{
    performance.getEntriesByType('resource').forEach(function(entry){recordReaderBookIdFromRequest(entry.name);});
    new PerformanceObserver(function(list){
        list.getEntries().forEach(function(entry){recordReaderBookIdFromRequest(entry.name);});
    }).observe({type:'resource',buffered:true});
}catch(error){
    console.warn('[weixin-read-wide] 无法监听书籍信息请求 ' + JSON.stringify({message:String(error)}));
}

GM_addStyle(`
    .lv-scroll-book-review-underlines {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
    }
    .lv-scroll-book-review-underlines > .wr_underline_wrapper {
        pointer-events: auto;
    }
    .lv-simulated-book-review-panel {
        position: fixed;
        z-index: 10020;
        box-sizing: border-box;
        width: 440px;
        max-height: min(620px, 78vh);
        padding: 14px 16px 16px;
        overflow: visible;
        border-radius: 14px;
        background: #252527;
        color: #d8d8dc;
        box-shadow: 0 12px 38px rgba(0,0,0,.38);
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        font-size: 14px;
    }
    .wr_whiteTheme .lv-simulated-book-review-panel {
        background: #fff;
        color: #2b2b2b;
        box-shadow: 0 8px 30px rgba(0,0,0,.16);
    }
    .lv-simulated-book-review-panel::after {
        position: absolute;
        top: var(--lv-arrow-top, 110px);
        width: 0;
        height: 0;
        border: 10px solid transparent;
        content: "";
    }
    .lv-simulated-book-review-panel--left::after {right: -19px;border-left-color: #252527;}
    .lv-simulated-book-review-panel--right::after {left: -19px;border-right-color: #252527;}
    .wr_whiteTheme .lv-simulated-book-review-panel--left::after {border-left-color: #fff;}
    .wr_whiteTheme .lv-simulated-book-review-panel--right::after {border-right-color: #fff;}
    .lv-simulated-book-review-panel__header {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        padding-bottom: 10px;
        font-size: 18px;
        font-weight: 500;
    }
    .lv-simulated-book-review-panel__close {
        position: absolute;
        top: -4px;
        right: -4px;
        border: 0;
        width: 32px;
        height: 32px;
        padding: 0;
        background: transparent;
        color: inherit;
        font-size: 30px;
        font-weight: 200;
        line-height: 1;
        cursor: pointer;
        opacity: .56;
    }
    .lv-simulated-book-review-panel__actions {
        display: grid;
        grid-template-columns: repeat(4,1fr);
        gap: 2px;
        margin-bottom: 14px;
        padding: 10px 6px 9px;
        border-radius: 12px;
        background: #3b3b3f;
    }
    .wr_whiteTheme .lv-simulated-book-review-panel__actions {background: #f5f5f7;}
    .lv-simulated-book-review-panel__action {
        display: flex;
        align-items: center;
        flex-direction: column;
        justify-content: center;
        gap: 5px;
        height: 72px;
        border: 0;
        background: transparent;
        color: inherit;
        font-size: 13px;
        cursor: default;
    }
    .lv-simulated-book-review-panel__action svg {
        width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:.94;
    }
    .lv-simulated-book-review-panel__list {
        max-height: calc(min(620px, 78vh) - 150px);
        margin: 0;
        padding: 0;
        overflow: auto;
        list-style: none;
    }
    .lv-simulated-book-review-panel__item {
        margin-bottom: 10px;
        padding: 16px;
        border-radius: 12px;
        background: #3b3b3f;
    }
    .wr_whiteTheme .lv-simulated-book-review-panel__item {background: #f5f5f7;}
    .lv-simulated-book-review-panel__author-row {display:flex;align-items:center;gap:10px;margin-bottom:10px;}
    .lv-simulated-book-review-panel__avatar {
        width: 25px;
        height: 25px;
        flex: 0 0 25px;
        border-radius: 50%;
        background: #71c7e6;
        object-fit: cover;
    }
    .lv-simulated-book-review-panel__author {font-size: 13px;opacity: .58;}
    .lv-simulated-book-review-panel__content {font-size: 17px;line-height: 1.6;white-space: pre-wrap;word-break: break-word;}
    .lv-simulated-book-review-panel__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 14px;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,.08);
        color: rgba(255,255,255,.48);
    }
    .wr_whiteTheme .lv-simulated-book-review-panel__footer {border-top-color: rgba(0,0,0,.08);color: rgba(0,0,0,.42);}
    .lv-simulated-book-review-panel__metric {display:flex;align-items:center;gap:7px;min-width:36px;}
    .lv-simulated-book-review-panel__metric svg {width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;}
    .lv-simulated-book-review-panel__empty {padding: 54px 18px;border-radius:12px;background:#3b3b3f;text-align:center;opacity:.65;}
    .wr_whiteTheme .lv-simulated-book-review-panel__empty {background:#f5f5f7;}
`);

function getReaderPageWindow(){
    return typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
}

console.info('[weixin-read-wide] v20260719.16 已加载 ' + JSON.stringify({
    pageWorld:getReaderPageWindow() === window
}));

function mainWorldBookReviewBridge(captureInitially){
    if(window.__lvBookReviewBridgeStarted){return;}
    window.__lvBookReviewBridgeStarted = true;
    const capturedVueInstances = window.__lvCapturedVueInstances || new Set();
    window.__lvCapturedVueInstances = capturedVueInstances;
    const stateAttribute = 'data-lv-book-review-state';
    const commandAttribute = 'data-lv-book-review-command';
    const commandEvent = 'lv-book-review-command';
    const layoutAttribute = 'data-lv-book-review-layout';
    const layoutEvent = 'lv-book-review-layout';
    let root = document.documentElement;
    let readerVm = null;
    let dataKey = '';
    let cachedUnderlines = [];
    let renderTimer = 0;
    let lookupAttempt = 0;
    let lastDataLogKey = '';
    let lastFailureLogKey = '';
    const layoutRecords = new Map();
    let layoutPublishTimer = 0;
    let layoutSignature = '';
    let layoutTitle = '';
    let layoutWidth = 0;
    let layoutHeight = 0;
    let lastLayoutPublishedCount = -1;
    let cachedLayoutRoot = null;
    let cachedLayoutRootRect = null;
    let cachedLayoutRootRectAt = 0;
    let cachedLayoutChapterTitle = '';
    let layoutCaptureActive = false;
    const nativeElementGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const nativeElementGetClientRects = Element.prototype.getClientRects;
    const nativeRangeGetBoundingClientRect = typeof Range !== 'undefined' && Range.prototype.getBoundingClientRect;
    const nativeRangeGetClientRects = typeof Range !== 'undefined' && Range.prototype.getClientRects;

    function getLayoutChapterTitle(){
        const title = document.querySelector('.readerTopBar_title_link');
        return title && title.textContent ? title.textContent.trim() : '';
    }

    function getLayoutRootMetrics(){
        // 临时的 renderTargetContent 在排版阶段可能是 0×0；双栏/原生划线均以可见正文容器为坐标原点。
        const now = Date.now();
        let renderRoot = cachedLayoutRoot && cachedLayoutRoot.isConnected ? cachedLayoutRoot : null;
        if(!renderRoot && now-cachedLayoutRootRectAt > 16){
            renderRoot = document.querySelector('.renderTargetContainer');
            cachedLayoutRootRectAt = now;
        }
        if(!renderRoot){return null;}
        if(renderRoot !== cachedLayoutRoot || !cachedLayoutRootRect || now-cachedLayoutRootRectAt > 16){
            cachedLayoutRoot = renderRoot;
            cachedLayoutRootRect = nativeElementGetBoundingClientRect.call(renderRoot);
            cachedLayoutRootRectAt = now;
            cachedLayoutChapterTitle = getLayoutChapterTitle();
        }
        if(!cachedLayoutRootRect || Number(cachedLayoutRootRect.width) <= 0 || Number(cachedLayoutRootRect.height) <= 0){return null;}
        return {rect:cachedLayoutRootRect,title:cachedLayoutChapterTitle};
    }

    function publishLayoutSnapshot(){
        window.clearTimeout(layoutPublishTimer);
        layoutPublishTimer = 0;
        const documentRoot = document.documentElement;
        if(!documentRoot || !layoutRecords.size){return;}
        const rootMetrics = getLayoutRootMetrics();
        if(!rootMetrics){
            layoutPublishTimer = window.setTimeout(publishLayoutSnapshot,100);
            return;
        }
        const rootRect = rootMetrics.rect;
        layoutTitle = rootMetrics.title || layoutTitle;
        layoutWidth = Math.round(Number(rootRect.width) * 100) / 100;
        layoutHeight = Math.round(Number(rootRect.height) * 100) / 100;
        const normalizedRecords = new Map();
        Array.from(layoutRecords.values()).forEach(function(record){
            const normalized = record.slice();
            if(normalized[6] !== 1){
                normalized[2] = Math.round((Number(normalized[2])-Number(rootRect.left))*100)/100;
                normalized[3] = Math.round((Number(normalized[3])-Number(rootRect.top))*100)/100;
                normalized[6] = 1;
            }
            const key = `${normalized[0]}:${normalized[2]}:${normalized[3]}:${normalized[4]}:${normalized[5]}`;
            normalizedRecords.set(key,normalized);
        });
        layoutRecords.clear();
        normalizedRecords.forEach(function(record,key){layoutRecords.set(key,record);});
        const items = Array.from(layoutRecords.values()).slice(0,30000).map(function(record){return record.slice(0,6);});
        documentRoot.setAttribute(layoutAttribute,JSON.stringify({
            updatedAt:Date.now(),title:layoutTitle,width:layoutWidth,height:layoutHeight,items:items
        }));
        document.dispatchEvent(new CustomEvent(layoutEvent));
        if(lastLayoutPublishedCount !== items.length){
            lastLayoutPublishedCount = items.length;
            console.info('[weixin-read-wide] 正文坐标捕获统计 ' + JSON.stringify({
                title:layoutTitle,objectCount:items.length,width:layoutWidth,height:layoutHeight
            }));
        }
    }

    function scheduleLayoutSnapshot(){
        window.clearTimeout(layoutPublishTimer);
        layoutPublishTimer = window.setTimeout(publishLayoutSnapshot,80);
    }

    function getLayoutElement(node){
        let element = node && node.nodeType === 1 ? node : node && node.parentElement;
        for(let depth=0;element && depth<3;depth++,element=element.parentElement){
            if(element.getAttribute && element.getAttribute('data-wr-id') === 'layout' && element.hasAttribute('data-wr-co')){
                return element;
            }
        }
        return null;
    }

    function captureLayoutRects(node,rects){
        if(!layoutCaptureActive){return;}
        try{
            const element = getLayoutElement(node);
            if(!element){return;}
            const offset = Number(element.getAttribute('data-wr-co'));
            if(!Number.isFinite(offset)){return;}
            const rootMetrics = getLayoutRootMetrics();
            const rootRect = rootMetrics && rootMetrics.rect;
            const title = rootMetrics && rootMetrics.title || getLayoutChapterTitle();
            const signature = title || layoutSignature;
            if(layoutSignature && signature && layoutSignature !== signature){
                layoutRecords.clear();
                lastLayoutPublishedCount = -1;
            }
            layoutSignature = signature;
            layoutTitle = title || layoutTitle;
            if(rootRect){
                layoutWidth = Math.round(Number(rootRect.width) * 100) / 100;
                layoutHeight = Math.round(Number(rootRect.height) * 100) / 100;
            }
            const declaredLength = Number(element.getAttribute('data-wr-len') || element.getAttribute('data-wr-co-len'));
            const textLength = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength :
                Math.max(1,String(element.textContent || element.getAttribute('alt') || '').length);
            Array.from(rects || []).forEach(function(rect){
                const left = Number(rect.left) - Number(rootRect && rootRect.left || 0);
                const top = Number(rect.top) - Number(rootRect && rootRect.top || 0);
                const rectWidth = Number(rect.width);
                const rectHeight = Number(rect.height);
                if(![left,top,rectWidth,rectHeight].every(Number.isFinite) || rectWidth <= 0 || rectHeight <= 0){return;}
                const rounded = [offset,textLength,left,top,rectWidth,rectHeight].map(function(value,index){
                    return index < 2 ? value : Math.round(value * 100) / 100;
                });
                rounded.push(rootRect ? 1 : 0);
                const key = `${rounded[0]}:${rounded[2]}:${rounded[3]}:${rounded[4]}:${rounded[5]}`;
                layoutRecords.set(key,rounded);
            });
            if(layoutRecords.size){scheduleLayoutSnapshot();}
        }catch(error){}
    }

    function capturedElementGetBoundingClientRect(){
        const rect = nativeElementGetBoundingClientRect.call(this);
        captureLayoutRects(this,[rect]);
        return rect;
    }

    function capturedElementGetClientRects(){
        const rects = nativeElementGetClientRects.call(this);
        captureLayoutRects(this,rects);
        return rects;
    }

    function capturedRangeGetBoundingClientRect(){
        const rect = nativeRangeGetBoundingClientRect.call(this);
        captureLayoutRects(this.commonAncestorContainer,[rect]);
        return rect;
    }

    function capturedRangeGetClientRects(){
        const rects = nativeRangeGetClientRects.call(this);
        captureLayoutRects(this.commonAncestorContainer,rects);
        return rects;
    }

    function stopLayoutCapture(){
        if(!layoutCaptureActive){return;}
        layoutCaptureActive = false;
        if(Element.prototype.getBoundingClientRect === capturedElementGetBoundingClientRect){
            Element.prototype.getBoundingClientRect = nativeElementGetBoundingClientRect;
        }
        if(Element.prototype.getClientRects === capturedElementGetClientRects){
            Element.prototype.getClientRects = nativeElementGetClientRects;
        }
        if(nativeRangeGetBoundingClientRect && Range.prototype.getBoundingClientRect === capturedRangeGetBoundingClientRect){
            Range.prototype.getBoundingClientRect = nativeRangeGetBoundingClientRect;
        }
        if(nativeRangeGetClientRects && Range.prototype.getClientRects === capturedRangeGetClientRects){
            Range.prototype.getClientRects = nativeRangeGetClientRects;
        }
    }

    function startLayoutCapture(rerender){
        stopLayoutCapture();
        layoutRecords.clear();
        layoutSignature = '';
        layoutTitle = '';
        layoutWidth = 0;
        layoutHeight = 0;
        lastLayoutPublishedCount = -1;
        cachedLayoutRoot = null;
        cachedLayoutRootRect = null;
        cachedLayoutRootRectAt = 0;
        const documentRoot = document.documentElement;
        if(documentRoot){documentRoot.removeAttribute(layoutAttribute);}
        try{
            layoutCaptureActive = true;
            Element.prototype.getBoundingClientRect = capturedElementGetBoundingClientRect;
            Element.prototype.getClientRects = capturedElementGetClientRects;
            if(nativeRangeGetBoundingClientRect){Range.prototype.getBoundingClientRect = capturedRangeGetBoundingClientRect;}
            if(nativeRangeGetClientRects){Range.prototype.getClientRects = capturedRangeGetClientRects;}
            if(rerender){window.setTimeout(function(){window.dispatchEvent(new Event('resize'));},0);}
        }catch(error){
            stopLayoutCapture();
            console.warn('[weixin-read-wide] 正文坐标按需捕获失败 ' + JSON.stringify({message:String(error)}));
        }
    }

    function isReaderVm(vm){
        return Boolean(vm && !vm._isDestroyed && vm.$store && vm.$refs && vm.$refs.renderTargetContainer &&
            typeof vm.getCurrentDisplayRenderContents === 'function' &&
            typeof vm.getBookUnderlinesByRangeOfChapter === 'function' &&
            typeof vm.handleClickRange === 'function');
    }

    function findReaderVm(){
        if(isReaderVm(readerVm) && readerVm.$el && readerVm.$el.isConnected){return readerVm;}
        const queue = Array.from(capturedVueInstances);
        const visited = new Set();
        document.querySelectorAll('*').forEach(function(element){
            if(element.__vue__){queue.push(element.__vue__);}
        });
        while(queue.length){
            const vm = queue.shift();
            if(!vm || visited.has(vm)){continue;}
            visited.add(vm);
            if(isReaderVm(vm)){readerVm = vm;return vm;}
            if(vm.$parent){queue.push(vm.$parent);}
            if(Array.isArray(vm.$children)){queue.push.apply(queue,vm.$children);}
        }
        readerVm = null;
        return null;
    }

    function setState(state){
        root = root || document.documentElement;
        if(!root){return;}
        root.setAttribute(stateAttribute,JSON.stringify(Object.assign({updatedAt:Date.now()},state)));
    }

    function normalizeRange(value){
        const range = value && value.range !== undefined ? value.range : value;
        if(typeof range === 'string'){
            const parts = range.split('-');
            if(parts.length !== 2){return null;}
            const start = Number(parts[0]);
            const end = Number(parts[1]);
            return Number.isFinite(start) && Number.isFinite(end) && end > start ? {start:start,end:end} : null;
        }
        if(!range || typeof range !== 'object'){return null;}
        const start = Number(range.start);
        const end = Number(range.end);
        return Number.isFinite(start) && Number.isFinite(end) && end > start ? {start:start,end:end} : null;
    }

    function getOffset(object){
        if(!object){return NaN;}
        if(typeof object.getOffset === 'function'){
            try{return Number(object.getOffset());}catch(error){return NaN;}
        }
        return Number(object._offset);
    }

    function findObjects(contents,range,chapterUid){
        return (Array.isArray(contents) ? contents : []).filter(function(object){
            const offset = getOffset(object);
            const sameChapter = object && (object.chapterUid === undefined || String(object.chapterUid) === String(chapterUid));
            return sameChapter && Number.isFinite(offset) && offset >= range.start && offset < range.end;
        }).sort(function(a,b){return getOffset(a)-getOffset(b);});
    }

    function getRectCss(rect){
        if(rect && typeof rect.toCSSPositionString === 'function'){
            try{return rect.toCSSPositionString();}catch(error){}
        }
        const left = Number(rect && (rect.x !== undefined ? rect.x : rect.left));
        const top = Number(rect && (rect.y !== undefined ? rect.y : rect.top));
        const width = Number(rect && (rect.width !== undefined ? rect.width : rect.w));
        const height = Number(rect && (rect.height !== undefined ? rect.height : rect.h));
        if(![left,top,width,height].every(Number.isFinite) || width <= 0 || height <= 0){return '';}
        return `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
    }

    async function fetchUnderlinesDirect(bookId,chapterUid){
        const url = new URL('/web/book/underlines',location.origin);
        url.searchParams.set('bookId',String(bookId));
        url.searchParams.set('chapterUid',String(chapterUid));
        const response = await fetch(url.toString(),{credentials:'include'});
        const payload = await response.json();
        if(!response.ok || Number(payload && payload.errCode || 0) !== 0){
            throw new Error(`HTTP ${response.status}, errCode ${payload && payload.errCode}`);
        }
        if(payload && Array.isArray(payload.underlines)){return payload.underlines;}
        return payload && payload.data && Array.isArray(payload.data.underlines) ? payload.data.underlines : [];
    }

    async function loadUnderlines(vm,bookId,chapterUid,force){
        const key = `${bookId}:${chapterUid}`;
        if(!force && dataKey === key){return {data:cachedUnderlines,source:'cache'};}
        let underlines = [];
        let source = 'vuex';
        try{
            await vm.$store.dispatch('ACTION_SYNC_BOOK_UNDERLINE',{bookId:bookId,chapterUid:chapterUid});
            underlines = vm.getBookUnderlinesByRangeOfChapter(chapterUid,0,Number.MAX_SAFE_INTEGER) || [];
        }catch(error){
            source = 'direct';
        }
        if(!Array.isArray(underlines) || !underlines.length){
            source = 'direct';
            underlines = await fetchUnderlinesDirect(bookId,chapterUid);
        }
        dataKey = key;
        cachedUnderlines = Array.isArray(underlines) ? underlines : [];
        return {data:cachedUnderlines,source:source};
    }

    async function publish(forceData){
        const vm = findReaderVm();
        if(!vm){
            lookupAttempt++;
            const vueElementCount = Array.from(document.querySelectorAll('*')).filter(function(element){return Boolean(element.__vue__);}).length;
            const capturedVueCount = capturedVueInstances.size;
            const failureKey = `${lookupAttempt < 10 ? 'waiting' : 'failed'}:${vueElementCount}:${capturedVueCount}`;
            setState({status:'waiting',reason:'reader-vue-not-found',attempt:lookupAttempt,vueElementCount:vueElementCount,capturedVueCount:capturedVueCount});
            if((lookupAttempt === 1 || lookupAttempt === 10) && lastFailureLogKey !== failureKey){
                lastFailureLogKey = failureKey;
                console.warn('[weixin-read-wide] 书友想法获取失败 ' + JSON.stringify({
                    reason:'reader-vue-not-found',attempt:lookupAttempt,vueElementCount:vueElementCount,capturedVueCount:capturedVueCount
                }));
            }
            schedule(500);
            return;
        }
        lookupAttempt = 0;
        const bookId = vm.bookId;
        const chapterUid = vm.currentChapterUid;
        if(bookId === undefined || chapterUid === undefined || chapterUid === null){
            setState({status:'waiting',reason:'chapter-not-ready'});
            schedule(300);
            return;
        }

        let loaded;
        try{
            loaded = await loadUnderlines(vm,bookId,chapterUid,Boolean(forceData));
        }catch(error){
            const summary = {reason:'request-failed',bookId:String(bookId),chapterUid:String(chapterUid),message:String(error)};
            setState(Object.assign({status:'error'},summary));
            console.warn('[weixin-read-wide] 书友想法获取失败 ' + JSON.stringify(summary));
            return;
        }

        const contents = vm.getCurrentDisplayRenderContents() || [];
        const items = [];
        let matchedRangeCount = 0;
        let rectCount = 0;
        const seen = new Set();
        loaded.data.forEach(function(underline){
            const range = normalizeRange(underline);
            if(!range){return;}
            const rangeText = `${range.start}-${range.end}`;
            if(seen.has(rangeText)){return;}
            seen.add(rangeText);
            const objects = findObjects(contents,range,chapterUid);
            if(!objects.length){return;}
            let rects = [];
            try{rects = vm.getRectsByContentObjs(objects) || [];}catch(error){rects = objects.map(function(object){return object && object.rect;});}
            const cssRects = rects.map(getRectCss).filter(Boolean);
            if(!cssRects.length){return;}
            items.push({range:rangeText,start:range.start,end:range.end,rects:cssRects});
            matchedRangeCount++;
            rectCount += cssRects.length;
        });
        const stats = {
            bookId:String(bookId),chapterUid:String(chapterUid),source:loaded.source,
            underlineCount:loaded.data.length,contentObjectCount:Array.isArray(contents) ? contents.length : 0,
            matchedRangeCount:matchedRangeCount,rectCount:rectCount,enabled:Boolean(vm.isShowBookReviews)
        };
        setState(Object.assign({status:'ready',items:items},stats));
        const logKey = JSON.stringify(stats);
        if(lastDataLogKey !== logKey){
            lastDataLogKey = logKey;
            console.info('[weixin-read-wide] 书友想法数据统计 ' + logKey);
        }
    }

    function schedule(delay,forceData){
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(function(){publish(Boolean(forceData));},delay === undefined ? 120 : delay);
    }

    async function handleCommand(){
        let command;
        root = root || document.documentElement;
        if(!root){return;}
        try{command = JSON.parse(root.getAttribute(commandAttribute) || '{}');}catch(error){return;}
        if(command.type === 'capture-layout'){
            startLayoutCapture(Boolean(command.rerender));
            return;
        }
        if(command.type === 'stop-layout-capture'){
            stopLayoutCapture();
            return;
        }
        const vm = findReaderVm();
        if(!vm){return;}
        if(command.type === 'toggle'){
            const desired = Boolean(command.enabled);
            try{
                await vm.$store.dispatch('MODIFY_USER_CONFIG',{displayTopReview:desired ? 1 : 0});
                await vm.$store.dispatch('FETCH_USER_CONFIG');
                console.info('[weixin-read-wide] 书友想法切换统计 ' + JSON.stringify({
                    requested:desired,actual:Boolean(vm.isShowBookReviews),success:Boolean(vm.isShowBookReviews) === desired
                }));
                schedule(100,true);
            }catch(error){
                console.warn('[weixin-read-wide] 书友想法切换失败 ' + JSON.stringify({requested:desired,message:String(error)}));
            }
        }else if(command.type === 'open'){
            try{
                vm.handleClickRange(Number(command.start),Number(command.end),{
                    chapterUid:vm.currentChapterUid,
                    event:{clientX:Number(command.clientX),clientY:Number(command.clientY)},
                    isRefresh:false
                });
            }catch(error){
                console.warn('[weixin-read-wide] 打开书友想法失败 ' + JSON.stringify({message:String(error)}));
            }
        }else if(command.type === 'refresh'){
            schedule(0,Boolean(command.forceData));
        }
    }

    document.addEventListener(commandEvent,handleCommand);
    const activateBridge = function(){
        root = root || document.documentElement;
        if(!root){window.setTimeout(activateBridge,0);return;}
        setState({status:'bridge-ready',mode:'on-demand'});
        if(captureInitially){startLayoutCapture(false);}
    };
    activateBridge();
}

function injectMainWorldBookReviewBridge(){
    const source = `;(${mainWorldBookReviewBridge.toString()})(${scrollBookReviewsEnabled ? 'true' : 'false'});`;
    try{
        if(typeof GM_addElement === 'function'){
            const script = document.documentElement ?
                GM_addElement(document.documentElement,'script',{textContent:source}) :
                GM_addElement('script',{textContent:source});
            if(script){window.setTimeout(function(){script.remove();},1000);}
        }else{
            const script = document.createElement('script');
            script.textContent = source;
            document.documentElement.appendChild(script);
            script.remove();
        }
    }catch(error){
        console.warn('[weixin-read-wide] 页面主环境桥接注入失败 ' + JSON.stringify({message:String(error)}));
    }
    window.setTimeout(function(){
        if(!document.documentElement.hasAttribute(MAIN_REVIEW_STATE_ATTR)){
            console.warn('[weixin-read-wide] 页面主环境桥接未启动');
        }
    },1000);
}

injectMainWorldBookReviewBridge();

function getMainBookReviewState(){
    try{return JSON.parse(document.documentElement.getAttribute(MAIN_REVIEW_STATE_ATTR) || 'null');}
    catch(error){return null;}
}

function getMainBookReviewLayout(){
    const raw = document.documentElement.getAttribute(MAIN_REVIEW_LAYOUT_ATTR) || '';
    if(raw === mainBookReviewLayoutRaw){return mainBookReviewLayoutCache;}
    mainBookReviewLayoutRaw = raw;
    try{mainBookReviewLayoutCache = raw ? JSON.parse(raw) : null;}
    catch(error){mainBookReviewLayoutCache = null;}
    return mainBookReviewLayoutCache;
}

function sendMainBookReviewCommand(command){
    document.documentElement.setAttribute(MAIN_REVIEW_COMMAND_ATTR,JSON.stringify(Object.assign({id:Date.now()},command)));
    document.dispatchEvent(new CustomEvent(MAIN_REVIEW_COMMAND_EVENT));
}

function requestMainBookReviewLayoutCapture(force){
    const now = Date.now();
    if(!force && now-lastLayoutCaptureRequestAt < 2500){return;}
    lastLayoutCaptureRequestAt = now;
    mainBookReviewLayoutRaw = '';
    mainBookReviewLayoutCache = null;
    sendMainBookReviewCommand({type:'capture-layout',rerender:true});
}

function hasNativeBookReviewUnderlines(){
    return Array.from(document.querySelectorAll('.renderTargetContainer .wr_underline_thought')).some(function(underline){
        return !underline.closest('.lv-scroll-book-review-underlines');
    });
}

function isScrollReaderVue(vm){
    return Boolean(vm && vm.$store && vm.$refs &&
        typeof vm.getCurrentDisplayRenderContents === 'function' &&
        typeof vm.getBookUnderlinesByRangeOfChapter === 'function' &&
        typeof vm.handleClickRange === 'function');
}

function getPageVueFromElement(element,pageWindow){
    if(!element){return null;}
    // @sandbox raw 下可以直接读取页面主环境的 Vue expando；Reflect 是旧版 Tampermonkey 的兼容兜底。
    try{
        if(element.__vue__){return element.__vue__;}
    }catch(error){}
    try{
        const vm = pageWindow.Reflect.get(element,'__vue__');
        if(vm){return vm;}
    }catch(error){}
    return null;
}

function findScrollReaderVueInPageWorld(pageWindow){
    try{
        const finder = pageWindow.Function(`
            const visited = new Set();
            const queue = [];
            document.querySelectorAll('*').forEach(function(element){
                if(element.__vue__){queue.push(element.__vue__);}
            });
            while(queue.length){
                const vm = queue.shift();
                if(!vm || visited.has(vm)){continue;}
                visited.add(vm);
                if(vm.$store && vm.$refs &&
                    typeof vm.getCurrentDisplayRenderContents === 'function' &&
                    typeof vm.getBookUnderlinesByRangeOfChapter === 'function' &&
                    typeof vm.handleClickRange === 'function'){
                    return vm;
                }
                if(vm.$parent){queue.push(vm.$parent);}
                if(Array.isArray(vm.$children)){queue.push.apply(queue,vm.$children);}
            }
            return null;
        `);
        return finder();
    }catch(error){
        if(scrollReaderVmLookupAttempts === 0){
            console.warn('[weixin-read-wide] 页面主环境 Vue 扫描失败',error);
        }
        return null;
    }
}

function findScrollReaderVue(){
    if(isScrollReaderVue(scrollReaderVm) && scrollReaderVm.$el && scrollReaderVm.$el.isConnected){
        return scrollReaderVm;
    }

    const pageDocument = getReaderPageWindow().document;
    const visited = new Set();
    const queue = [];
    const preferredElements = pageDocument.querySelectorAll([
        '.readerChapterContent',
        '.renderTargetContainer',
        '.renderTargetContent',
        '.readerContent',
        '#app',
        'body'
    ].join(','));

    const addVue = function(element){
        const vm = getPageVueFromElement(element,getReaderPageWindow());
        if(vm){queue.push(vm);}
    };
    preferredElements.forEach(addVue);
    if(!queue.length){pageDocument.querySelectorAll('*').forEach(addVue);}

    while(queue.length){
        const vm = queue.shift();
        if(!vm || visited.has(vm)){continue;}
        visited.add(vm);
        if(isScrollReaderVue(vm)){
            scrollReaderVm = vm;
            scrollReaderVmLookupAttempts = 0;
            return vm;
        }
        if(vm.$parent){queue.push(vm.$parent);}
        if(Array.isArray(vm.$children)){queue.push(...vm.$children);}
    }
    const pageWorldVm = findScrollReaderVueInPageWorld(getReaderPageWindow());
    if(isScrollReaderVue(pageWorldVm)){
        scrollReaderVm = pageWorldVm;
        scrollReaderVmLookupAttempts = 0;
        return pageWorldVm;
    }
    scrollReaderVm = null;
    scrollReaderVmLookupAttempts++;
    if(scrollReaderVmLookupAttempts === 1 || scrollReaderVmLookupAttempts === 10){
        console.warn('[weixin-read-wide] 正在等待微信读书正文渲染器 ' + JSON.stringify({
            attempt:scrollReaderVmLookupAttempts,
            canvasCount:document.querySelectorAll('.wr_canvasContainer canvas').length,
            pageWorld:getReaderPageWindow() === window,
            vueElementCount:Array.from(pageDocument.querySelectorAll('*')).filter(function(element){
                try{return Boolean(element.__vue__);}catch(error){return false;}
            }).length
        }));
    }
    return null;
}

function getScrollRenderContainer(vm){
    const container = vm && vm.$refs && vm.$refs.renderTargetContainer;
    return container && container.nodeType === 1 ? container : document.querySelector('.renderTargetContainer');
}

function clearScrollBookReviewUnderlines(){
    document.querySelectorAll('.lv-scroll-book-review-underlines').forEach(function(layer){layer.remove();});
    document.querySelectorAll('.lv-simulated-book-review-panel').forEach(function(panel){panel.remove();});
}

function cancelPendingBookReviewRender(){
    scrollBookReviewRenderEpoch++;
    window.clearTimeout(scrollBookReviewRenderTimer);
    if(simulatedHorizontalReviewController){simulatedHorizontalReviewController.abort();}
    if(document.documentElement){sendMainBookReviewCommand({type:'stop-layout-capture'});}
}

function scheduleScrollBookReviewUnderlines(delay){
    window.clearTimeout(scrollBookReviewRenderTimer);
    scrollBookReviewRenderTimer = window.setTimeout(renderScrollBookReviewUnderlines,delay === undefined ? 120 : delay);
}

function normalizeBookReviewRange(value){
    const range = value && value.range !== undefined ? value.range : value;
    if(typeof range === 'string'){
        const parts = range.split('-');
        if(parts.length !== 2){return null;}
        const start = Number(parts[0]);
        const end = Number(parts[1]);
        return Number.isFinite(start) && Number.isFinite(end) && end > start ? {start:start,end:end} : null;
    }
    if(!range || typeof range !== 'object'){return null;}
    const start = Number(range.start);
    const end = Number(range.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? {start:start,end:end} : null;
}

function getContentObjectOffset(object){
    if(!object){return NaN;}
    if(typeof object.getOffset === 'function'){
        try{return Number(object.getOffset());}catch(error){return NaN;}
    }
    return Number(object._offset);
}

function getObjectsInBookReviewRange(contents,range,chapterUid){
    return (Array.isArray(contents) ? contents : []).filter(function(object){
        const offset = getContentObjectOffset(object);
        return String(object && object.chapterUid) === String(chapterUid) &&
            Number.isFinite(offset) && offset >= range.start && offset < range.end;
    }).sort(function(a,b){return getContentObjectOffset(a) - getContentObjectOffset(b);});
}

function getNativeContentRects(vm,objects){
    if(vm && typeof vm.getRectsByContentObjs === 'function'){
        try{
            const rects = vm.getRectsByContentObjs(objects);
            if(Array.isArray(rects) && rects.length){return rects;}
        }catch(error){
            console.debug('[weixin-read-wide] 使用阅读器合并坐标失败，改用原始坐标',error);
        }
    }
    return objects.map(function(object){return object && object.rect;}).filter(Boolean);
}

function getRectNumber(rect,names){
    for(const name of names){
        const value = Number(rect && rect[name]);
        if(Number.isFinite(value)){return value;}
    }
    return NaN;
}

function getRectCssText(rect){
    if(rect && typeof rect.toCSSPositionString === 'function'){
        try{return rect.toCSSPositionString();}catch(error){}
    }
    const left = getRectNumber(rect,['x','left']);
    const top = getRectNumber(rect,['y','top']);
    let width = getRectNumber(rect,['width','w']);
    let height = getRectNumber(rect,['height','h']);
    if(!Number.isFinite(width)){
        const right = getRectNumber(rect,['right']);
        width = right - left;
    }
    if(!Number.isFinite(height)){
        const bottom = getRectNumber(rect,['bottom']);
        height = bottom - top;
    }
    if(![left,top,width,height].every(Number.isFinite) || width <= 0 || height <= 0){return '';}
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
}

function getPlainRect(rect){
    const left = getRectNumber(rect,['x','left']);
    const top = getRectNumber(rect,['y','top']);
    let right = getRectNumber(rect,['right']);
    let bottom = getRectNumber(rect,['bottom']);
    if(!Number.isFinite(right)){right = left + getRectNumber(rect,['width','w']);}
    if(!Number.isFinite(bottom)){bottom = top + getRectNumber(rect,['height','h']);}
    if(![left,top,right,bottom].every(Number.isFinite) || right <= left || bottom <= top){return null;}
    return {left:left,top:top,right:right,bottom:bottom,width:right-left,height:bottom-top};
}

function mergeContentObjectRects(objects){
    const merged = [];
    objects.forEach(function(object){
        const next = getPlainRect(object && object.rect);
        if(!next){return;}
        const current = merged[merged.length - 1];
        const verticallyOverlaps = current && current.top < next.bottom && next.top < current.bottom;
        if(current && verticallyOverlaps && current.left <= next.left){
            current.left = Math.min(current.left,next.left);
            current.top = Math.min(current.top,next.top);
            current.right = Math.max(current.right,next.right);
            current.bottom = Math.max(current.bottom,next.bottom);
            current.width = current.right - current.left;
            current.height = current.bottom - current.top;
        }else{
            merged.push(next);
        }
    });
    return merged;
}

function getDisplayContentRects(vm,objects){
    if(vm && typeof vm.getRectsByContentObjs === 'function'){
        try{
            const rects = vm.getRectsByContentObjs(objects);
            if(Array.isArray(rects) && rects.length){return rects;}
        }catch(error){}
    }
    // 与微信读书内部 getRectsByContentObjs 一致：同一行且从左到右的字符合并成一段。
    return mergeContentObjectRects(objects);
}

async function resolveReaderBookIdFromRequests(){
    const startedAt = Date.now();
    while(Date.now() - startedAt < 5000){
        try{
            performance.getEntriesByType('resource').forEach(function(entry){recordReaderBookIdFromRequest(entry.name);});
        }catch(error){}
        if(observedReaderBookIds.length){return observedReaderBookIds[observedReaderBookIds.length-1];}
        await new Promise(function(resolve){window.setTimeout(resolve,100);});
    }
    throw new Error('没有在 /web/book/info 请求中找到真实 bookId');
}

function getCurrentReaderChapterTitle(){
    const titleElement = document.querySelector('.readerTopBar_title_link');
    if(titleElement && titleElement.textContent.trim()){return titleElement.textContent.trim();}
    return (document.title || '').split(' - ')[0].trim();
}

function getCurrentReaderChapterOrdinal(){
    const text = document.querySelector('.readerTopBar')?.textContent || '';
    const match = text.match(/全书\s*(\d+)\s*\/\s*(\d+)/);
    return match ? Number(match[1]) : NaN;
}

function findChapterListInPayload(payload){
    const candidates = [];
    const visited = new Set();
    const walk = function(value,depth){
        if(!value || typeof value !== 'object' || visited.has(value) || depth > 6){return;}
        visited.add(value);
        if(Array.isArray(value)){
            if(value.some(function(item){return item && item.chapterUid !== undefined;})){candidates.push(value);}
            value.forEach(function(item){walk(item,depth+1);});
            return;
        }
        if(Array.isArray(value.updated)){candidates.push(value.updated);}
        Object.keys(value).forEach(function(key){walk(value[key],depth+1);});
    };
    walk(payload,0);
    candidates.sort(function(a,b){return b.length-a.length;});
    return candidates[0] || [];
}

async function requestSimulatedHorizontalChapterInfos(bookId,signal){
    const attempts = [
        {headers:{'Content-Type':'application/json'},body:JSON.stringify({bookIds:[bookId]})},
        {headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:`bookIds=${encodeURIComponent(JSON.stringify([bookId]))}`},
        {headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:`bookIds%5B%5D=${encodeURIComponent(bookId)}`}
    ];
    let lastError = null;
    for(const attempt of attempts){
        try{
            const response = await fetch('/web/book/chapterInfos',{
                method:'POST',credentials:'include',headers:attempt.headers,body:attempt.body,signal:signal
            });
            const payload = await response.json();
            const chapters = findChapterListInPayload(payload);
            if(response.ok && Number(payload && payload.errCode || 0) === 0 && chapters.length){return chapters;}
            lastError = new Error(`HTTP ${response.status}, errCode ${payload && payload.errCode}, chapters ${chapters.length}`);
        }catch(error){lastError = error;}
    }
    throw lastError || new Error('章节接口没有返回数据');
}

function selectCurrentChapterInfo(chapters){
    const title = getCurrentReaderChapterTitle();
    const ordinal = getCurrentReaderChapterOrdinal();
    const exact = chapters.filter(function(chapter){return String(chapter && chapter.title || '').trim() === title;});
    if(exact.length === 1){return exact[0];}
    if(exact.length > 1){
        return exact.find(function(chapter){return Number(chapter.chapterIdx) + 1 === ordinal;}) || exact[0];
    }
    if(Number.isFinite(ordinal)){
        return chapters.find(function(chapter){return Number(chapter.chapterIdx) + 1 === ordinal;}) || chapters[ordinal-1] || null;
    }
    return null;
}

async function loadSimulatedHorizontalReviewData(force){
    const bookId = await resolveReaderBookIdFromRequests();
    const title = getCurrentReaderChapterTitle();
    const key = `${bookId}:${title}`;
    if(!force && simulatedHorizontalReviewKey === key && simulatedHorizontalReviewData){return simulatedHorizontalReviewData;}
    if(!force && simulatedHorizontalReviewPromise){return simulatedHorizontalReviewPromise;}
    if(force && simulatedHorizontalReviewController){simulatedHorizontalReviewController.abort();}
    const controller = new AbortController();
    simulatedHorizontalReviewController = controller;
    const promise = (async function(){
        try{
            const chapters = await requestSimulatedHorizontalChapterInfos(bookId,controller.signal);
            const chapter = selectCurrentChapterInfo(chapters);
            if(!chapter || chapter.chapterUid === undefined){throw new Error(`无法从 ${chapters.length} 个章节中匹配“${title}”`);}
            const underlines = await fetchBookReviewUnderlinesDirect(bookId,chapter.chapterUid,controller.signal);
            const result = {
                bookId:bookId,chapterUid:chapter.chapterUid,title:title,
                chapterCount:chapters.length,underlines:underlines,
                reviewsByRange:{}
            };
            simulatedHorizontalReviewKey = key;
            simulatedHorizontalReviewData = result;
            console.info('[weixin-read-wide] 书友想法 range 获取统计 ' + JSON.stringify({
                bookId:String(bookId),chapterUid:String(chapter.chapterUid),title:title,
                chapterCount:chapters.length,underlineCount:underlines.length,
                reviewRangeCount:0,pageReviewCount:0,reviewsMode:'click-to-load'
            }));
            return result;
        }catch(error){
            if(error && error.name === 'AbortError'){
                console.info('[weixin-read-wide] 书友想法 range 获取已取消');
                throw error;
            }
            console.warn('[weixin-read-wide] 书友想法 range 获取失败 ' + JSON.stringify({
                bookId:String(bookId),title:title,message:String(error)
            }));
            throw error;
        }
    })();
    simulatedHorizontalReviewPromise = promise;
    try{return await promise;}
    finally{
        if(simulatedHorizontalReviewPromise === promise){simulatedHorizontalReviewPromise = null;}
        if(simulatedHorizontalReviewController === controller){simulatedHorizontalReviewController = null;}
    }
}

async function fetchBookReviewUnderlinesDirect(bookId,chapterUid,signal){
    const url = new URL('/web/book/underlines',location.origin);
    url.searchParams.set('bookId',String(bookId));
    url.searchParams.set('chapterUid',String(chapterUid));
    const response = await fetch(url.toString(),{credentials:'include',signal:signal});
    const payload = await response.json();
    if(!response.ok || Number(payload && payload.errCode || 0) !== 0){
        throw new Error(`读取书友想法划线失败：HTTP ${response.status}`);
    }
    if(payload && Array.isArray(payload.underlines)){return payload.underlines;}
    const data = payload && payload.data;
    return data && Array.isArray(data.underlines) ? data.underlines : [];
}

async function loadScrollBookReviewUnderlines(vm,bookId,chapterUid){
    const key = `${bookId}:${chapterUid}`;
    if(scrollBookReviewDataKey === key){return scrollBookReviewData;}
    if(scrollBookReviewDataPromise && scrollBookReviewDataPromiseKey === key){return scrollBookReviewDataPromise;}

    const promise = (async function(){
        try{
            await vm.$store.dispatch('ACTION_SYNC_BOOK_UNDERLINE',{
                bookId:bookId,
                chapterUid:chapterUid
            });
            const underlines = vm.getBookUnderlinesByRangeOfChapter(chapterUid,0,Number.MAX_SAFE_INTEGER);
            if(Array.isArray(underlines) && underlines.length){return underlines;}
            // 微信读书的 action 会吞掉网络异常并返回 undefined；空列表时再用同源接口确认一次。
            return fetchBookReviewUnderlinesDirect(bookId,chapterUid);
        }catch(error){
            console.warn('[weixin-read-wide] 阅读器内部同步书友想法失败，改用页面接口',error);
            return fetchBookReviewUnderlinesDirect(bookId,chapterUid);
        }
    })();

    scrollBookReviewDataPromise = promise;
    scrollBookReviewDataPromiseKey = key;
    try{
        const data = await promise;
        scrollBookReviewDataKey = key;
        scrollBookReviewData = data;
        if(scrollBookReviewLastDataLogKey !== key){
            scrollBookReviewLastDataLogKey = key;
            console.info('[weixin-read-wide] 书友想法数据统计 ' + JSON.stringify({
                bookId:String(bookId),
                chapterUid:String(chapterUid),
                count:Array.isArray(data) ? data.length : 0
            }));
        }
        return data;
    }finally{
        if(scrollBookReviewDataPromise === promise){
            scrollBookReviewDataPromise = null;
            scrollBookReviewDataPromiseKey = '';
        }
    }
}

async function fetchBookReviewsDirect(bookId,chapterUid,range){
    const response = await fetch('/web/book/readReviews',{
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            bookId:String(bookId),
            chapterUid:chapterUid,
            reviews:[{range:range,maxIdx:0,count:30,synckey:0}]
        })
    });
    const payload = await response.json();
    if(!response.ok || Number(payload && payload.errCode || 0) !== 0){
        throw new Error(`读取书友想法失败：HTTP ${response.status}`);
    }
    const reviews = payload && Array.isArray(payload.reviews) ? payload.reviews :
        payload && payload.data && payload.data.reviews;
    return Array.isArray(reviews) && reviews[0] ? reviews[0] : {};
}

async function loadSimulatedReviewPage(data,rangeString){
    if(data.reviewsByRange && data.reviewsByRange[rangeString]){
        return data.reviewsByRange[rangeString];
    }
    const key = `${data.bookId}:${data.chapterUid}:${rangeString}`;
    if(simulatedReviewPagePromises.has(key)){return simulatedReviewPagePromises.get(key);}
    const promise = fetchBookReviewsDirect(data.bookId,data.chapterUid,rangeString).then(function(reviewPage){
        data.reviewsByRange = data.reviewsByRange || {};
        data.reviewsByRange[rangeString] = reviewPage;
        console.info('[weixin-read-wide] 书友想法按需加载统计 ' + JSON.stringify({
            bookId:String(data.bookId),chapterUid:String(data.chapterUid),range:rangeString,
            pageReviewCount:Array.isArray(reviewPage && reviewPage.pageReviews) ? reviewPage.pageReviews.length : 0,
            totalCount:Number(reviewPage && reviewPage.totalCount) || 0
        }));
        const sample = Array.isArray(reviewPage && reviewPage.pageReviews) ? reviewPage.pageReviews[0] : null;
        if(sample && typeof sample === 'object'){
            const nestedKeys = {};
            Object.keys(sample).forEach(function(name){
                const value = sample[name];
                if(value && typeof value === 'object' && !Array.isArray(value)){
                    nestedKeys[name] = Object.keys(value).slice(0,20);
                }
            });
            console.info('[weixin-read-wide] 热门想法字段统计 ' + JSON.stringify({
                itemKeys:Object.keys(sample).slice(0,30),nestedKeys:nestedKeys
            }));
        }
        return reviewPage;
    }).finally(function(){simulatedReviewPagePromises.delete(key);});
    simulatedReviewPagePromises.set(key,promise);
    return promise;
}

function mergeSimulatedLayoutRects(rects){
    const sorted = rects.slice().sort(function(a,b){return a.top-b.top || a.left-b.left;});
    const merged = [];
    sorted.forEach(function(rect){
        const next = {left:rect.left,top:rect.top,right:rect.left+rect.width,bottom:rect.top+rect.height};
        const current = merged[merged.length-1];
        const sameLine = current && Math.abs(current.top-next.top) <= Math.max(2,Math.min(current.bottom-current.top,next.bottom-next.top) * .35);
        if(sameLine && next.left <= current.right + 6){
            current.left = Math.min(current.left,next.left);
            current.top = Math.min(current.top,next.top);
            current.right = Math.max(current.right,next.right);
            current.bottom = Math.max(current.bottom,next.bottom);
        }else{
            merged.push(next);
        }
    });
    return merged.map(function(rect){
        return {left:rect.left,top:rect.top,width:rect.right-rect.left,height:rect.bottom-rect.top};
    });
}

function buildSimulatedUnderlineItems(data,layout,scaleX,scaleY){
    if(!data || !layout || !Array.isArray(layout.items)){return [];}
    if(layout.title && data.title && layout.title !== data.title){return [];}
    const records = layout.items.map(function(item){
        if(!Array.isArray(item) || item.length < 6){return null;}
        const values = item.slice(0,6).map(Number);
        if(!values.every(Number.isFinite) || values[4] <= 0 || values[5] <= 0){return null;}
        return {
            offset:values[0],length:Math.max(1,values[1]),
            left:values[2]*scaleX,top:values[3]*scaleY,width:values[4]*scaleX,height:values[5]*scaleY
        };
    }).filter(Boolean).sort(function(a,b){return a.offset-b.offset || a.top-b.top || a.left-b.left;});
    const items = [];
    const seenRanges = new Set();
    (Array.isArray(data.underlines) ? data.underlines : []).forEach(function(underline){
        const range = normalizeBookReviewRange(underline);
        if(!range){return;}
        const rangeString = `${range.start}-${range.end}`;
        if(seenRanges.has(rangeString)){return;}
        seenRanges.add(rangeString);
        const seenRects = new Set();
        const rects = [];
        for(const record of records){
            if(record.offset >= range.end){break;}
            if(record.offset + record.length <= range.start){continue;}
            const key = `${record.left}:${record.top}:${record.width}:${record.height}`;
            if(seenRects.has(key)){continue;}
            seenRects.add(key);
            rects.push(record);
        }
        const merged = mergeSimulatedLayoutRects(rects);
        if(merged.length){items.push({range:rangeString,start:range.start,end:range.end,rects:merged});}
    });
    return items;
}

function getReviewCandidates(review){
    const candidates = [];
    const add = function(value){
        if(value && typeof value === 'object' && !candidates.includes(value)){candidates.push(value);}
    };
    add(review);
    ['review','reviewInfo','reviewData','data','item','detail'].forEach(function(name){add(review && review[name]);});
    candidates.slice().forEach(function(candidate){
        ['review','reviewInfo','data'].forEach(function(name){add(candidate && candidate[name]);});
    });
    return candidates;
}

function getReviewAuthorName(review){
    for(const candidate of getReviewCandidates(review)){
        const author = candidate.author || candidate.user || candidate.reviewer || candidate.userInfo;
        if(typeof author === 'string' && author.trim()){return author.trim();}
        const name = author && (author.name || author.nickName || author.nickname || author.userName) ||
            candidate.authorName || candidate.userName || candidate.nickName || candidate.nickname;
        if(name){return String(name);}
    }
    return '微信读书用户';
}

function getReviewContent(review){
    for(const candidate of getReviewCandidates(review)){
        const content = candidate.content || candidate.reviewContent || candidate.abstract || candidate.summary ||
            candidate.reviewText || candidate.text || candidate.htmlContent;
        if(typeof content === 'string' && content.trim()){return content;}
    }
    return '';
}

function getReviewAvatar(review){
    for(const candidate of getReviewCandidates(review)){
        const author = candidate.author || candidate.user || candidate.reviewer || candidate.userInfo;
        const avatar = author && (author.avatar || author.avatarUrl || author.headUrl || author.headImgUrl) ||
            candidate.avatar || candidate.avatarUrl || candidate.headUrl || candidate.headImgUrl;
        if(avatar){return String(avatar);}
    }
    return '';
}

function getReviewMetric(review,names){
    for(const candidate of getReviewCandidates(review)){
        for(const name of names){
            const value = Number(candidate && candidate[name]);
            if(Number.isFinite(value) && value >= 0){return value;}
        }
    }
    return 0;
}

function showSimulatedReviewPanel(reviewPage,event){
    document.querySelectorAll('.lv-simulated-book-review-panel').forEach(function(panel){panel.remove();});
    const panel = document.createElement('div');
    panel.className = 'lv-simulated-book-review-panel';
    const header = document.createElement('div');
    header.className = 'lv-simulated-book-review-panel__header';
    const title = document.createElement('span');
    title.textContent = '热门想法';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lv-simulated-book-review-panel__close';
    close.setAttribute('aria-label','关闭');
    close.textContent = '×';
    close.addEventListener('click',function(){panel.remove();});
    header.append(title,close);
    panel.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'lv-simulated-book-review-panel__actions';
    [
        ['复制','<svg viewBox="0 0 24 24"><rect x="7" y="5" width="11" height="14" rx="1"></rect><path d="M5 16H4V3h11v1"></path><path d="M10 9h5M10 12h5M10 15h3"></path></svg>'],
        ['划线','<svg viewBox="0 0 24 24"><path d="M7 17 12 4l5 13M9 12h6M6 20h12"></path></svg>'],
        ['写想法','<svg viewBox="0 0 24 24"><path d="M7 18c-2-1.7-3-4-3-6.5A7.5 7.5 0 0 1 19 11c0 2.2-.9 4.2-2.4 5.6L17 20l-3-1a8 8 0 0 1-3 .5"></path><path d="M7 15v4h4"></path></svg>'],
        ['查询','<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path></svg>']
    ].forEach(function(actionInfo){
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lv-simulated-book-review-panel__action';
        button.innerHTML = actionInfo[1];
        const label = document.createElement('span');
        label.textContent = actionInfo[0];
        button.appendChild(label);
        actions.appendChild(button);
    });
    panel.appendChild(actions);

    const reviews = Array.isArray(reviewPage && reviewPage.pageReviews) ? reviewPage.pageReviews : [];
    if(reviews.length){
        const list = document.createElement('ul');
        list.className = 'lv-simulated-book-review-panel__list';
        reviews.forEach(function(review){
            const item = document.createElement('li');
            item.className = 'lv-simulated-book-review-panel__item';
            const authorRow = document.createElement('div');
            authorRow.className = 'lv-simulated-book-review-panel__author-row';
            const avatarUrl = getReviewAvatar(review);
            const avatar = avatarUrl ? document.createElement('img') : document.createElement('span');
            avatar.className = 'lv-simulated-book-review-panel__avatar';
            if(avatarUrl){avatar.src = avatarUrl;avatar.alt = '';}
            const author = document.createElement('div');
            author.className = 'lv-simulated-book-review-panel__author';
            author.textContent = getReviewAuthorName(review);
            authorRow.append(avatar,author);
            const content = document.createElement('div');
            content.className = 'lv-simulated-book-review-panel__content';
            content.textContent = getReviewContent(review);
            const footer = document.createElement('div');
            footer.className = 'lv-simulated-book-review-panel__footer';
            const like = document.createElement('span');
            like.className = 'lv-simulated-book-review-panel__metric';
            like.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20.5 4.5 13A5 5 0 0 1 12 6.4 5 5 0 0 1 19.5 13Z"></path></svg>';
            const likeCount = document.createElement('span');
            likeCount.textContent = String(getReviewMetric(review,['likeCount','likesCount','praiseCount']));
            like.appendChild(likeCount);
            const comment = document.createElement('span');
            comment.className = 'lv-simulated-book-review-panel__metric';
            comment.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5h14v11H10l-4 3v-3H5Z"></path></svg>';
            const commentCountValue = getReviewMetric(review,['commentCount','commentsCount','replyCount']);
            if(commentCountValue){
                const commentCount = document.createElement('span');
                commentCount.textContent = String(commentCountValue);
                comment.appendChild(commentCount);
            }
            footer.append(like,comment);
            item.append(authorRow,content,footer);
            list.appendChild(item);
        });
        panel.appendChild(list);
    }else{
        const empty = document.createElement('div');
        empty.className = 'lv-simulated-book-review-panel__empty';
        empty.textContent = '暂无书友想法';
        panel.appendChild(empty);
    }
    document.body.appendChild(panel);
    const margin = 12;
    const panelWidth = panel.offsetWidth || 440;
    const panelHeight = panel.offsetHeight || 320;
    const anchorX = Number(event && event.clientX) || window.innerWidth/2;
    const anchorY = Number(event && event.clientY) || window.innerHeight/2;
    const placeOnLeft = anchorX-panelWidth-14 >= margin;
    const left = placeOnLeft ? anchorX-panelWidth-14 : Math.max(margin,Math.min(window.innerWidth-panelWidth-margin,anchorX+14));
    const top = Math.min(Math.max(margin,anchorY-110),window.innerHeight-panelHeight-margin);
    panel.classList.add(placeOnLeft ? 'lv-simulated-book-review-panel--left' : 'lv-simulated-book-review-panel--right');
    panel.style.setProperty('--lv-arrow-top',`${Math.max(26,Math.min(panelHeight-30,anchorY-top-10))}px`);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(margin,top)}px`;
    window.setTimeout(function(){
        const closeOnOutside = function(mouseEvent){
            if(!panel.isConnected){
                document.removeEventListener('mousedown',closeOnOutside,true);
            }else if(!panel.contains(mouseEvent.target)){
                panel.remove();
                document.removeEventListener('mousedown',closeOnOutside,true);
            }
        };
        document.addEventListener('mousedown',closeOnOutside,true);
    },0);
}

async function openSimulatedBookReviewPanel(data,item,event){
    const bridgeState = getMainBookReviewState();
    if(bridgeState && bridgeState.status === 'ready'){
        sendMainBookReviewCommand({
            type:'open',start:item.start,end:item.end,clientX:event.clientX,clientY:event.clientY
        });
        return;
    }
    const reviewPage = await loadSimulatedReviewPage(data,item.range);
    showSimulatedReviewPanel(reviewPage,event);
}

function rectCoversAxis(rect,axis){
    if(rect && typeof rect.isCoverAxis === 'function'){
        try{return rect.isCoverAxis(axis);}catch(error){}
    }
    const left = getRectNumber(rect,['x','left']);
    const top = getRectNumber(rect,['y','top']);
    let right = getRectNumber(rect,['right']);
    let bottom = getRectNumber(rect,['bottom']);
    if(!Number.isFinite(right)){right = left + getRectNumber(rect,['width','w']);}
    if(!Number.isFinite(bottom)){bottom = top + getRectNumber(rect,['height','h']);}
    return [left,top,right,bottom].every(Number.isFinite) &&
        axis.x >= left && axis.x <= right && axis.y >= top && axis.y <= bottom;
}

async function openNativeBookReviewPanel(vm,range,event){
    // 完全复用微信读书自身的点击处理：范围命中、想法请求、弹窗锚点和后续翻页均由原生代码负责。
    if(vm && typeof vm.handleClickRange === 'function'){
        vm.handleClickRange(range.start,range.end,{
            chapterUid:vm.currentChapterUid,
            event:event,
            isRefresh:false
        });
        return;
    }

    const container = getScrollRenderContainer(vm);
    const panel = vm && vm.$refs && vm.$refs.readerFloatReviewPanel;
    if(!container || !panel || typeof panel.show !== 'function'){return;}

    const chapterUid = vm.currentChapterUid;
    const bookId = vm.bookId;
    const contents = vm.getCurrentDisplayRenderContents() || [];
    const objects = getObjectsInBookReviewRange(contents,range,chapterUid);
    if(!objects.length){return;}

    const containerRect = container.getBoundingClientRect();
    const axis = {x:event.clientX - containerRect.left,y:event.clientY - containerRect.top};
    const rects = getNativeContentRects(vm,objects);
    const anchorRect = rects.find(function(rect){return rectCoversAxis(rect,axis);}) || rects[0] || objects[0].rect;
    if(!anchorRect){return;}

    const rangeString = `${range.start}-${range.end}`;
    let reviewPage;
    try{
        reviewPage = await vm.$store.dispatch('ACTION_SYNC_BOOK_UNDERLINE_REVIEWS',{
            bookId:bookId,
            chapterUid:chapterUid,
            range:rangeString
        });
        if(!reviewPage || typeof reviewPage !== 'object' ||
            (!Array.isArray(reviewPage.pageReviews) && reviewPage.range === undefined && reviewPage.totalCount === undefined)){
            reviewPage = await fetchBookReviewsDirect(bookId,chapterUid,rangeString);
        }
    }catch(error){
        console.warn('[weixin-read-wide] 阅读器内部读取想法失败，改用页面接口',error);
        reviewPage = await fetchBookReviewsDirect(bookId,chapterUid,rangeString);
    }

    let selfThoughts = [];
    if(typeof vm.getSelfThoughtsByRangeOfChapter === 'function'){
        try{
            selfThoughts = vm.getSelfThoughtsByRangeOfChapter(chapterUid,range.start,range.end) || [];
        }catch(error){}
    }
    const pageReviews = Array.isArray(reviewPage.pageReviews) ? reviewPage.pageReviews : [];
    panel.show({
        reviewList:selfThoughts.concat(pageReviews),
        objs:objects,
        rects:[anchorRect],
        onSendReviewSucc:function(){
            if(typeof vm.handleFloatPanelAddReviewFinish === 'function'){
                vm.handleFloatPanelAddReviewFinish();
            }
            scrollBookReviewDataKey = '';
            scheduleScrollBookReviewUnderlines(0);
        },
        maxIdx:reviewPage.maxIdx,
        hasMore:reviewPage.hasMore,
        range:reviewPage.range || rangeString,
        totalCount:reviewPage.totalCount
    });
}

function renderMainBridgeUnderlines(state){
    const container = document.querySelector('.renderTargetContainer');
    if(!container || !container.isConnected){scheduleScrollBookReviewUnderlines(300);return;}
    let layer = Array.from(container.children).find(function(child){
        return child.classList && child.classList.contains('lv-scroll-book-review-underlines');
    });
    if(!layer){
        layer = document.createElement('div');
        layer.className = 'lv-scroll-book-review-underlines';
        container.appendChild(layer);
    }
    const fragment = document.createDocumentFragment();
    let renderedCount = 0;
    (Array.isArray(state.items) ? state.items : []).forEach(function(item){
        (Array.isArray(item.rects) ? item.rects : []).forEach(function(cssText){
            if(!cssText){return;}
            const wrapper = document.createElement('div');
            wrapper.className = 'wr_underline_wrapper wr_underline_color_0';
            wrapper.style.cssText = cssText;
            wrapper.dataset.range = item.range;
            const underline = document.createElement('div');
            underline.className = 'wr_underline wr_underline_thought';
            wrapper.appendChild(underline);
            wrapper.addEventListener('click',function(event){
                event.preventDefault();
                event.stopPropagation();
                sendMainBookReviewCommand({
                    type:'open',start:item.start,end:item.end,clientX:event.clientX,clientY:event.clientY
                });
            });
            fragment.appendChild(wrapper);
            renderedCount++;
        });
    });
    layer.replaceChildren(fragment);
    layer.dataset.sourceCount = String(Number(state.underlineCount) || 0);
    layer.dataset.renderedCount = String(renderedCount);
    const stats = {
        source:state.source || 'bridge',underlineCount:Number(state.underlineCount) || 0,
        matchedRangeCount:Number(state.matchedRangeCount) || 0,renderedCount:renderedCount
    };
    const logKey = JSON.stringify(stats);
    if(scrollBookReviewLastRenderLogKey !== logKey){
        scrollBookReviewLastRenderLogKey = logKey;
        console.info('[weixin-read-wide] 书友想法下划线统计 ' + logKey);
    }
}

function renderSimulatedBookReviewUnderlines(data,layout){
    const container = document.querySelector('.renderTargetContainer');
    if(!container || !container.isConnected){scheduleScrollBookReviewUnderlines(300);return;}
    let layer = Array.from(container.children).find(function(child){
        return child.classList && child.classList.contains('lv-scroll-book-review-underlines');
    });
    if(!layer){
        layer = document.createElement('div');
        layer.className = 'lv-scroll-book-review-underlines';
        container.appendChild(layer);
    }
    const containerRect = container.getBoundingClientRect();
    const rawScaleX = Number(layout && layout.width) > 0 ? containerRect.width/Number(layout.width) : 1;
    const rawScaleY = Number(layout && layout.height) > 0 ? containerRect.height/Number(layout.height) : 1;
    const scaleX = Number.isFinite(rawScaleX) && rawScaleX > .25 && rawScaleX < 4 ? rawScaleX : 1;
    const scaleY = Number.isFinite(rawScaleY) && rawScaleY > .25 && rawScaleY < 4 ? rawScaleY : 1;
    const items = buildSimulatedUnderlineItems(data,layout,scaleX,scaleY);
    const fragment = document.createDocumentFragment();
    let renderedCount = 0;
    items.forEach(function(item){
        item.rects.forEach(function(rect){
            const cssText = getRectCssText(rect);
            if(!cssText){return;}
            const wrapper = document.createElement('div');
            wrapper.className = 'wr_underline_wrapper wr_underline_color_0';
            wrapper.style.cssText = cssText;
            wrapper.dataset.range = item.range;
            const underline = document.createElement('div');
            underline.className = 'wr_underline wr_underline_thought';
            wrapper.appendChild(underline);
            wrapper.addEventListener('click',function(event){
                event.preventDefault();
                event.stopPropagation();
                openSimulatedBookReviewPanel(data,item,event).catch(function(error){
                    console.warn('[weixin-read-wide] 打开书友想法失败 ' + JSON.stringify({range:item.range,message:String(error)}));
                });
            });
            fragment.appendChild(wrapper);
            renderedCount++;
        });
    });
    layer.replaceChildren(fragment);
    layer.dataset.sourceCount = String(Array.isArray(data.underlines) ? data.underlines.length : 0);
    layer.dataset.renderedCount = String(renderedCount);
    const stats = {
        source:'simulated-layout',underlineCount:Array.isArray(data.underlines) ? data.underlines.length : 0,
        layoutObjectCount:layout && Array.isArray(layout.items) ? layout.items.length : 0,
        matchedRangeCount:items.length,renderedCount:renderedCount,
        scaleX:Math.round(scaleX*1000)/1000,scaleY:Math.round(scaleY*1000)/1000
    };
    const logKey = JSON.stringify(stats);
    if(scrollBookReviewLastRenderLogKey !== logKey){
        scrollBookReviewLastRenderLogKey = logKey;
        console.info('[weixin-read-wide] 书友想法下划线统计 ' + logKey);
    }
}

async function renderScrollBookReviewUnderlines(){
    const epoch = ++scrollBookReviewRenderEpoch;
    if(!scrollBookReviewsEnabled || document.querySelector('.wr_horizontalReader')){
        cancelPendingBookReviewRender();
        clearScrollBookReviewUnderlines();
        return;
    }

    // displayTopReview 生效后，滚动阅读器的新版本会自行生成完全一致的原生划线；此时不再重复绘制。
    if(hasNativeBookReviewUnderlines()){
        clearScrollBookReviewUnderlines();
        return;
    }

    const bridgeState = getMainBookReviewState();
    if(bridgeState && bridgeState.status === 'ready'){
        renderMainBridgeUnderlines(bridgeState);
        return;
    }
    const vm = bridgeState ? null : findScrollReaderVue();
    if(!vm){
        try{
            const simulatedData = await loadSimulatedHorizontalReviewData(false);
            if(epoch !== scrollBookReviewRenderEpoch || !scrollBookReviewsEnabled || document.querySelector('.wr_horizontalReader')){return;}
            const layout = getMainBookReviewLayout();
            if(layout && Array.isArray(layout.items) && layout.items.length){
                renderSimulatedBookReviewUnderlines(simulatedData,layout);
            }else{
                requestMainBookReviewLayoutCapture(false);
                const waitingStats = {
                    underlineCount:Array.isArray(simulatedData.underlines) ? simulatedData.underlines.length : 0,
                    chapterUid:String(simulatedData.chapterUid)
                };
                const waitingLogKey = JSON.stringify(waitingStats);
                if(scrollBookReviewLastWaitingLogKey !== waitingLogKey){
                    scrollBookReviewLastWaitingLogKey = waitingLogKey;
                    console.warn('[weixin-read-wide] 已获取书友想法 range，正在等待正文坐标 ' + waitingLogKey);
                }
                scheduleScrollBookReviewUnderlines(500);
            }
        }catch(error){}
        return;
    }
    const bookId = vm.bookId;
    const chapterUid = vm.currentChapterUid;
    if(bookId === undefined || chapterUid === undefined || chapterUid === null){
        scheduleScrollBookReviewUnderlines(500);
        return;
    }

    let underlines;
    try{
        underlines = await loadScrollBookReviewUnderlines(vm,bookId,chapterUid);
    }catch(error){
        console.warn('[weixin-read-wide] 获取书友想法数据失败',error);
        return;
    }
    if(epoch !== scrollBookReviewRenderEpoch || !scrollBookReviewsEnabled || document.querySelector('.wr_horizontalReader')){return;}

    const container = getScrollRenderContainer(vm);
    if(!container || !container.isConnected){scheduleScrollBookReviewUnderlines(300);return;}
    let layer = Array.from(container.children).find(function(child){
        return child.classList && child.classList.contains('lv-scroll-book-review-underlines');
    });
    if(!layer){
        layer = document.createElement('div');
        layer.className = 'lv-scroll-book-review-underlines';
        container.appendChild(layer);
    }

    const contents = vm.getCurrentDisplayRenderContents() || [];
    const fragment = document.createDocumentFragment();
    const renderedRanges = new Set();
    let renderedUnderlineCount = 0;
    (Array.isArray(underlines) ? underlines : []).forEach(function(underline){
        const range = normalizeBookReviewRange(underline);
        if(!range){return;}
        const rangeString = `${range.start}-${range.end}`;
        if(renderedRanges.has(rangeString)){return;}
        renderedRanges.add(rangeString);

        const objects = getObjectsInBookReviewRange(contents,range,chapterUid);
        if(!objects.length){return;}
        getDisplayContentRects(vm,objects).forEach(function(rect){
            const cssText = getRectCssText(rect);
            if(!cssText){return;}
            const wrapper = document.createElement('div');
            wrapper.className = 'wr_underline_wrapper wr_underline_color_0';
            wrapper.style.cssText = cssText;
            wrapper.dataset.range = rangeString;

            const underlineElement = document.createElement('div');
            underlineElement.className = 'wr_underline wr_underline_thought';
            wrapper.appendChild(underlineElement);
            wrapper.addEventListener('click',function(clickEvent){
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                openNativeBookReviewPanel(vm,range,clickEvent).catch(function(error){
                    console.warn('[weixin-read-wide] 打开书友想法失败',error);
                });
            });
            fragment.appendChild(wrapper);
            renderedUnderlineCount++;
        });
    });
    layer.replaceChildren(fragment);
    layer.dataset.sourceCount = String(Array.isArray(underlines) ? underlines.length : 0);
    layer.dataset.renderedCount = String(renderedUnderlineCount);
    const renderStats = {
        source:'direct-vm',underlineCount:Array.isArray(underlines) ? underlines.length : 0,
        contentObjectCount:Array.isArray(contents) ? contents.length : 0,renderedCount:renderedUnderlineCount
    };
    const renderLogKey = JSON.stringify(renderStats);
    if(scrollBookReviewLastRenderLogKey !== renderLogKey){
        scrollBookReviewLastRenderLogKey = renderLogKey;
        console.info('[weixin-read-wide] 书友想法下划线统计 ' + renderLogKey);
    }
    if(underlines.length && !renderedUnderlineCount){
        console.warn('[weixin-read-wide] 已获取划线数据，但当前正文坐标尚未就绪 ' + JSON.stringify({
            sourceCount:underlines.length,
            contentObjectCount:Array.isArray(contents) ? contents.length : 0,
            chapterUid:String(chapterUid)
        }));
    }
}

function initScrollBookReviewUnderlines(){
    if(scrollBookReviewObserverStarted){return;}
    scrollBookReviewObserverStarted = true;
    window.addEventListener('scroll',function(){scheduleScrollBookReviewUnderlines();},{passive:true});
    window.addEventListener('resize',function(){scheduleScrollBookReviewUnderlines();},{passive:true});
    document.addEventListener(MAIN_REVIEW_LAYOUT_EVENT,function(){scheduleScrollBookReviewUnderlines(30);});
    window.setInterval(function(){
        if(!scrollBookReviewsEnabled || document.querySelector('.wr_horizontalReader')){return;}
        const title = getCurrentReaderChapterTitle();
        if(!title || title === scrollBookReviewLastChapterTitle){return;}
        scrollBookReviewLastChapterTitle = title;
        if(simulatedHorizontalReviewController){simulatedHorizontalReviewController.abort();}
        simulatedHorizontalReviewKey = '';
        simulatedHorizontalReviewData = null;
        clearScrollBookReviewUnderlines();
        scheduleScrollBookReviewUnderlines(400);
    },600);

    const waitForRenderedCanvas = function(){
        if(document.querySelector('.wr_canvasContainer canvas')){
            scrollBookReviewLastChapterTitle = getCurrentReaderChapterTitle();
            if(scrollBookReviewsEnabled){
                loadSimulatedHorizontalReviewData(false).catch(function(){});
            }
            window.requestAnimationFrame(function(){scheduleScrollBookReviewUnderlines(50);});
        }else{
            window.setTimeout(waitForRenderedCanvas,250);
        }
    };
    waitForRenderedCanvas();
}

function initScrollBookReviewUnderlinesOnLoad(){
    if(document.readyState === 'complete'){
        initScrollBookReviewUnderlines();
    }else{
        window.addEventListener('load',initScrollBookReviewUnderlines,{once:true});
    }
}

function updateScrollBookReviewButton(button,pending){
    if(!button){return;}
    button.classList.toggle('showBookReviews',!scrollBookReviewsEnabled);
    button.classList.toggle('showBookReviews_active',scrollBookReviewsEnabled);
    button.disabled = Boolean(pending);
    button.setAttribute('aria-pressed',scrollBookReviewsEnabled ? 'true' : 'false');
    button.setAttribute('aria-label',scrollBookReviewsEnabled ? '关闭书友想法' : '开启书友想法');
    const tooltip = button.parentElement && button.parentElement.querySelector('.wr_tooltip_item');
    if(tooltip){tooltip.textContent = scrollBookReviewsEnabled ? '关闭书友想法' : '开启书友想法';}
}

async function waitForMainBookReviewToggle(desired,timeout){
    const startedAt = Date.now();
    while(Date.now() - startedAt < timeout){
        const state = getMainBookReviewState();
        if(state && state.status === 'ready' && Boolean(state.enabled) === desired){return state;}
        await new Promise(function(resolve){window.setTimeout(resolve,80);});
    }
    throw new Error('页面主环境切换超时');
}

async function modifySimulatedHorizontalReviewConfig(enabled){
    const response = await fetch('/web/user_config/modify',{
        method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({displayTopReview:enabled ? 1 : 0})
    });
    const payload = await response.json();
    if(!response.ok || Number(payload && payload.errCode || 0) !== 0){
        throw new Error(`HTTP ${response.status}, errCode ${payload && payload.errCode}`);
    }
}

async function toggleScrollBookReviews(button){
    const currentBridgeState = getMainBookReviewState();
    const vm = currentBridgeState ? null : findScrollReaderVue();
    const previous = vm && vm.$store ? Boolean(vm.isShowBookReviews) :
        currentBridgeState && currentBridgeState.status === 'ready' ? Boolean(currentBridgeState.enabled) : scrollBookReviewsEnabled;
    const requestId = ++scrollBookReviewsRequestId;
    const desired = !previous;
    scrollBookReviewsEnabled = desired;
    updateScrollBookReviewButton(button,true);
    if(!desired){cancelPendingBookReviewRender();}
    try{
        if(!vm || !vm.$store){
            const bridgeState = getMainBookReviewState();
            if(!bridgeState || bridgeState.status !== 'ready'){
                await modifySimulatedHorizontalReviewConfig(desired);
                if(desired){await loadSimulatedHorizontalReviewData(false);}
                else{cancelPendingBookReviewRender();}
                scrollBookReviewsEnabled = desired;
            }else{
                sendMainBookReviewCommand({type:'toggle',enabled:desired});
                const toggledState = await waitForMainBookReviewToggle(desired,3500);
                scrollBookReviewsEnabled = Boolean(toggledState.enabled);
            }
        }else{
            if(typeof vm.toggleShowBookReviews === 'function'){
                await vm.toggleShowBookReviews();
            }else{
                // 滚动阅读器隐藏了原生按钮，也没有暴露按钮方法；直接复用该方法内部的两个 Vuex action。
                await vm.$store.dispatch('MODIFY_USER_CONFIG',{displayTopReview:desired ? 1 : 0});
                await vm.$store.dispatch('FETCH_USER_CONFIG');
            }
            // 原生 toggle 的第二次配置同步没有向外返回 Promise，等待计算属性完成刷新。
            const startedAt = Date.now();
            while(Boolean(vm.isShowBookReviews) !== desired && Date.now() - startedAt < 3000){
                await new Promise(function(resolve){window.setTimeout(resolve,80);});
            }
            if(Boolean(vm.isShowBookReviews) !== desired){throw new Error('微信读书原生设置未刷新');}
            scrollBookReviewsEnabled = Boolean(vm.isShowBookReviews);
        }
        if(requestId !== scrollBookReviewsRequestId){return;}
        GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,scrollBookReviewsEnabled);
        if(scrollBookReviewsEnabled){scrollBookReviewDataKey = '';}
        updateScrollBookReviewButton(button,false);
        scheduleScrollBookReviewUnderlines(250);
    }catch(error){
        if(requestId !== scrollBookReviewsRequestId){return;}
        scrollBookReviewsEnabled = previous;
        updateScrollBookReviewButton(button,false);
        scheduleScrollBookReviewUnderlines(0);
        console.warn('[weixin-read-wide] 书友想法切换失败 ' + JSON.stringify({message:String(error)}));
    }
}

function createScrollBookReviewControl(){
    const wrapper = document.createElement('div');
    wrapper.className = 'wr_tooltip_container lv-scroll-book-reviews-control';
    wrapper.style.setProperty('--offset','6px');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'readerControls_item showBookReviews lv-scroll-book-reviews';
    button.innerHTML = "<span class='icon'></span>";

    const tooltip = document.createElement('div');
    tooltip.className = 'wr_tooltip_item wr_tooltip_item--right';
    tooltip.style.display = 'none';

    wrapper.append(button,tooltip);
    wrapper.addEventListener('mouseenter',function(){tooltip.style.display = '';});
    wrapper.addEventListener('mouseleave',function(){tooltip.style.display = 'none';});
    button.addEventListener('click',function(){toggleScrollBookReviews(button);});
    updateScrollBookReviewButton(button,false);
    return wrapper;
}

function syncBookReviewControl(){
    const controls = document.querySelector('.readerControls');
    if(!controls){return;}

    const isHorizontal = Boolean(document.querySelector('.wr_horizontalReader'));
    if(isHorizontal){
        const nativeButton = controls.querySelector('.showBookReviews_active, .showBookReviews');
        if(nativeButton && !nativeButton.classList.contains('lv-scroll-book-reviews')){
            scrollBookReviewsEnabled = nativeButton.classList.contains('showBookReviews_active');
            GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,scrollBookReviewsEnabled);
        }
        controls.querySelector('.lv-scroll-book-reviews-control')?.remove();
        if(bookReviewControlLastHorizontal !== true){
            cancelPendingBookReviewRender();
            clearScrollBookReviewUnderlines();
        }
        bookReviewControlLastHorizontal = true;
        return;
    }
    bookReviewControlLastHorizontal = false;

    const modeButton = controls.querySelector('.isNormalReader');
    const modeControl = modeButton && (modeButton.closest('.wr_tooltip_container') || modeButton);
    if(!modeControl || modeControl.parentElement !== controls){return;}
    let reviewControl = controls.querySelector('.lv-scroll-book-reviews-control');
    if(!reviewControl){reviewControl = createScrollBookReviewControl();}
    if(reviewControl.nextElementSibling !== modeControl){
        controls.insertBefore(reviewControl,modeControl);
    }
}

function initBookReviewControl(){
    if(!document.documentElement){
        document.addEventListener('DOMContentLoaded',initBookReviewControl,{once:true});
        return;
    }
    syncBookReviewControl();
    window.setInterval(syncBookReviewControl,600);

    const syncNativeState = function(){
        if(document.querySelector('.wr_horizontalReader')){return;}
        const bridgeState = getMainBookReviewState();
        if(bridgeState && bridgeState.status === 'ready'){
            scrollBookReviewsEnabled = Boolean(bridgeState.enabled);
        }
        GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,scrollBookReviewsEnabled);
        updateScrollBookReviewButton(document.querySelector('.lv-scroll-book-reviews'),false);
        scheduleScrollBookReviewUnderlines(250);
    };
    window.setTimeout(syncNativeState,0);
}

initBookReviewControl();
initScrollBookReviewUnderlinesOnLoad();

let scrollModeFeaturesStarted = false;
function initScrollModeFeatures(){
    if(scrollModeFeaturesStarted || document.querySelector('.wr_horizontalReader')){return;}
    scrollModeFeaturesStarted = true;
    GM_addStyle(`.reader-font-control-panel-wrapper .font-panel-content-arrow {display: none;}`);
    GM_addStyle(`.wr_whiteTheme .reader-font-control-panel-wrapper .font-panel-content-arrow {display: none;}`);

    GM_registerMenuCommand("宽度：" + widths[iw].titlew,width)
    function width(){
        if(iw < widths.length-1){iw++;}
        else{iw = 0;}
        GM_setValue("numw",iw);
        location.reload();
    };

    GM_registerMenuCommand(SCROLLBAR_MODES[scrollbarModeIndex].title,function(){
        scrollbarModeIndex = (scrollbarModeIndex + 1) % SCROLLBAR_MODES.length;
        GM_setValue("nums",scrollbarModeIndex);
        location.reload();
    });
    if(SCROLLBAR_MODES[scrollbarModeIndex].value === 'visible'){
        GM_addStyle(`
            html, body { scrollbar-width: thin; }
            body::-webkit-scrollbar { display: block; width: 6px; background-color: transparent; }
            body::-webkit-scrollbar-thumb { border-radius: 10px; box-shadow: inset 0 0 6px rgba(255,255,255,.4); }
            body.wr_whiteTheme::-webkit-scrollbar-thumb { box-shadow: inset 0 0 6px rgba(0,0,0,.2); }
        `);
    }else if(SCROLLBAR_MODES[scrollbarModeIndex].value === 'hidden'){
        GM_addStyle(`
            html, body { scrollbar-width: none; }
            body::-webkit-scrollbar { display: none; width: 0; }
        `);
    }

    GM_registerMenuCommand(`空格播放/暂停：${spacePlayPauseEnabled ? '开启' : '关闭'}`,function(){
        spacePlayPauseEnabled = !spacePlayPauseEnabled;
        GM_setValue(SPACE_PLAY_PAUSE_KEY,spacePlayPauseEnabled);
        location.reload();
    });

    function nextPage () {
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            keyCode: 39
        });
        document.dispatchEvent(event);
    };
    if(spacePlayPauseEnabled){
        $(document).keydown(function(event){
            if(event.keyCode == 32 && !event.repeat && !isEditableTarget(event.target)){
                event.preventDefault();
                $('.readToggle').click();
            }
        })
    }
    $(window).on('load', function () {
            var buttonRead = "<button type='button' title='播放' aria-label='播放' class='readerControls_item autoReads readToggle'></button><button type='button' title='倍速' aria-label='倍速' class='readerControls_item autoReads readSpeed'></button>";
            GM_addStyle(`.autoReads{font-size:12px;}`);
            $('.readerControls').append(buttonRead);
            var iconToggle = "<span class='iconRead iconToggle'>播放</span>";
            var iconSpeed = "<span class='iconRead iconSpeed'>倍速</span>";
            GM_addStyle(`.iconRead{opacity:0.7;width:48px;height:48px;display:inline-block;line-height:48px;text-align:center;color:#fff}`);
            GM_addStyle(`.wr_whiteTheme .iconRead{color:#000;}`);
            $('.readToggle').append(iconToggle);
            $('.readSpeed').append(iconSpeed);
            $(".iconRead").mouseenter(function () {$(this).css("opacity", "1");});
            $(".iconRead").mouseleave(function () {$(this).css("opacity", ".7");});

            var timePage,numPlay=0;
            let ynumDown = GM_getValue("ynumDown",1);
            let timeMillisec = GM_getValue("timeMillisec",20);
            let timePagesec = GM_getValue("timePagesec",10000);
            let timeTopsec = GM_getValue("timeTopsec",0);
            $('.iconSpeed').attr('title', "步长，间隔：" + ynumDown + "，" + timeMillisec + "（双击改翻页）");
            const updateToggleRead = function () {
                $('.iconToggle').text(flagPlay ? '暂停' : '播放');
                $('.readToggle').attr('title', flagPlay ? "时长：" + timeStopmin + "（双击修改）" : "停留：" + timeTopsec + "（双击修改）");
            }
            const stopAutoRead = function () {
                flagPlay = false;
                numPlay = 0;
                clearInterval(timePlay);
                clearTimeout(timeStop);
                clearTimeout(timePage);
                updateToggleRead();
            }
            const startAutoRead = function () {
                flagPlay = true;
                clearTimeout(timeStop);
                clearInterval(timePlay);
                timePlay = setInterval(autoPlay, timeMillisec);
                if(timeStopmin != 0){timeStop = setTimeout(stopAutoRead,timeStopmin*60000);}
                updateToggleRead();
            }
            updateToggleRead();

            const autoPlay = function () {
                window.scrollBy(0,ynumDown);
                var totalTop = $(document).scrollTop();
                var scrollHeight = $(document).height() - $(window).height() - 10;
                if(totalTop <= 10 && timeTopsec != 0){
                    ynumDown = 0;
                    setTimeout(function(){ynumDown = GM_getValue("ynumDown");}, timeTopsec);};
                if(totalTop >= scrollHeight){
                    if(numPlay<1){
                        numPlay++;
                        timePage = setTimeout(() => nextPage (),timePagesec);
                    }}
                else{
                    if(numPlay>0){
                        numPlay=0;
                        clearTimeout(timePage);
                    }}
            }

            $('.readToggle').click(function () {
                clearTimeout(timeClick);
                timeClick = setTimeout(function(){
                    if(flagPlay){stopAutoRead();}
                    else{startAutoRead();}
                },250);
            });

            $('.readToggle').dblclick(function () {
                clearTimeout(timeClick);
                if(flagPlay){
                    timeStopmin = prompt("请输入暂停时长（分钟）（默认：0，不自动暂停）", timeStopmin);
                    if(timeStopmin != null && /^\d+$/.test(timeStopmin)){
                        GM_setValue("timeStopmin",timeStopmin);}
                    else{timeStopmin = GM_getValue("timeStopmin");}
                }else{
                    timeTopsec = prompt("请输入翻页停留（毫秒）（默认：0，不停留）", timeTopsec);
                    if(timeTopsec != null && /^\d+$/.test(timeTopsec)){
                        GM_setValue("timeTopsec",timeTopsec);}
                    else{timeTopsec = GM_getValue("timeTopsec");}
                }
                updateToggleRead();
            })

            $('.readSpeed').click(function () {
                var speedVal = prompt('请输入滚动步长（像素），调用间隔（毫秒）（默认：1,20）', ynumDown + "," + timeMillisec);
                if(speedVal != null){
                    var speedValsplit = speedVal.split(/[,|\uff0c]/,2)
                    let timeMillisec1 = timeMillisec;
                    ynumDown = speedValsplit[0];
                    timeMillisec = speedValsplit[1];
                    if(!$.isNumeric(ynumDown)){ynumDown = GM_getValue("ynumDown");};
                    if(!$.isNumeric(timeMillisec)){timeMillisec = GM_getValue("timeMillisec");};
                    if(timeMillisec != timeMillisec1 && flagPlay){
                        clearInterval(timePlay);
                        timePlay = setInterval(autoPlay, timeMillisec);}
                    $('.iconSpeed').attr('title', "步长，间隔：" + ynumDown + "，" + timeMillisec + "（双击改翻页）");
                    GM_setValue("ynumDown",ynumDown);
                    GM_setValue("timeMillisec",timeMillisec);}
            })

            $('.readSpeed').dblclick(function () {
                clearTimeout(timeClick);
                timePagesec = prompt("请输入翻页间隔（毫秒）（默认：10000）", timePagesec);
                if(timePagesec != null && /^\d+$/.test(timePagesec)){
                    if(timePagesec < 1000){timePagesec = 1000;}
                    GM_setValue("timePagesec",timePagesec);}
                else{timePagesec = GM_getValue("timePagesec");}
            })

            $(document).keydown(function(event){
                if(event.keyCode == 96 && !isEditableTarget(event.target)){
                    $('.readToggle').click();
                }
            });

        });
}

function initReaderModeFeaturesWhenReady(){
    if(document.querySelector('.wr_horizontalReader')){return;}
    if(document.querySelector('.readerChapterContent, .readerControls')){
        initScrollModeFeatures();
    }else{
        window.setTimeout(initReaderModeFeaturesWhenReady,100);
    }
}

if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded',initReaderModeFeaturesWhenReady,{once:true});
}else{
    initReaderModeFeaturesWhenReady();
}
