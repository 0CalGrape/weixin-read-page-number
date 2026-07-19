// ==UserScript==
// @name         微信读书目录页码与阅读进度
// @namespace    https://github.com/0CalEmotion
// @version      1.0
// @description  在微信读书网页版目录中显示章节页码，并在顶部显示当前阅读进度。
// @author       0CalEmotion
// @match        https://weread.qq.com/web/reader/*
// @run-at       document-idle
// @grant        GM_addStyle
// @license    MIT
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_WORDS_PER_PAGE = 10000;
    const TRACKER_PREFIX = 'lv-weread-page-tracker:v9:';

    const runtime = {
        observer: null,
        refreshTimer: 0,
        bookId: '',
        chapters: [],
        fetchingChapters: false,
        chapterTrackers: new Map(),
        lastChapterTitle: '',
        lastSignature: '',
        catalogClickBound: false,
        pendingCatalogJump: null,
        activeChapterKey: '',
        pageTurnIntent: null,
        chapterTurnIntent: null
    };

    bootstrap();

    function bootstrap() {
        const onReady = () => {
            installStyles();
            observeDom();
            installCatalogJumpHook();
            installPageTurnIntentHooks();
            window.addEventListener('scroll', scheduleRefresh, { passive: true });
            window.addEventListener('resize', scheduleRefresh, { passive: true });
            window.addEventListener('load', scheduleRefresh, { passive: true });
            window.setInterval(scheduleRefresh, 1500);
            console.info('[lv-weread] userscript loaded');
            scheduleRefresh();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onReady, { once: true });
        } else {
            onReady();
        }
    }

    function installStyles() {
        const cssText = `
            .lv-top-progress {
                display: flex;
                align-items: center;
                gap: 10px;
                margin: 0 24px;
                padding: 6px 12px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.06);
                color: #c9d1d9;
                font-size: 12px;
                line-height: 1;
                white-space: nowrap;
                flex-shrink: 0;
            }

            .lv-top-progress strong {
                color: #ffffff;
                font-weight: 600;
            }

            .lv-top-progress .lv-top-progress-sep {
                width: 1px;
                height: 10px;
                background: rgba(255, 255, 255, 0.12);
            }

            .wr_whiteTheme .lv-top-progress {
                background: rgba(36, 41, 47, 0.08);
                color: #24292f;
            }

            .wr_whiteTheme .lv-top-progress strong {
                color: #1f2328;
            }

            .wr_whiteTheme .lv-top-progress .lv-top-progress-sep {
                background: rgba(36, 41, 47, 0.18);
            }

            .lv-page-meta {
                margin-top: 6px;
                color: #7f8790;
                font-size: 11px;
                line-height: 1.35;
            }

            .readerCatalog_list_item_selected .lv-page-meta {
                color: #4ea1ff;

            
                }

            .wr_whiteTheme .lv-page-meta {
                color: #57606a;
            }

            .wr_whiteTheme .readerCatalog_list_item_selected .lv-page-meta {
                color: #0969da;
            }

            .readerCatalog_list_item_info {
                min-width: 0;
            }

            .readerTopBar_inner {
                display: flex;
                align-items: center;
            }

            .readerTopBar_left {
                min-width: 0;
                flex: 1 1 auto;
            }
        `;

        if (typeof GM_addStyle === 'function') {
            GM_addStyle(cssText);
            return;
        }

        const style = document.createElement('style');
        style.textContent = cssText;
        (document.head || document.documentElement).appendChild(style);
    }

    function observeDom() {
        if (runtime.observer) {
            return;
        }

        runtime.observer = new MutationObserver(() => scheduleRefresh());
        runtime.observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }

    function installCatalogJumpHook() {
        if (runtime.catalogClickBound) {
            return;
        }

        runtime.catalogClickBound = true;
        document.addEventListener('click', (event) => {
            const item = event.target instanceof Element
                ? event.target.closest('.readerCatalog_list_item')
                : null;
            if (!item) {
                return;
            }

            const title = item.querySelector('.readerCatalog_list_item_title_text')?.textContent?.trim() || '';
            if (!title) {
                return;
            }

            runtime.pendingCatalogJump = {
                title: normalizeText(title),
                at: Date.now()
            };
        }, true);
    }

    function installPageTurnIntentHooks() {
        window.addEventListener('wheel', (event) => {
            const direction = Number(event.deltaY || 0);
            if (!direction) {
                return;
            }

            capturePageTurnIntent(direction > 0 ? 'forward' : 'backward');
        }, { passive: true });

        window.addEventListener('keydown', (event) => {
            const key = String(event.key || '');
            if (key === 'PageDown' || key === 'ArrowDown' || key === ' ' || key === 'Spacebar') {
                capturePageTurnIntent('forward');
            } else if (key === 'PageUp' || key === 'ArrowUp') {
                capturePageTurnIntent('backward');
            }
        }, true);

        document.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) {
                return;
            }

            const pageTurnButton = target.closest('button.readerHeaderButton, button.readerFooter_button, button.renderTarget_pager_button');
            if (pageTurnButton) {
                const text = (pageTurnButton.textContent || '').trim();
                if (text.includes('下一页')) {
                    capturePageTurnIntent('forward', { force: true, optimistic: true, allowExtend: true });
                    return;
                }
                if (text.includes('上一页')) {
                    capturePageTurnIntent('backward', { force: true, optimistic: true });
                    return;
                }
                if (text.includes('下一章')) {
                    captureChapterTurnIntent('forward');
                    return;
                }
                if (text.includes('上一章')) {
                    captureChapterTurnIntent('backward');
                    return;
                }
            }

            const inReader = target.closest('.readerChapterContent, .renderTargetContent, .wr_canvasContainer');
            if (!inReader) {
                return;
            }

            if (target.closest('.readerControls, .readerTopBar, .readerCatalog, .readerFooter, .readerBottomSettingPanel')) {
                return;
            }

            const measurement = measureCurrentChapter();
            if (!measurement) {
                return;
            }

            const viewportHeight = Math.max(1, Number(measurement.viewportHeight || window.innerHeight || 1));
            const nearTop = Number(measurement.scrollTop || 0) <= Math.max(140, viewportHeight * 0.35);
            const nearBottom = Boolean(measurement.nearBottom);

            if (nearBottom) {
                capturePageTurnIntent('forward');
            } else if (nearTop) {
                capturePageTurnIntent('backward');
            }
        }, true);
    }

    function capturePageTurnIntent(direction, options = {}) {
        if (!isReaderPage()) {
            return;
        }

        const measurement = measureCurrentChapter();
        const chapterTitle = getCurrentChapterTitle();
        if (!measurement || !chapterTitle) {
            return;
        }

        const viewportHeight = Math.max(1, Number(measurement.viewportHeight || window.innerHeight || 1));
        const nearTop = Number(measurement.scrollTop || 0) <= Math.max(140, viewportHeight * 0.35);
        const nearBottom = Boolean(measurement.nearBottom);
        const force = Boolean(options.force);

        if (!force && direction === 'forward' && !nearBottom) {
            return;
        }

        if (!force && direction === 'backward' && !nearTop) {
            return;
        }

        const expectedPage = options.optimistic
            ? applyImmediatePageTurn(direction, chapterTitle, measurement, options)
            : 0;

        runtime.pageTurnIntent = {
            direction,
            chapterKey: normalizeText(chapterTitle),
            at: Date.now(),
            optimisticApplied: Boolean(expectedPage > 0),
            expectedPage: Number(expectedPage || 0)
        };
    }

    function applyImmediatePageTurn(direction, chapterTitle, measurement, options = {}) {
        if (!runtime.chapters.length || !chapterTitle || !measurement) {
            return 0;
        }

        const pagination = buildPagination(runtime.chapters);
        const chapter = pagination.find((item) => normalizeText(item.title) === normalizeText(chapterTitle));
        if (!chapter) {
            return 0;
        }

        const trackerKey = chapter.chapterUid || normalizeText(chapter.title);
        const tracker = runtime.chapterTrackers.get(trackerKey) || readTracker(trackerKey) || {
            currentPage: 1,
            maxPage: 1,
            currentTopSignature: '',
            signatureMap: {},
            lastScrollTop: Number(measurement.scrollTop || 0),
            initialized: true,
            maxSeenScrollTopThisPage: Number(measurement.scrollTop || 0)
        };
        const pageCount = Math.max(1, Number(chapter.pageCount || 1), Number(tracker.maxPage || 1));
        const currentPage = Math.max(1, Number(tracker.currentPage || 1));

        if (direction === 'forward' && currentPage < pageCount) {
            tracker.currentPage = currentPage + 1;
            tracker.maxPage = Math.max(Number(tracker.maxPage || 1), tracker.currentPage);
        } else if (direction === 'forward' && options.allowExtend) {
            tracker.currentPage = currentPage + 1;
            tracker.maxPage = Math.max(Number(tracker.maxPage || 1), tracker.currentPage);
        } else if (direction === 'backward' && currentPage > 1) {
            tracker.currentPage = currentPage - 1;
        } else {
            return 0;
        }

        tracker.initialized = true;
        runtime.chapterTrackers.set(trackerKey, tracker);
        writeTracker(trackerKey, tracker);
        runtime.lastSignature = '';
        scheduleRefresh();
        return Number(tracker.currentPage || 1);
    }

    function captureChapterTurnIntent(direction) {
        if (!runtime.chapters.length) {
            return;
        }

        const chapterTitle = getCurrentChapterTitle();
        if (!chapterTitle) {
            return;
        }

        const measurement = measureCurrentChapter() || {
            viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
            scrollTop: window.pageYOffset || 0,
            contentSignature: '',
            trackerSignature: '',
            nearBottom: false
        };
        const pagination = buildPagination(runtime.chapters);
        const currentIndex = pagination.findIndex((item) => normalizeText(item.title) === normalizeText(chapterTitle));
        if (currentIndex < 0) {
            return;
        }

        const targetIndex = direction === 'forward' ? currentIndex + 1 : currentIndex - 1;
        const targetChapter = pagination[targetIndex];
        if (!targetChapter) {
            return;
        }

        const targetPage = direction === 'backward'
            ? Math.max(1, Number(targetChapter.pageCount || 1))
            : 1;
        const trackerKey = targetChapter.chapterUid || normalizeText(targetChapter.title);
        const tracker = runtime.chapterTrackers.get(trackerKey) || readTracker(trackerKey) || {
            currentPage: targetPage,
            maxPage: targetPage,
            currentTopSignature: '',
            signatureMap: {},
            lastScrollTop: 0,
            initialized: true,
            maxSeenScrollTopThisPage: 0
        };

        tracker.currentPage = targetPage;
        tracker.maxPage = Math.max(Number(tracker.maxPage || 1), targetPage);
        tracker.initialized = true;
        runtime.chapterTrackers.set(trackerKey, tracker);
        writeTracker(trackerKey, tracker);

        runtime.chapterTurnIntent = {
            direction,
            targetChapterKey: normalizeText(targetChapter.title),
            targetPage,
            at: Date.now()
        };
        runtime.pageTurnIntent = null;
        runtime.lastSignature = '';
    }

    function scheduleRefresh() {
        if (runtime.refreshTimer) {
            return;
        }

        runtime.refreshTimer = window.setTimeout(() => {
            runtime.refreshTimer = 0;
            refreshUI().catch((error) => {
                console.warn('[lv-weread] refresh failed', error);
            });
        }, 80);
    }

    async function refreshUI() {
        if (!isReaderPage()) {
            return;
        }

        const bookId = getBookId();
        if (!bookId) {
            return;
        }

        if (!runtime.bookId || runtime.bookId !== bookId) {
            runtime.bookId = bookId;
            runtime.chapters = [];
        }

        if (runtime.chapters.length === 0) {
            await fetchChapters(bookId);
        }

        if (runtime.chapters.length === 0) {
            return;
        }

        const chapterTitle = getCurrentChapterTitle();
        const chapterKey = normalizeText(chapterTitle);
        if (chapterKey && chapterKey !== runtime.activeChapterKey) {
            runtime.activeChapterKey = chapterKey;
            runtime.pageTurnIntent = null;
        }
        const measurement = measureCurrentChapter();
        const pagination = buildPagination(runtime.chapters);
        const current = buildCurrentProgress(pagination, chapterTitle, measurement);
        if (!current) {
            return;
        }

        const signature = [
            current.currentPage,
            current.currentChapterPage,
            current.currentChapterPageCount,
            current.chapterProgressPercent,
            current.bookProgressPercent,
            current.totalPages,
            current.chapterTitle,
            document.querySelectorAll('.readerCatalog_list > .readerCatalog_list_item').length
        ].join('|');

        if (signature === runtime.lastSignature) {
            return;
        }

        runtime.lastSignature = signature;
        renderCatalogPages(pagination, current);
        renderTopProgress(current);
    }

    function isReaderPage() {
        return Boolean(document.querySelector('.readerTopBar') && document.querySelector('.readerChapterContent'));
    }

    function getBookId() {
        const ldJsonNode = document.querySelector('script[type="application/ld+json"]');
        if (!ldJsonNode) {
            return '';
        }

        try {
            const payload = JSON.parse(ldJsonNode.textContent || '{}');
            return String(payload['@Id'] || '').trim();
        } catch (error) {
            return '';
        }
    }

    async function fetchChapters(bookId) {
        if (!bookId || runtime.fetchingChapters) {
            return;
        }

        runtime.fetchingChapters = true;

        try {
            const response = await fetch('/web/book/publicchapterInfos', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    bookIds: [String(bookId)]
                })
            });
            const payload = await response.json();
            const updated = payload && payload.data && payload.data[0] && Array.isArray(payload.data[0].updated)
                ? payload.data[0].updated
                : [];

            runtime.chapters = updated.map((chapter) => ({
                chapterUid: String(chapter.chapterUid),
                title: chapter.title || '',
                level: Number(chapter.level || 1),
                wordCount: Number(chapter.wordCount || 0),
                fileCount: Array.isArray(chapter.files) && chapter.files.length > 0 ? chapter.files.length : 1
            }));
        } catch (error) {
            console.warn('[lv-weread] failed to fetch chapter infos', error);
        } finally {
            runtime.fetchingChapters = false;
        }
    }

    function getCurrentChapterTitle() {
        const titleNode = document.querySelector('.readerTopBar_title_chapter');
        const visibleTitle = titleNode && titleNode.textContent.trim()
            ? titleNode.textContent.trim()
            : '';
        const exactVisibleTitle = findKnownChapterTitle(visibleTitle, false);
        if (exactVisibleTitle) {
            runtime.lastChapterTitle = exactVisibleTitle;
            return runtime.lastChapterTitle;
        }

        const selectedCatalogTitle = document.querySelector(
            '.readerCatalog_list_item_selected .readerCatalog_list_item_title_text'
        )?.textContent?.trim() || '';
        const exactCatalogTitle = findKnownChapterTitle(selectedCatalogTitle, false);
        if (exactCatalogTitle) {
            runtime.lastChapterTitle = exactCatalogTitle;
            return runtime.lastChapterTitle;
        }

        // 微信读书会把一组很短的小节放在同一个渲染章节中。此时顶栏显示
        // 小节标题，而 document.title 仍保留接口返回的父章节标题。
        const parentTitle = findKnownChapterTitle(document.title, true);
        if (parentTitle) {
            runtime.lastChapterTitle = parentTitle;
            return runtime.lastChapterTitle;
        }

        if (runtime.lastChapterTitle && findKnownChapterTitle(runtime.lastChapterTitle, false)) {
            return runtime.lastChapterTitle;
        }

        if (visibleTitle) {
            runtime.lastChapterTitle = visibleTitle;
        }

        return runtime.lastChapterTitle;
    }

    function findKnownChapterTitle(sourceText, allowContains) {
        const normalizedSource = normalizeText(sourceText);
        if (!normalizedSource || runtime.chapters.length === 0) {
            return '';
        }

        const matches = runtime.chapters.filter((chapter) => {
            const normalizedTitle = normalizeText(chapter.title);
            if (!normalizedTitle) {
                return false;
            }

            return allowContains
                ? normalizedSource.includes(normalizedTitle)
                : normalizedSource === normalizedTitle;
        });

        matches.sort((left, right) => normalizeText(right.title).length - normalizeText(left.title).length);
        return matches[0] ? matches[0].title : '';
    }

    function measureCurrentChapter() {
        const renderNode = document.querySelector('.renderTargetContent')
            || document.querySelector('.readerChapterContent')
            || document.querySelector('.wr_canvasContainer');

        if (!renderNode) {
            return null;
        }

        const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const rect = renderNode.getBoundingClientRect();
        const top = rect.top + scrollTop;
        const totalHeight = Math.max(renderNode.scrollHeight, renderNode.clientHeight, Math.round(rect.height));

        if (!viewportHeight || totalHeight < 40) {
            return null;
        }

        const pageCount = Math.max(1, Math.ceil(totalHeight / viewportHeight));
        const bottomOffset = clamp(scrollTop + viewportHeight - top, 1, totalHeight);
        const currentPage = clamp(Math.floor((bottomOffset - 1) / viewportHeight) + 1, 1, pageCount);
        const progressRatio = clamp(bottomOffset / totalHeight, 0, 1);
        const scrollProgressRatio = totalHeight <= viewportHeight
            ? 1
            : clamp((scrollTop - top) / (totalHeight - viewportHeight), 0, 1);
        const contentSignature = getContentSignature(renderNode);
        const trackerSignature = getTrackerSignature(renderNode);
        const nearBottom = totalHeight - bottomOffset <= Math.max(80, viewportHeight * 0.2);

        return {
            totalHeight,
            viewportHeight,
            pageCount,
            currentPage,
            progressRatio,
            scrollProgressRatio,
            scrollTop,
            contentSignature,
            trackerSignature,
            nearBottom
        };
    }

    function buildPagination(chapters) {
        const wordsPerPage = DEFAULT_WORDS_PER_PAGE;

        let startPage = 1;

        return chapters.map((chapter) => {
            const pageCount = getChapterPageCount(chapter, wordsPerPage);

            const item = {
                ...chapter,
                pageCount,
                startPage,
                endPage: startPage + pageCount - 1
            };

            startPage = item.endPage + 1;
            return item;
        });
    }

    function buildCurrentProgress(pagination, currentChapterTitle, measurement) {
        if (!currentChapterTitle || !measurement) {
            return null;
        }

        const normalizedCurrentTitle = normalizeText(currentChapterTitle);
        const currentChapter = pagination.find((chapter) => normalizeText(chapter.title) === normalizedCurrentTitle);
        if (!currentChapter) {
            return null;
        }

        const chapterProgress = getChapterProgress(currentChapter, measurement);
        const currentChapterPage = clamp(chapterProgress.currentPage || 1, 1, currentChapter.pageCount);
        const chapterProgressPercent = getChapterProgressPercent(
            currentChapterPage,
            currentChapter.pageCount,
            measurement.scrollProgressRatio
        );
        const currentPage = currentChapter.startPage + currentChapterPage - 1;
        const totalPages = pagination[pagination.length - 1]
            ? pagination[pagination.length - 1].endPage
            : currentChapter.endPage;
        const bookProgressPercent = getBookProgressPercent(
            currentPage,
            totalPages,
            measurement.scrollProgressRatio
        );

        return {
            chapterTitle: currentChapter.title,
            currentPage,
            currentChapterPage,
            currentChapterPageCount: currentChapter.pageCount,
            chapterProgressPercent,
            bookProgressPercent,
            currentChapterEndPage: currentChapter.endPage,
            chapterSegmentIndex: chapterProgress.segmentIndex,
            chapterSegmentCount: chapterProgress.segmentCount,
            totalPages
        };
    }

    function getChapterProgressPercent(currentPage, pageCount, scrollProgressRatio) {
        const safePageCount = Math.max(1, Number(pageCount || 1));
        const safeCurrentPage = clamp(Number(currentPage || 1), 1, safePageCount);
        const pageProgress = safeCurrentPage - 1;
        const scrollProgress = clamp(Number(scrollProgressRatio || 0), 0, 1);
        return (clamp((pageProgress + scrollProgress) / safePageCount, 0, 1) * 100).toFixed(1);
    }

    function getBookProgressPercent(currentPage, totalPages, scrollProgressRatio) {
        const safeTotalPages = Math.max(1, Number(totalPages || 1));
        const safeCurrentPage = clamp(Number(currentPage || 1), 1, safeTotalPages);
        const pageProgress = safeCurrentPage - 1;
        const scrollProgress = clamp(Number(scrollProgressRatio || 0), 0, 1);
        return (clamp((pageProgress + scrollProgress) / safeTotalPages, 0, 1) * 100).toFixed(2);
    }

    function getChapterPageCount(chapter, wordsPerPage) {
        const trackerKey = chapter && (chapter.chapterUid || normalizeText(chapter.title));
        const tracker = trackerKey ? readTracker(trackerKey) : null;
        return Math.max(estimatePageCount(chapter, wordsPerPage), Number(tracker && tracker.maxPage || 1));
    }

    function estimatePageCount(chapter, wordsPerPage) {
        if (!chapter) {
            return 1;
        }

        if (chapter.title === '封面') {
            return 1;
        }

        if (chapter.title.indexOf('版权信息') >= 0) {
            return 1;
        }

        if (chapter.wordCount <= 0) {
            return 1;
        }

        if (chapter.wordCount <= 500) {
            return 1;
        }

        return Math.max(1, Math.ceil(chapter.wordCount / Math.max(wordsPerPage, 1)));
    }

    function renderCatalogPages(pagination, current) {
        const items = Array.from(document.querySelectorAll('.readerCatalog_list > .readerCatalog_list_item'));
        if (items.length === 0) {
            return;
        }

        const mapped = mapCatalogItems(items, pagination);
        items.forEach((item, index) => {
            const info = item.querySelector('.readerCatalog_list_item_info') || item;
            let meta = info.querySelector('.lv-page-meta');
            if (!meta) {
                meta = document.createElement('div');
                meta.className = 'lv-page-meta';
                info.appendChild(meta);
            }

            const chapter = mapped[index];
            if (!chapter) {
                meta.textContent = '';
                return;
            }

            meta.textContent = String(chapter.startPage);
        });
    }

    function mapCatalogItems(items, pagination) {
        const lookup = {
            rows: pagination,
            cursor: 0
        };

        return items.map((item) => {
            const title = item.querySelector('.readerCatalog_list_item_title_text')?.textContent?.trim() || '';
            const level = getCatalogLevel(item);
            return takeSequentialMatch(lookup, title, level);
        });
    }

    function getCatalogLevel(item) {
        const inner = item.querySelector('.readerCatalog_list_item_inner');
        if (!inner) {
            return 1;
        }

        const match = inner.className.match(/readerCatalog_list_item_level_(\d+)/);
        return match ? Number(match[1]) : 1;
    }

    function takeSequentialMatch(lookup, title, level) {
        const normalizedTitle = normalizeText(title);

        for (let index = lookup.cursor; index < lookup.rows.length; index += 1) {
            const row = lookup.rows[index];
            if (normalizeText(row.title) === normalizedTitle && Number(row.level || 1) === Number(level || 1)) {
                lookup.cursor = index + 1;
                return row;
            }
        }

        for (let index = lookup.cursor; index < lookup.rows.length; index += 1) {
            const row = lookup.rows[index];
            if (normalizeText(row.title) === normalizedTitle) {
                lookup.cursor = index + 1;
                return row;
            }
        }

        return null;
    }

    function renderTopProgress(current) {
        const topBarInner = document.querySelector('.readerTopBar_inner');
        const nav = document.querySelector('.readerTopBar_right');
        if (!topBarInner || !nav) {
            return;
        }

        let node = topBarInner.querySelector('.lv-top-progress');
        if (!node) {
            node = document.createElement('div');
            node.className = 'lv-top-progress';
            topBarInner.insertBefore(node, nav);
        }

        node.innerHTML = [
            `<span>本章 ${current.currentChapterPage}/${current.currentChapterPageCount},${current.chapterProgressPercent}%</span>`,
            '<span>|</span>',
            `<span>全书 ${current.currentPage}/${current.totalPages},${current.bookProgressPercent}%</span>`
        ].join('');
    }

    function getChapterProgress(chapter, measurement) {
        const trackerKey = chapter.chapterUid || normalizeText(chapter.title);
        const storedTracker = readTracker(trackerKey);
        const tracker = runtime.chapterTrackers.get(trackerKey) || storedTracker || {
            currentPage: 1,
            maxPage: 1,
            currentTopSignature: '',
            signatureMap: {},
            lastScrollTop: Number(measurement.scrollTop || 0),
            initialized: false,
            maxSeenScrollTopThisPage: Number(measurement.scrollTop || 0)
        };
        const viewportHeight = Math.max(1, Number(measurement.viewportHeight || window.innerHeight || 1));
        const scrollTop = Math.max(0, Number(measurement.scrollTop || 0));
        const nearTop = scrollTop <= Math.max(140, viewportHeight * 0.35);
        const signature = String(measurement.trackerSignature || '');
        const pendingCatalogJump = runtime.pendingCatalogJump
            && runtime.pendingCatalogJump.title === normalizeText(chapter.title)
            && Date.now() - Number(runtime.pendingCatalogJump.at || 0) <= 5000;
        const pendingTurnIntent = runtime.pageTurnIntent
            && runtime.pageTurnIntent.chapterKey === normalizeText(chapter.title)
            && Date.now() - Number(runtime.pageTurnIntent.at || 0) <= 2500
            ? runtime.pageTurnIntent
            : null;
        const pendingChapterTurn = runtime.chapterTurnIntent
            && runtime.chapterTurnIntent.targetChapterKey === normalizeText(chapter.title)
            && Date.now() - Number(runtime.chapterTurnIntent.at || 0) <= 5000
            ? runtime.chapterTurnIntent
            : null;
        if (!tracker.signatureMap || typeof tracker.signatureMap !== 'object') {
            tracker.signatureMap = {};
        }

        if (!tracker.initialized) {
            tracker.initialized = true;
            tracker.currentPage = Math.max(1, Number(tracker.currentPage || 1));
            tracker.maxPage = Math.max(1, Number(tracker.maxPage || tracker.currentPage || 1));
            tracker.maxSeenScrollTopThisPage = scrollTop;
            if (nearTop && signature) {
                tracker.currentTopSignature = signature;
                tracker.signatureMap[signature] = tracker.currentPage;
            }
        } else {
            tracker.maxSeenScrollTopThisPage = Math.max(
                Number(tracker.maxSeenScrollTopThisPage || 0),
                scrollTop
            );

            if (nearTop && signature) {
                const knownPage = Number(tracker.signatureMap[signature] || 0);
                const hasKnownTopSignature = Boolean(tracker.currentTopSignature);
                const sameTopSignature = hasKnownTopSignature && signature === tracker.currentTopSignature;
                const changedTopSignature = hasKnownTopSignature && signature !== tracker.currentTopSignature;

                if (pendingCatalogJump) {
                    tracker.currentPage = 1;
                    tracker.maxPage = Math.max(Number(tracker.maxPage || 1), 1);
                    tracker.currentTopSignature = signature;
                    tracker.signatureMap[signature] = 1;
                    tracker.maxSeenScrollTopThisPage = scrollTop;
                    runtime.pendingCatalogJump = null;
                } else if (pendingChapterTurn) {
                    const resolvedPageCount = Math.max(
                        1,
                        Number(chapter.pageCount || 1),
                        Number(tracker.maxPage || 1),
                        Number(pendingChapterTurn.targetPage || 1)
                    );
                    tracker.currentPage = pendingChapterTurn.direction === 'backward'
                        ? resolvedPageCount
                        : 1;
                    tracker.maxPage = Math.max(Number(tracker.maxPage || 1), resolvedPageCount);
                    tracker.currentTopSignature = signature;
                    tracker.signatureMap[signature] = tracker.currentPage;
                    tracker.maxSeenScrollTopThisPage = scrollTop;
                    runtime.chapterTurnIntent = null;
                } else if (changedTopSignature && pendingTurnIntent) {
                    const expectedPage = Number(pendingTurnIntent.expectedPage || 0);
                    if (expectedPage > 0) {
                        tracker.currentPage = expectedPage;
                    } else if (!pendingTurnIntent.optimisticApplied) {
                        if (pendingTurnIntent.direction === 'forward') {
                            tracker.currentPage = Math.max(1, Number(tracker.currentPage || 1) + 1);
                        } else {
                            tracker.currentPage = Math.max(1, Number(tracker.currentPage || 1) - 1);
                        }
                    }
                    tracker.maxPage = Math.max(Number(tracker.maxPage || 1), Number(tracker.currentPage || 1));
                    tracker.currentTopSignature = signature;
                    tracker.signatureMap[signature] = tracker.currentPage;
                    tracker.maxSeenScrollTopThisPage = scrollTop;
                    runtime.pageTurnIntent = null;
                } else if (knownPage > 0) {
                    tracker.currentPage = knownPage;
                    tracker.maxPage = Math.max(Number(tracker.maxPage || 1), knownPage);
                    tracker.currentTopSignature = signature;
                    tracker.maxSeenScrollTopThisPage = scrollTop;
                } else if (!hasKnownTopSignature || sameTopSignature) {
                    tracker.currentTopSignature = signature;
                    tracker.signatureMap[signature] = Number(tracker.currentPage || 1);
                    tracker.maxSeenScrollTopThisPage = scrollTop;
                }
            }
        }

        tracker.lastScrollTop = scrollTop;

        runtime.chapterTrackers.set(trackerKey, tracker);
        writeTracker(trackerKey, tracker);

        const pageCount = Math.max(1, chapter.pageCount, Number(tracker.maxPage || 1));
        const currentPage = clamp(Number(tracker.currentPage || 1), 1, pageCount);
        const overallRatio = clamp(currentPage / pageCount, 0, 1);

        return {
            currentPage,
            overallRatio,
            segmentIndex: currentPage,
            segmentCount: pageCount
        };
    }

    function readTracker(trackerKey) {
        try {
            const raw = window.localStorage.getItem(`${TRACKER_PREFIX}${runtime.bookId || 'default'}:${trackerKey}`)
                || window.sessionStorage.getItem(`${TRACKER_PREFIX}${runtime.bookId || 'default'}:${trackerKey}`);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function writeTracker(trackerKey, tracker) {
        try {
            const payload = JSON.stringify({
                currentPage: Number(tracker.currentPage || 1),
                maxPage: Number(tracker.maxPage || 1),
                currentTopSignature: String(tracker.currentTopSignature || ''),
                signatureMap: tracker.signatureMap || {},
                lastScrollTop: Number(tracker.lastScrollTop || 0),
                initialized: Boolean(tracker.initialized),
                maxSeenScrollTopThisPage: Number(tracker.maxSeenScrollTopThisPage || 0)
            });

            window.localStorage.setItem(
                `${TRACKER_PREFIX}${runtime.bookId || 'default'}:${trackerKey}`,
                payload
            );
            window.sessionStorage.setItem(
                `${TRACKER_PREFIX}${runtime.bookId || 'default'}:${trackerKey}`,
                payload
            );
        } catch (error) {}
    }

    function getContentSignature(renderNode) {
        const visibleTextNodes = getVisibleTextItems();

        if (visibleTextNodes.length > 0) {
            const texts = visibleTextNodes.map((item) => item.text);
            return [
                texts.slice(0, 8).join(''),
                texts.slice(-8).join(''),
                visibleTextNodes.length
            ].join('|');
        }

        const text = (renderNode.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            const html = renderNode.innerHTML || '';
            return [
                renderNode.scrollHeight,
                renderNode.clientHeight,
                html.length,
                simpleHash(html.slice(0, 4000)),
                simpleHash(html.slice(-4000))
            ].join('|');
        }

        return [
            text.slice(0, 80),
            text.slice(-80),
            renderNode.scrollHeight,
            simpleHash(renderNode.innerHTML || '')
        ].join('|');
    }

    function getTrackerSignature(renderNode) {
        const html = String(renderNode.innerHTML || '');
        if (!html) {
            return `${renderNode.scrollHeight}|${renderNode.clientHeight}|empty`;
        }

        const totalLength = html.length;
        const slices = [
            html.slice(0, 4000),
            html.slice(Math.max(0, Math.floor(totalLength * 0.25) - 2000), Math.max(0, Math.floor(totalLength * 0.25) + 2000)),
            html.slice(Math.max(0, Math.floor(totalLength * 0.5) - 2000), Math.max(0, Math.floor(totalLength * 0.5) + 2000)),
            html.slice(-4000)
        ];

        return [
            renderNode.scrollHeight,
            totalLength,
            simpleHash(slices[0]),
            simpleHash(slices[1]),
            simpleHash(slices[2]),
            simpleHash(slices[3])
        ].join('|');
    }

    function getVisibleTextItems() {
        return Array.from(document.querySelectorAll('[data-wr-role="text"]'))
            .map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                    text: (node.textContent || '').trim(),
                    top: rect.top,
                    bottom: rect.bottom
                };
            })
            .filter((item) => item.text && item.bottom >= 0 && item.top <= window.innerHeight);
    }

    function normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, '')
            .replace(/[\u00b7\u2022\u30fb]/g, '')
            .trim();
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function simpleHash(text) {
        let hash = 0;
        const input = String(text || '');
        for (let index = 0; index < input.length; index += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
        }
        return String(hash);
    }
})();
