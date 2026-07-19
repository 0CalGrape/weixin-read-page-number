// ==UserScript==
// @name         微信读书宽屏工具
// @icon         https://weread.qq.com/favicon.ico
// @namespace    https://greasyfork.org/users/878514
// @version      20260719.17
// @description  调整滚动阅读宽度和目录位置，并为滚动、双栏阅读提供统一的自动阅读控件。
// @author       Velens
// @match        https://weread.qq.com/web/reader/*
// @license      MIT
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @downloadURL  https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.user.js
// @updateURL    https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const widths = [
        { title: '满列', width: '100%' },
        { title: '宽列', width: '80%' },
        { title: '默认', width: '' }
    ];
    const scrollbarOptions = [
        { title: '滚动条：显示', display: 'auto', styled: true },
        { title: '滚动条：隐藏', display: 'none', styled: false },
        { title: '滚动条：默认', display: 'auto', styled: false }
    ];
    const spaceAutoPlayOptions = ['开启', '关闭'];
    const CATALOG_SHIFT_MIN_PX = 0;
    const CATALOG_SHIFT_MAX_PX = 500;
    const REVIEW_BATCH_SIZE = 12;
    const REVIEW_BATCH_DELAY_MS = 150;
    const REVIEW_CONTENT_STABLE_MS = 2200;

    let widthIndex = normalizeIndex(GM_getValue('numw', 1), widths.length);
    let scrollbarIndex = normalizeIndex(GM_getValue('nums', 0), scrollbarOptions.length);
    let spaceIndex = normalizeIndex(GM_getValue('numSpace', 0), spaceAutoPlayOptions.length);
    let catalogShiftPx = clampNumber(
        GM_getValue('catalogShiftPx', 0),
        CATALOG_SHIFT_MIN_PX,
        CATALOG_SHIFT_MAX_PX,
        0
    );
    let timeStopMinutes = clampNumber(GM_getValue('timeStopmin', 0), 0, Number.MAX_SAFE_INTEGER, 0);
    let domRefreshPending = false;
    let reviewLayer = null;
    let reviewPopover = null;
    let reviewMarksEnabled = false;
    let reviewMarksChapterKey = '';
    let reviewLoadToken = 0;
    let reviewAbortController = null;
    let chapterInfoCache = null;
    let renderedReviewGroups = [];
    let renderedReviewRangeEnd = 1;
    let renderedReviewSegmentCount = 0;
    let renderedReviewTextHost = null;
    let reviewLayoutKey = '';
    let reviewStableRenderTimer = 0;
    let reviewStableRenderToken = 0;
    let reviewContentChangedAt = Date.now();
    let reviewPanelKeyHandler = null;
    const reviewDataCache = new Map();
    const initializedControls = new WeakMap();

    installStyles();
    registerMenus();
    installKeyboardShortcuts();
    startDomObserver();
    scheduleDomRefresh();

    function installStyles() {
        GM_addStyle(`
            body:not(.wr_whiteTheme) .readerChapterContent img.wr_readerImage_opacity,
            body:not(.wr_whiteTheme) .renderTargetContent img.wr_readerImage_opacity {
                opacity: 1 !important;
                filter: none !important;
            }

            .readerControls.readerControls {
                opacity: 1 !important;
                position: fixed !important;
                top: calc(50vh + 7px) !important;
                right: max(16px, calc(10vw - 81px - (100vw - 100%))) !important;
                bottom: auto !important;
                left: auto !important;
                width: 48px !important;
                height: auto !important;
                margin: 0 !important;
                transform: translateY(-50%) !important;
                align-items: center !important;
                gap: 0 !important;
            }

            .readerControls.readerControls.lv-reader-controls-scroll {
                top: auto !important;
                bottom: 48px !important;
                transform: none !important;
            }

            .readerControls > .wr_tooltip_container,
            .readerControls > .reader-font-control-panel-wrapper,
            .readerControls > .lv-reader-control {
                width: 48px !important;
                min-width: 48px !important;
                height: 48px !important;
                min-height: 48px !important;
                flex: 0 0 48px !important;
                margin: 0 0 24px !important;
            }

            .readerControls > .lv-reader-control {
                box-sizing: border-box;
                padding: 0 !important;
            }

            .readerControls .lv-reader-control .iconRead {
                display: flex;
                width: 48px;
                height: 48px;
                align-items: center;
                justify-content: center;
                color: #fff;
                font-size: 12px;
                line-height: 1;
                opacity: .7;
            }

            .wr_whiteTheme .readerControls .lv-reader-control .iconRead {
                color: #000;
            }

            .readerControls .lv-reader-control:hover .iconRead {
                opacity: 1;
            }

            .reader-font-control-panel-wrapper .font-panel-content-arrow {
                display: none;
            }

            .lv-review-underline-layer {
                position: absolute;
                z-index: 3;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .lv-review-underline-wrapper,
            .lv-review-underline {
                pointer-events: auto;
            }

            .lv-review-underline-wrapper {
                position: absolute !important;
            }

            .lv-review-underline {
                position: absolute !important;
                inset: 0 !important;
                cursor: pointer;
            }

            .lv-review-native-panel {
                position: fixed !important;
                z-index: 99999 !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                pointer-events: none;
            }

            .lv-review-native-panel > .wr_mask {
                position: fixed !important;
                inset: 0 !important;
                pointer-events: auto;
            }

            .lv-review-native-panel > .float_panel_position_wrapper {
                position: fixed !important;
                display: flex !important;
                pointer-events: auto;
            }

            .lv-review-native-panel .reader_floatReviewsPanel_content {
                display: block !important;
                width: 420px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 32px);
            }

            .lv-review-native-panel .reader_float_panel_content_wrapper {
                max-height: calc(100vh - 104px);
                overflow: auto;
            }

            .lv-review-native-panel .reader_floatReviewsPanel_list_wrapper {
                margin-bottom: 20px;
            }

            .lv-review-native-panel .reader_float_reviews_panel_item_content {
                white-space: pre-wrap;
                word-break: break-word;
            }
        `);

        applyWidthStyle();
        applyScrollbarStyle();
    }

    function registerMenus() {
        GM_registerMenuCommand(`宽度：${widths[widthIndex].title}`, () => {
            widthIndex = (widthIndex + 1) % widths.length;
            GM_setValue('numw', widthIndex);
            location.reload();
        });

        if (!isHorizontalReader()) {
            GM_registerMenuCommand(scrollbarOptions[scrollbarIndex].title, () => {
                scrollbarIndex = (scrollbarIndex + 1) % scrollbarOptions.length;
                GM_setValue('nums', scrollbarIndex);
                location.reload();
            });
        }

        GM_registerMenuCommand(`目录横移：${catalogShiftPx}px`, () => {
            const input = prompt(
                `请输入目录向右偏移的像素值（${CATALOG_SHIFT_MIN_PX}-${CATALOG_SHIFT_MAX_PX}）`,
                String(catalogShiftPx)
            );
            if (input === null) {
                return;
            }

            const parsed = Number(input.trim());
            if (!Number.isFinite(parsed)) {
                alert('请输入有效数字。');
                return;
            }

            catalogShiftPx = Math.round(clamp(parsed, CATALOG_SHIFT_MIN_PX, CATALOG_SHIFT_MAX_PX));
            GM_setValue('catalogShiftPx', catalogShiftPx);
            shiftReaderPanels();
        });

        GM_registerMenuCommand(`空格控制自动播放：${spaceAutoPlayOptions[spaceIndex]}`, () => {
            spaceIndex = (spaceIndex + 1) % spaceAutoPlayOptions.length;
            GM_setValue('numSpace', spaceIndex);
            location.reload();
        });
    }

    function applyScrollbarStyle() {
        if (isHorizontalReader()) {
            return;
        }

        const option = scrollbarOptions[scrollbarIndex];
        GM_addStyle(`body::-webkit-scrollbar { display: ${option.display}; }`);
        if (option.display !== 'none') {
            GM_addStyle(`
                body:has(.readerCatalog:not([style*="display: none"]):not([style*="display:none"])) {
                    overflow-y: scroll !important;
                }
            `);
        }
        if (!option.styled) {
            return;
        }

        GM_addStyle(`
            body::-webkit-scrollbar {
                width: 6px;
            }

            body::-webkit-scrollbar-thumb {
                border-radius: 10px;
                box-shadow: inset 0 0 6px rgba(255, 255, 255, .4);
            }

            body.wr_whiteTheme::-webkit-scrollbar-thumb {
                border-radius: 10px;
                box-shadow: inset 0 0 6px rgba(0, 0, 0, .2);
            }
        `);
    }

    function applyWidthStyle() {
        if (isHorizontalReader() || widths[widthIndex].title === '默认') {
            return;
        }

        const setting = widths[widthIndex];
        GM_addStyle(`
            .readerContent .app_content,
            .readerTopBar {
                max-width: ${setting.width};
            }
        `);
    }

    function startDomObserver() {
        const observer = new MutationObserver((mutations) => {
            if (mutations.some(mutationAffectsReviewText)) {
                markReviewContentDirty();
            }
            scheduleDomRefresh();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
        window.addEventListener('resize', scheduleDomRefresh, { passive: true });
    }

    function mutationAffectsReviewText(mutation) {
        const target = mutation.target instanceof Element
            ? mutation.target
            : mutation.target?.parentElement;
        if (target?.closest('.lv-review-underline-layer, .lv-review-native-panel')) {
            return false;
        }
        if (target?.matches('.renderTargetContent') || target?.closest('.renderTargetContent')) {
            return true;
        }
        if (mutation.type !== 'childList') {
            return false;
        }
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
            const element = node instanceof Element ? node : node.parentElement;
            if (!element || element.closest('.lv-review-underline-layer, .lv-review-native-panel')) {
                return false;
            }
            return element.matches('.renderTargetContent')
                || Boolean(element.querySelector?.('.renderTargetContent'));
        });
    }

    function markReviewContentDirty() {
        reviewContentChangedAt = Date.now();
        cancelStableReviewRender();
        if (renderedReviewSegmentCount > 0) {
            reviewLayer?.replaceChildren();
            renderedReviewSegmentCount = 0;
            renderedReviewTextHost = null;
            reviewLayoutKey = '';
            closeNativeReviewPanel();
        }
        if (reviewMarksEnabled && renderedReviewGroups.length && !isHorizontalReader()) {
            queueReviewUnderlines(renderedReviewGroups, renderedReviewRangeEnd);
        }
    }

    function scheduleDomRefresh() {
        if (domRefreshPending) {
            return;
        }

        domRefreshPending = true;
        window.requestAnimationFrame(() => {
            domRefreshPending = false;
            shiftReaderPanels();
            document.querySelectorAll('.readerControls').forEach(initReaderControls);
            refreshScrollReviewMarks();
        });
    }

    function shiftReaderPanels() {
        const catalog = document.querySelector('.readerCatalog');
        if (!catalog) {
            return;
        }

        const measureWidth = (panel) => {
            const renderedWidth = panel.getBoundingClientRect().width;
            if (renderedWidth > 0) {
                return renderedWidth;
            }
            const computedWidth = getComputedStyle(panel).width;
            return computedWidth.endsWith('px') ? Number.parseFloat(computedWidth) : 0;
        };
        const catalogWidth = measureWidth(catalog);
        document.querySelectorAll('.readerCatalog, .readerAIChatPanel, .readerNotePanel').forEach((panel) => {
            const panelWidth = measureWidth(panel);
            const alignedOffset = catalogWidth > 0 && panelWidth > 0
                ? catalogShiftPx + catalogWidth - panelWidth
                : catalogShiftPx;
            const expected = `${alignedOffset}px`;
            if (panel.style.getPropertyValue('margin-left') !== expected
                || panel.style.getPropertyPriority('margin-left') !== 'important') {
                panel.style.setProperty('margin-left', expected, 'important');
            }
        });
    }

    function initReaderControls(controls) {
        const mode = isHorizontalReader() ? 'horizontal' : 'scroll';
        controls.classList.toggle('lv-reader-controls-scroll', mode === 'scroll');
        if (mode === 'scroll') {
            hideNativeReviewControl(controls);
        } else {
            restoreNativeReviewControl(controls);
        }
        if (initializedControls.get(controls) === mode) {
            return;
        }

        initializedControls.set(controls, mode);
        controls.querySelectorAll('.lv-reader-control').forEach((node) => node.remove());
        if (mode === 'horizontal') {
            initHorizontalAutoRead(controls);
        } else {
            reviewMarksEnabled = false;
            cancelScrollReviewLoad();
            hideScrollReviewMarks();
            initScrollAutoRead(controls);
        }
    }

    function initHorizontalAutoRead(controls) {
        const toggleButton = createTextControl('readToggle', '播放');
        const speedButton = createTextControl('readSpeed', '倍速');
        controls.append(toggleButton, speedButton);

        let playing = false;
        let intervalId = 0;
        let stopTimer = 0;
        let toggleClickTimer = 0;
        let pageInterval = clampNumber(GM_getValue('timePagedown', 20000), 1000, Number.MAX_SAFE_INTEGER, 20000);

        const update = () => {
            setControlText(toggleButton, playing ? '暂停' : '播放');
            toggleButton.title = playing
                ? `自动翻页中；停止时长：${timeStopMinutes} 分钟（双击修改）`
                : '开始自动翻页';
            speedButton.title = `自动翻页间隔：${pageInterval} 毫秒`;
        };
        const stop = () => {
            playing = false;
            window.clearInterval(intervalId);
            window.clearTimeout(stopTimer);
            intervalId = 0;
            stopTimer = 0;
            update();
        };
        const start = () => {
            playing = true;
            window.clearInterval(intervalId);
            window.clearTimeout(stopTimer);
            intervalId = window.setInterval(() => {
                if (!document.contains(controls) || !isHorizontalReader()) {
                    stop();
                    return;
                }
                turnHorizontalPage();
            }, pageInterval);
            if (timeStopMinutes > 0) {
                stopTimer = window.setTimeout(stop, timeStopMinutes * 60000);
            }
            update();
        };

        toggleButton.addEventListener('click', () => {
            window.clearTimeout(toggleClickTimer);
            toggleClickTimer = window.setTimeout(() => playing ? stop() : start(), 250);
        });
        toggleButton.addEventListener('dblclick', () => {
            window.clearTimeout(toggleClickTimer);
            timeStopMinutes = promptNonNegativeNumber(
                '请输入自动停止时长（分钟）（默认：0，不自动停止）',
                timeStopMinutes
            );
            GM_setValue('timeStopmin', timeStopMinutes);
            update();
        });
        speedButton.addEventListener('click', () => {
            const oldInterval = pageInterval;
            pageInterval = promptNonNegativeNumber(
                '请输入双栏自动翻页间隔（毫秒）（最小：1000）',
                pageInterval,
                1000
            );
            GM_setValue('timePagedown', pageInterval);
            if (playing && pageInterval !== oldInterval) {
                window.clearInterval(intervalId);
                intervalId = window.setInterval(turnHorizontalPage, pageInterval);
            }
            update();
        });

        update();
    }

    function hideNativeReviewControl(controls) {
        controls.querySelectorAll('.showBookReviews, .showBookReviews_active').forEach((button) => {
            const nativeControl = button.closest('.wr_tooltip_container') || button;
            if (nativeControl.parentElement !== controls
                || nativeControl.dataset.lvNativeReviewHidden === 'true') {
                return;
            }
            nativeControl.dataset.lvNativeReviewHidden = 'true';
            nativeControl.style.setProperty('display', 'none', 'important');
        });
    }

    function restoreNativeReviewControl(controls) {
        controls.querySelectorAll('[data-lv-native-review-hidden="true"]').forEach((node) => {
            node.style.removeProperty('display');
            delete node.dataset.lvNativeReviewHidden;
        });
    }

    function initScrollAutoRead(controls) {
        const toggleButton = createTextControl('readToggle', '播放');
        const speedButton = createTextControl('readSpeed', '倍速');
        controls.append(toggleButton, speedButton);

        let playing = false;
        let animationFrameId = 0;
        let lastFrameTime = 0;
        let stopTimer = 0;
        let pageTimer = 0;
        let toggleClickTimer = 0;
        let speedClickTimer = 0;
        let pageTurnScheduled = false;
        let topHoldUntil = 0;
        const legacyScrollStep = clampNumber(GM_getValue('ynumDown', 1), -1000, 1000, 1);
        const legacyIntervalMs = clampNumber(GM_getValue('timeMillisec', 20), 1, Number.MAX_SAFE_INTEGER, 20);
        let scrollPixelsPerSecond = clampNumber(
            GM_getValue('scrollPixelsPerSecond', legacyScrollStep * 1000 / legacyIntervalMs),
            -10000,
            10000,
            50
        );
        let pageDelayMs = clampNumber(GM_getValue('timePagesec', 10000), 1000, Number.MAX_SAFE_INTEGER, 10000);
        let topDelayMs = clampNumber(GM_getValue('timeTopsec', 0), 0, Number.MAX_SAFE_INTEGER, 0);

        const update = () => {
            setControlText(toggleButton, playing ? '暂停' : '播放');
            toggleButton.title = playing
                ? `时长：${timeStopMinutes}（双击修改）`
                : `停留：${topDelayMs}（双击修改）`;
            speedButton.title = `速度：${scrollPixelsPerSecond} 像素/秒（按屏幕刷新率平滑执行；双击改翻页）`;
        };
        const stop = () => {
            playing = false;
            pageTurnScheduled = false;
            window.cancelAnimationFrame(animationFrameId);
            window.clearTimeout(stopTimer);
            window.clearTimeout(pageTimer);
            animationFrameId = 0;
            lastFrameTime = 0;
            stopTimer = 0;
            pageTimer = 0;
            update();
        };
        const tick = (frameTime) => {
            if (!document.contains(controls) || isHorizontalReader()) {
                stop();
                return;
            }

            if (!lastFrameTime) {
                lastFrameTime = frameTime;
            }
            const elapsedMs = Math.min(Math.max(frameTime - lastFrameTime, 0), 100);
            lastFrameTime = frameTime;
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
            const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
                - (window.innerHeight || document.documentElement.clientHeight || 0);

            if (scrollTop <= 10 && topDelayMs > 0) {
                if (!topHoldUntil) {
                    topHoldUntil = Date.now() + topDelayMs;
                }
                if (Date.now() < topHoldUntil) {
                    animationFrameId = window.requestAnimationFrame(tick);
                    return;
                }
            } else {
                topHoldUntil = 0;
            }

            window.scrollBy(0, scrollPixelsPerSecond * elapsedMs / 1000);
            const nextScrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
            if (nextScrollTop >= scrollHeight - 10) {
                if (!pageTurnScheduled) {
                    pageTurnScheduled = true;
                    pageTimer = window.setTimeout(dispatchArrowRight, pageDelayMs);
                }
            } else if (pageTurnScheduled) {
                pageTurnScheduled = false;
                window.clearTimeout(pageTimer);
            }
            animationFrameId = window.requestAnimationFrame(tick);
        };
        const start = () => {
            playing = true;
            pageTurnScheduled = false;
            topHoldUntil = 0;
            lastFrameTime = 0;
            window.cancelAnimationFrame(animationFrameId);
            window.clearTimeout(stopTimer);
            animationFrameId = window.requestAnimationFrame(tick);
            if (timeStopMinutes > 0) {
                stopTimer = window.setTimeout(stop, timeStopMinutes * 60000);
            }
            update();
        };

        toggleButton.addEventListener('click', () => {
            window.clearTimeout(toggleClickTimer);
            toggleClickTimer = window.setTimeout(() => playing ? stop() : start(), 250);
        });
        toggleButton.addEventListener('dblclick', () => {
            window.clearTimeout(toggleClickTimer);
            if (playing) {
                timeStopMinutes = promptNonNegativeNumber(
                    '请输入暂停时长（分钟）（默认：0，不自动暂停）',
                    timeStopMinutes
                );
                GM_setValue('timeStopmin', timeStopMinutes);
            } else {
                topDelayMs = promptNonNegativeNumber(
                    '请输入翻页停留（毫秒）（默认：0，不停留）',
                    topDelayMs
                );
                GM_setValue('timeTopsec', topDelayMs);
            }
            update();
        });

        speedButton.addEventListener('click', () => {
            window.clearTimeout(speedClickTimer);
            speedClickTimer = window.setTimeout(() => {
                const input = prompt(
                    '请输入每秒滚动的像素数（例如：12.5）',
                    String(scrollPixelsPerSecond)
                );
                if (input === null) {
                    return;
                }

                const value = Number(input.trim());
                if (!Number.isFinite(value)) {
                    alert('请输入每秒滚动的像素数，例如：12.5。');
                    return;
                }

                scrollPixelsPerSecond = clamp(value, -10000, 10000);
                GM_setValue('scrollPixelsPerSecond', scrollPixelsPerSecond);
                if (playing) {
                    lastFrameTime = 0;
                }
                update();
            }, 250);
        });
        speedButton.addEventListener('dblclick', () => {
            window.clearTimeout(speedClickTimer);
            pageDelayMs = promptNonNegativeNumber(
                '请输入翻页间隔（毫秒）（最小：1000）',
                pageDelayMs,
                1000
            );
            GM_setValue('timePagesec', pageDelayMs);
            update();
        });

        update();
    }

    function getScrollReviewHost() {
        const isUsable = (node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0
                && (rect.height > 0 || node.scrollHeight > 0)
                && (node.scrollHeight > 100 || String(node.textContent || '').trim());
        };
        const renderTargets = Array.from(document.querySelectorAll('.renderTargetContent'));
        const renderTarget = renderTargets.find(isUsable);
        if (renderTarget) {
            return renderTarget;
        }
        if (renderTargets.length) {
            return null;
        }
        return Array.from(document.querySelectorAll('.readerChapterContent')).find(isUsable) || null;
    }

    function ensureReviewLayer() {
        const textHost = getScrollReviewHost();
        const layerHost = textHost?.closest('.readerChapterContent') || textHost;
        if (!layerHost) {
            return null;
        }
        if (reviewLayer && reviewLayer.parentElement === layerHost) {
            return reviewLayer;
        }

        reviewLayer?.remove();
        closeNativeReviewPanel();
        if (getComputedStyle(layerHost).position === 'static') {
            layerHost.style.position = 'relative';
        }
        reviewLayer = document.createElement('div');
        reviewLayer.className = 'lv-review-underline-layer';
        reviewLayer.dataset.wrIgnore = '1';
        reviewLayoutKey = '';
        layerHost.appendChild(reviewLayer);
        return reviewLayer;
    }

    function hideScrollReviewMarks() {
        cancelStableReviewRender();
        reviewLayer?.remove();
        reviewLayer = null;
        renderedReviewGroups = [];
        renderedReviewRangeEnd = 1;
        renderedReviewSegmentCount = 0;
        renderedReviewTextHost = null;
        reviewLayoutKey = '';
        closeNativeReviewPanel();
    }

    function cancelScrollReviewLoad() {
        reviewLoadToken += 1;
        reviewAbortController?.abort();
        reviewAbortController = null;
    }

    function cancelStableReviewRender() {
        reviewStableRenderToken += 1;
        window.clearTimeout(reviewStableRenderTimer);
        reviewStableRenderTimer = 0;
    }

    function queueReviewUnderlines(groups, rangeEnd) {
        renderedReviewGroups = groups;
        renderedReviewRangeEnd = rangeEnd;
        cancelStableReviewRender();
        if (!reviewMarksEnabled || isHorizontalReader()) {
            return;
        }
        const queuedTextHost = getScrollReviewHost();
        renderedReviewTextHost = queuedTextHost;
        reviewLayoutKey = getReviewLayoutKey(queuedTextHost);
        if (!groups.length) {
            reviewLayer?.replaceChildren();
            renderedReviewSegmentCount = 0;
            return;
        }

        const token = reviewStableRenderToken;
        const waitMs = Math.max(0, REVIEW_CONTENT_STABLE_MS - (Date.now() - reviewContentChangedAt));
        reviewStableRenderTimer = window.setTimeout(() => {
            reviewStableRenderTimer = 0;
            if (token !== reviewStableRenderToken || !reviewMarksEnabled || isHorizontalReader()) {
                return;
            }
            const textHost = getScrollReviewHost();
            if (!isReviewTextHostReady(textHost)) {
                reviewContentChangedAt = Date.now();
                queueReviewUnderlines(renderedReviewGroups, renderedReviewRangeEnd);
                return;
            }

            const fontsReady = document.fonts?.ready || Promise.resolve();
            Promise.resolve(fontsReady).catch(() => undefined).then(() => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                    if (token !== reviewStableRenderToken || !reviewMarksEnabled || isHorizontalReader()) {
                        return;
                    }
                    if (Date.now() - reviewContentChangedAt < REVIEW_CONTENT_STABLE_MS) {
                        queueReviewUnderlines(renderedReviewGroups, renderedReviewRangeEnd);
                        return;
                    }
                    renderReviewUnderlines(renderedReviewGroups, renderedReviewRangeEnd);
                }));
            });
        }, waitMs);
    }

    function isReviewTextHostReady(host) {
        if (!host) {
            return false;
        }
        const rect = host.getBoundingClientRect();
        const declaredHeight = Number.parseFloat(host.style.height || '0');
        const heightIsSettled = !declaredHeight || Math.abs(declaredHeight - host.scrollHeight) <= 2;
        const imagesAreReady = Array.from(host.querySelectorAll('img')).every((image) => image.complete);
        return rect.width > 0
            && Math.max(rect.height, host.scrollHeight) > 100
            && String(host.textContent || '').trim().length > 0
            && host.childElementCount > 0
            && heightIsSettled
            && imagesAreReady;
    }

    async function refreshScrollReviewMarks(force = false) {
        if (isHorizontalReader() || !reviewMarksEnabled) {
            cancelScrollReviewLoad();
            reviewMarksChapterKey = '';
            hideScrollReviewMarks();
            return;
        }

        const layer = ensureReviewLayer();
        if (!layer) {
            return;
        }
        const title = getCurrentReviewChapterTitle();
        const chapterKey = normalizeText(title);
        if (!chapterKey) {
            layer.replaceChildren();
            return;
        }
        if (!force && chapterKey === reviewMarksChapterKey) {
            const textHost = getScrollReviewHost();
            const textHostChanged = textHost !== renderedReviewTextHost;
            const layoutChanged = getReviewLayoutKey(textHost) !== reviewLayoutKey;
            const renderedSegmentsWereRemoved = renderedReviewSegmentCount > 0
                && !layer.querySelector('.lv-review-underline-wrapper');
            if (renderedReviewGroups.length
                && (textHostChanged || layoutChanged || renderedSegmentsWereRemoved)) {
                queueReviewUnderlines(renderedReviewGroups, renderedReviewRangeEnd);
            }
            return;
        }

        reviewMarksChapterKey = chapterKey;
        cancelScrollReviewLoad();
        cancelStableReviewRender();
        reviewContentChangedAt = Date.now();
        const loadToken = reviewLoadToken;
        const abortController = new AbortController();
        reviewAbortController = abortController;
        layer.replaceChildren();
        renderedReviewGroups = [];
        renderedReviewRangeEnd = 1;
        renderedReviewSegmentCount = 0;
        renderedReviewTextHost = null;
        reviewLayoutKey = '';
        closeNativeReviewPanel();

        try {
            const context = await getReviewChapterContext(title, abortController.signal);
            if (loadToken !== reviewLoadToken || abortController.signal.aborted) {
                return;
            }
            if (!context) {
                layer.replaceChildren();
                return;
            }

            const rangeEnd = Math.max(1, Number(context.chapter.wordCount || 0));
            const groups = await getScrollChapterReviewGroups(
                context,
                (partialGroups) => {
                    if (loadToken !== reviewLoadToken
                        || abortController.signal.aborted
                        || !reviewMarksEnabled
                        || isHorizontalReader()) {
                        return false;
                    }
                    queueReviewUnderlines(partialGroups, rangeEnd);
                    return true;
                },
                abortController.signal
            );
            if (loadToken !== reviewLoadToken || abortController.signal.aborted) {
                return;
            }
            console.info('[weixin-read-wide] 滚动模式书友想法', JSON.stringify({
                chapter: title,
                chapterUid: context.chapter.chapterUid,
                receivedRanges: groups.length,
                receivedReviews: groups.reduce((sum, group) => sum + getReviewsFromGroup(group).length, 0)
            }));
            if (renderedReviewGroups !== groups) {
                queueReviewUnderlines(groups, rangeEnd);
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            if (loadToken === reviewLoadToken && reviewMarksEnabled) {
                layer.replaceChildren();
            }
            console.warn('[weixin-read-wide] 读取书友想法失败', error);
        } finally {
            if (reviewAbortController === abortController) {
                reviewAbortController = null;
            }
        }
    }

    async function getScrollChapterReviewGroups(context, onProgress, signal) {
        const chapterUid = context.chapter.chapterUid;
        const cacheKey = `${context.bookId}:${chapterUid}`;
        if (reviewDataCache.has(cacheKey)) {
            const cachedGroups = reviewDataCache.get(cacheKey);
            onProgress?.(cachedGroups);
            return cachedGroups;
        }

        const underlineResponse = await fetch(
            `/web/book/underlines?bookId=${encodeURIComponent(context.bookId)}&chapterUid=${encodeURIComponent(chapterUid)}`,
            { credentials: 'include', signal }
        );
        const underlinePayload = await underlineResponse.json();
        if (!underlineResponse.ok || Number(underlinePayload.errCode || 0) !== 0) {
            throw new Error(`underlines HTTP ${underlineResponse.status}`);
        }

        const underlines = Array.isArray(underlinePayload.underlines)
            ? underlinePayload.underlines
            : Array.isArray(underlinePayload?.data?.underlines) ? underlinePayload.data.underlines : [];
        const underlineByRange = new Map();
        underlines.forEach((underline) => {
            const range = String(underline?.range || '').trim();
            if (/^\d+-\d+$/.test(range) && !underlineByRange.has(range)) {
                underlineByRange.set(range, underline);
            }
        });
        const ranges = Array.from(underlineByRange.keys());
        const groups = [];

        for (let offset = 0; offset < ranges.length; offset += REVIEW_BATCH_SIZE) {
            const batch = ranges.slice(offset, offset + REVIEW_BATCH_SIZE);
            const response = await fetch('/web/book/readReviews', {
                method: 'POST',
                credentials: 'include',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bookId: context.bookId,
                    chapterUid: normalizeChapterUid(chapterUid),
                    reviews: batch.map((range) => ({
                        range,
                        maxIdx: 0,
                        count: 30,
                        synckey: 0
                    }))
                })
            });
            const payload = await response.json();
            if (!response.ok || Number(payload.errCode || 0) !== 0) {
                throw new Error(`readReviews HTTP ${response.status}`);
            }

            const batchGroups = Array.isArray(payload.reviews)
                ? payload.reviews
                : Array.isArray(payload?.data?.reviews) ? payload.data.reviews : [];
            groups.push(...batchGroups
                .filter((group) => getReviewsFromGroup(group).length > 0)
                .map((group) => ({
                    ...group,
                    lvUnderline: underlineByRange.get(
                        String(group?.range || group?.review?.range || '').trim()
                    ) || null
                })));
            if (onProgress?.(groups) === false) {
                throw new DOMException('Aborted', 'AbortError');
            }
            if (offset + REVIEW_BATCH_SIZE < ranges.length) {
                await delay(REVIEW_BATCH_DELAY_MS, signal);
            }
        }

        reviewDataCache.set(cacheKey, groups);
        return groups;
    }

    function renderReviewUnderlines(groups, rangeEnd) {
        const layer = ensureReviewLayer();
        if (!layer) {
            return;
        }
        layer.replaceChildren();
        closeNativeReviewPanel();
        renderedReviewGroups = groups;
        renderedReviewRangeEnd = rangeEnd;
        renderedReviewSegmentCount = 0;
        const textHost = getScrollReviewHost();
        renderedReviewTextHost = textHost;
        if (!textHost) {
            reviewLayoutKey = '';
            return;
        }
        if (!groups.length) {
            reviewLayoutKey = getReviewLayoutKey(textHost);
            return;
        }

        const layerHost = layer.parentElement;
        const layerHostRect = layerHost.getBoundingClientRect();
        const layerHeight = Math.max(layerHost.scrollHeight, layerHostRect.height, 1);
        layer.style.height = `${layerHeight}px`;
        const textIndex = buildReviewTextIndex(textHost);
        if (!textIndex.nodes.length || !textIndex.text.length) {
            reviewLayoutKey = getReviewLayoutKey(textHost);
            return;
        }
        const sourceRangeEnd = Math.max(
            1,
            Number(rangeEnd || 0),
            ...groups.map((group) => getReviewRange(group).end)
        );
        let mappedGroups = 0;
        let segmentCount = 0;

        groups.forEach((group, index) => {
            const reviews = getReviewsFromGroup(group);
            const sourceRange = resolveReviewTextRange(
                textIndex,
                group,
                getReviewRange(group),
                sourceRangeEnd
            );
            const rects = getReviewClientRects(textIndex, sourceRange)
                .filter((rect) => rect.width > 1 && rect.height > 1)
                .slice(0, 30);
            if (!rects.length) {
                return;
            }

            mappedGroups += 1;
            rects.forEach((rect) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'wr_underline_wrapper wr_underline_color_0 lv-review-underline-wrapper';
                wrapper.dataset.reviewIndex = String(index);
                wrapper.style.width = `${rect.width}px`;
                wrapper.style.height = `${Math.max(1, rect.height - 1)}px`;
                wrapper.style.left = `${rect.left - layerHostRect.left + layerHost.scrollLeft}px`;
                wrapper.style.top = `${rect.top - layerHostRect.top + layerHost.scrollTop}px`;

                const underline = document.createElement('div');
                underline.className = 'wr_underline wr_underline_thought lv-review-underline';
                underline.setAttribute('role', 'button');
                underline.tabIndex = 0;
                underline.style.width = `${rect.width}px`;
                underline.style.height = `${rect.height}px`;
                const open = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openNativeReviewPanel(underline, reviews, index);
                };
                underline.addEventListener('click', open);
                underline.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        open(event);
                    }
                });
                wrapper.appendChild(underline);
                layer.appendChild(wrapper);
                segmentCount += 1;
            });
        });

        reviewLayoutKey = getReviewLayoutKey(textHost);
        renderedReviewSegmentCount = segmentCount;
        console.info('[weixin-read-wide] 滚动模式原生下划线', JSON.stringify({
            groups: groups.length,
            mappedGroups,
            segments: segmentCount,
            rangeEnd
        }));
    }

    function buildReviewTextIndex(host) {
        const nodes = [];
        let text = '';
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || !node.nodeValue) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.closest('.lv-review-underline-layer, .lv-review-native-panel, script, style, noscript, textarea, button')) {
                    return NodeFilter.FILTER_REJECT;
                }
                const style = getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let node = walker.nextNode();
        while (node) {
            const value = node.nodeValue || '';
            const start = text.length;
            text += value;
            nodes.push({ node, start, end: text.length });
            node = walker.nextNode();
        }

        const normalized = buildNormalizedTextMap(text);
        return { text, nodes, normalizedText: normalized.text, normalizedRawIndexes: normalized.rawIndexes };
    }

    function buildNormalizedTextMap(text) {
        let normalized = '';
        const rawIndexes = [];
        let previousWasWhitespace = false;
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            const isWhitespace = /\s/.test(character);
            if (isWhitespace) {
                if (!previousWasWhitespace && normalized.length) {
                    normalized += ' ';
                    rawIndexes.push(index);
                }
            } else {
                normalized += character;
                rawIndexes.push(index);
            }
            previousWasWhitespace = isWhitespace;
        }
        return { text: normalized.trim(), rawIndexes };
    }

    function resolveReviewTextRange(textIndex, group, fallbackRange, sourceRangeEnd) {
        const shouldScale = sourceRangeEnd > textIndex.text.length * 1.1;
        const scale = shouldScale ? textIndex.text.length / sourceRangeEnd : 1;
        const expectedStart = clamp(
            Math.round(fallbackRange.start * scale),
            0,
            Math.max(0, textIndex.text.length - 1)
        );
        const markedText = getReviewMarkedText(group);
        if (markedText) {
            const exactStart = findNearestTextOccurrence(textIndex.text, markedText, expectedStart);
            if (exactStart >= 0) {
                return { start: exactStart, end: exactStart + markedText.length };
            }

            const normalizedNeedle = markedText.replace(/\s+/g, ' ').trim();
            const expectedNormalizedStart = getNormalizedOffsetForRawOffset(
                textIndex.normalizedRawIndexes,
                expectedStart
            );
            const normalizedStart = findNearestTextOccurrence(
                textIndex.normalizedText,
                normalizedNeedle,
                expectedNormalizedStart
            );
            if (normalizedStart >= 0 && normalizedNeedle.length) {
                const rawStart = textIndex.normalizedRawIndexes[normalizedStart];
                const rawLast = textIndex.normalizedRawIndexes[normalizedStart + normalizedNeedle.length - 1];
                if (Number.isFinite(rawStart) && Number.isFinite(rawLast)) {
                    return { start: rawStart, end: rawLast + 1 };
                }
            }
        }

        const start = expectedStart;
        const scaledEnd = Math.round(fallbackRange.end * scale);
        const end = clamp(Math.max(start + 1, scaledEnd), start + 1, textIndex.text.length);
        return { start, end };
    }

    function getNormalizedOffsetForRawOffset(rawIndexes, rawOffset) {
        const index = rawIndexes.findIndex((value) => value >= rawOffset);
        return index >= 0 ? index : rawIndexes.length;
    }

    function getReviewMarkedText(group) {
        const underline = group?.lvUnderline || {};
        const values = [
            underline.markText,
            underline.underlineText,
            underline.text,
            underline.content,
            underline?.review?.markText,
            group?.markText,
            group?.underlineText
        ];
        const value = values.find((item) => typeof item === 'string' && item.trim());
        return value ? htmlToText(value) : '';
    }

    function findNearestTextOccurrence(haystack, needle, expectedStart) {
        if (!needle || !haystack) {
            return -1;
        }
        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        let searchFrom = 0;
        while (searchFrom <= haystack.length) {
            const index = haystack.indexOf(needle, searchFrom);
            if (index < 0) {
                break;
            }
            const distance = Math.abs(index - expectedStart);
            if (distance < bestDistance) {
                bestIndex = index;
                bestDistance = distance;
            }
            searchFrom = index + Math.max(1, needle.length);
        }
        return bestIndex;
    }

    function getReviewClientRects(textIndex, range) {
        const start = locateReviewTextOffset(textIndex.nodes, range.start, false);
        const end = locateReviewTextOffset(textIndex.nodes, range.end, true);
        if (!start || !end) {
            return [];
        }
        try {
            const selectionRange = document.createRange();
            selectionRange.setStart(start.node, start.offset);
            selectionRange.setEnd(end.node, end.offset);
            return Array.from(selectionRange.getClientRects());
        } catch (error) {
            return [];
        }
    }

    function locateReviewTextOffset(nodes, targetOffset, isEnd) {
        if (!nodes.length) {
            return null;
        }
        const boundedOffset = Math.max(0, targetOffset);
        for (const entry of nodes) {
            if (boundedOffset < entry.end || (isEnd && boundedOffset === entry.end)) {
                return {
                    node: entry.node,
                    offset: clamp(boundedOffset - entry.start, 0, entry.node.nodeValue.length)
                };
            }
        }
        const last = nodes[nodes.length - 1];
        return { node: last.node, offset: last.node.nodeValue.length };
    }

    function getReviewLayoutKey(host) {
        if (!host) {
            return '';
        }
        const style = getComputedStyle(host);
        const text = String(host.textContent || '');
        const middle = Math.max(0, Math.floor(text.length / 2) - 24);
        const textSample = `${text.slice(0, 48)}|${text.slice(middle, middle + 48)}|${text.slice(-48)}`;
        return [
            host.clientWidth,
            host.scrollHeight,
            style.fontSize,
            style.lineHeight,
            text.length,
            hashReviewTextSample(textSample)
        ].join(':');
    }

    function hashReviewTextSample(text) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function openNativeReviewPanel(anchor, reviews, index) {
        if (reviewPopover?.dataset.reviewIndex === String(index)) {
            closeNativeReviewPanel();
            return;
        }
        closeNativeReviewPanel();

        const panel = createReviewElement(
            'div',
            'reader_float_review_with_range_panel_wrapper lv-review-native-panel',
            ['data-v-8ba546d8', 'data-v-33aa0108']
        );
        reviewPopover = panel;
        reviewPopover.dataset.reviewIndex = String(index);

        const mask = createReviewElement('div', 'wr_mask wr_mask_Show', ['data-v-8ba546d8']);
        mask.dataset.wrIgnore = '1';
        mask.addEventListener('click', closeNativeReviewPanel);
        const positionWrapper = createReviewElement(
            'div',
            'float_panel_position_wrapper',
            ['data-v-50c3a418', 'data-v-8ba546d8']
        );
        positionWrapper.dataset.wrIgnore = '1';
        const anchorRect = anchor.getBoundingClientRect();
        const panelWidth = Math.min(420, window.innerWidth - 32);
        const panelMaxHeight = Math.min(663, window.innerHeight - 32);
        const placeRight = anchorRect.right + 16 + panelWidth <= window.innerWidth - 16;
        const left = placeRight
            ? anchorRect.right + 16
            : Math.max(16, anchorRect.left - panelWidth - 16);
        const top = clamp(anchorRect.top - 60, 16, Math.max(16, window.innerHeight - panelMaxHeight - 16));
        positionWrapper.style.left = `${left}px`;
        positionWrapper.style.top = `${top}px`;
        positionWrapper.style.maxHeight = `${panelMaxHeight}px`;

        const arrow = createReviewElement(
            'span',
            `reader_floatReviewsPanel_content_arrow reader_floatReviewsPanel_content_arrow_${placeRight ? 'left' : 'right'}`,
            ['data-v-50c3a418']
        );
        arrow.style.top = `${clamp(anchorRect.top - top + anchorRect.height / 2 - 8, 12, panelMaxHeight - 28)}px`;
        arrow.style.zIndex = '99999';

        const content = createReviewElement(
            'div',
            'reviews_panel reader_float_panel_container reader_floatReviewsPanel_content reader_float_panel_container_overflowed reader_float_panel_container_with_dynamic_header_border',
            ['data-v-1358ac80', 'data-v-8ba546d8', 'data-v-50c3a418']
        );
        content.dataset.wrIgnore = '1';
        const headerWrapper = createReviewElement('div', 'reader_float_panel_header_wrapper', ['data-v-1358ac80']);
        const header = createReviewElement('div', 'reader_float_panel_header', ['data-v-1358ac80']);
        const title = document.createElement('span');
        title.className = 'reader_float_panel_header_title';
        title.textContent = '热门想法';
        const closeButton = document.createElement('div');
        closeButton.className = 'reader_float_panel_header_closeBtn';
        closeButton.innerHTML = getReviewCloseIcon();
        closeButton.addEventListener('click', closeNativeReviewPanel);
        header.append(title, closeButton);
        headerWrapper.appendChild(header);

        const contentWrapper = createReviewElement('div', 'reader_float_panel_content_wrapper', ['data-v-1358ac80']);
        const list = createReviewElement(
            'div',
            'reader_floatReviewsPanel_list_wrapper',
            ['data-v-8ba546d8', 'data-v-1358ac80']
        );
        reviews.slice(0, 30).forEach((reviewItem) => list.appendChild(createNativeReviewItem(reviewItem)));
        contentWrapper.appendChild(list);
        const footerWrapper = createReviewElement('div', 'reader_float_panel_footer_wrapper', ['data-v-1358ac80']);
        content.append(headerWrapper, contentWrapper, footerWrapper);
        positionWrapper.append(arrow, content);
        panel.append(mask, positionWrapper);
        document.body.appendChild(panel);

        reviewPanelKeyHandler = (event) => {
            if (event.key === 'Escape') {
                closeNativeReviewPanel();
            }
        };
        document.addEventListener('keydown', reviewPanelKeyHandler, true);
    }

    function createNativeReviewItem(reviewItem) {
        const review = reviewItem?.review || reviewItem || {};
        const item = createReviewElement(
            'div',
            'reader_float_reviews_panel_item reader_floatReviewsPanel_list_item',
            ['data-v-0b75434f', 'data-v-8ba546d8', 'data-v-1358ac80']
        );
        const top = createReviewElement('div', 'reader_float_reviews_panel_item_top_container', ['data-v-0b75434f']);
        const header = createReviewElement('div', 'reader_float_reviews_panel_item_header', ['data-v-0b75434f']);
        const avatar = createReviewElement(
            'div',
            'reader_float_reviews_panel_item_header_avatar wr_avatar',
            ['data-v-0b75434f']
        );
        avatar.setAttribute('size', '20');
        const avatarUrl = getReviewAvatarUrl(review);
        if (avatarUrl) {
            const image = document.createElement('img');
            image.className = 'wr_avatar_img';
            image.src = avatarUrl;
            avatar.appendChild(image);
        }
        const name = createReviewElement('span', 'reader_float_reviews_panel_item_header_name', ['data-v-0b75434f']);
        name.textContent = getReviewAuthorName(review);
        header.append(avatar, name);
        const body = createReviewElement('div', 'reader_float_reviews_panel_item_content', ['data-v-0b75434f']);
        body.textContent = htmlToText(review.content || review.abstract || reviewItem.content || '');
        const divider = createReviewElement('div', 'reader_float_reviews_panel_item_content_divider', ['data-v-0b75434f']);
        top.append(header, body, divider);

        const bottom = createReviewElement('div', 'reader_float_reviews_panel_item_bottom_container', ['data-v-0b75434f']);
        bottom.append(
            createNativeReviewStat('like', getReviewLikeCount(review)),
            createNativeReviewStat('comment', getReviewCommentCount(review))
        );
        item.append(top, bottom);
        return item;
    }

    function createNativeReviewStat(type, count) {
        const item = createReviewElement('div', 'reader_float_reviews_panel_item_bottom_item', ['data-v-0b75434f']);
        const iconTemplate = document.createElement('template');
        iconTemplate.innerHTML = type === 'like' ? getReviewLikeIcon() : getReviewCommentIcon();
        const icon = iconTemplate.content.firstElementChild;
        icon.classList.add(
            'reader_float_reviews_panel_item_bottom_item_icon',
            `reader_float_reviews_panel_item_bottom_item_${type}_icon`
        );
        icon.setAttribute('data-v-0b75434f', '');
        const countNode = createReviewElement(
            'div',
            `reader_float_reviews_panel_item_bottom_item_count reader_float_reviews_panel_item_bottom_item_${type}_count`,
            ['data-v-0b75434f']
        );
        countNode.textContent = String(count);
        if (!count) {
            countNode.style.display = 'none';
        }
        item.append(icon, countNode);
        return item;
    }

    function createReviewElement(tagName, className, scopeAttributes = []) {
        const node = document.createElement(tagName);
        node.className = className;
        scopeAttributes.forEach((attribute) => node.setAttribute(attribute, ''));
        return node;
    }

    function getReviewAuthorName(review) {
        return review?.author?.name
            || (typeof review?.author === 'string' ? review.author : '')
            || review?.user?.name
            || review?.name
            || '微信读书用户';
    }

    function getReviewAvatarUrl(review) {
        return review?.author?.avatar
            || review?.author?.avatarUrl
            || review?.user?.avatar
            || review?.user?.avatarUrl
            || review?.avatar
            || '';
    }

    function getReviewLikeCount(review) {
        const count = Number(review?.likeCount || review?.praiseCount || review?.likesCount || 0);
        return Number.isFinite(count) ? Math.max(0, count) : 0;
    }

    function getReviewCommentCount(review) {
        const count = Number(review?.commentCount || review?.commentsCount || 0);
        return Number.isFinite(count) ? Math.max(0, count) : 0;
    }

    function getReviewCloseIcon() {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.0003 13.5902L19.1168 20.7066L20.7078 19.1156L13.5913 11.9992L20.708 4.88259L19.117 3.29159L12.0003 10.4082L4.88353 3.2915L3.29254 4.8825L10.4093 11.9992L3.2928 19.1157L4.88378 20.7067L12.0003 13.5902Z" fill="currentColor"></path></svg>';
    }

    function getReviewLikeIcon() {
        return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.0253 4.30116C14.3123 2.58587 17.5721 2.76788 19.6522 4.84804C21.7323 6.92821 21.9144 10.1881 20.1991 12.475L20.2577 12.5326L11.9999 20.7894L3.74306 12.5326L3.80165 12.475C2.08636 10.188 2.26836 6.9282 4.34853 4.84804C6.42869 2.76788 9.6885 2.58587 11.9755 4.30116L11.9999 4.27577L12.0253 4.30116ZM18.5907 5.90858C17.0596 4.37785 14.6394 4.21532 12.9257 5.50038L12.8095 5.58827L12.1161 6.28163L11.9999 6.19472L11.8847 6.28163L11.1913 5.58827L11.0751 5.50038C9.3612 4.21508 6.94019 4.37747 5.40907 5.90858C3.87796 7.4397 3.71557 9.86071 5.00087 11.5746L5.287 11.9555L11.9999 18.6684L18.7138 11.9555L18.9989 11.5746C20.2844 9.8607 20.1219 7.43976 18.5907 5.90858Z" fill="currentColor"></path></svg>';
    }

    function getReviewCommentIcon() {
        return '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M18.3334 4.125H4.58335C4.07709 4.125 3.66669 4.53541 3.66669 5.04167V14.6667C3.66669 15.1729 4.07709 15.5833 4.58335 15.5833H6.87502V18.7917L11.4584 15.5833H18.3334C18.8396 15.5833 19.25 15.1729 19.25 14.6667V5.04167C19.25 4.53541 18.8396 4.125 18.3334 4.125ZM5.0417 14.2083V5.5H17.875V14.2083H11.0249L8.25003 16.1508V14.2083H5.0417Z" fill="currentColor"></path></svg>';
    }

    function closeNativeReviewPanel() {
        if (reviewPanelKeyHandler) {
            document.removeEventListener('keydown', reviewPanelKeyHandler, true);
            reviewPanelKeyHandler = null;
        }
        reviewPopover?.remove();
        reviewPopover = null;
    }

    function getReviewsFromGroup(group) {
        if (Array.isArray(group?.reviews)) {
            return group.reviews;
        }
        if (Array.isArray(group?.pageReviews)) {
            return group.pageReviews;
        }
        if (group?.review || group?.content) {
            return [group];
        }
        return [];
    }

    function getReviewRange(group) {
        const value = String(group?.range || group?.review?.range || '0-0');
        const numbers = value.match(/\d+/g)?.map(Number) || [0, 0];
        return {
            start: Math.max(0, Number(numbers[0] || 0)),
            end: Math.max(0, Number(numbers[1] || numbers[0] || 0))
        };
    }

    async function getReviewChapterContext(title, signal) {
        const bookId = getBookId();
        if (!bookId) {
            return null;
        }

        if (!chapterInfoCache || chapterInfoCache.bookId !== bookId) {
            const response = await fetch('/web/book/publicchapterInfos', {
                method: 'POST',
                credentials: 'include',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookIds: [bookId] })
            });
            const payload = await response.json();
            const chapters = payload?.data?.[0]?.updated;
            chapterInfoCache = {
                bookId,
                chapters: Array.isArray(chapters) ? chapters : []
            };
        }

        const normalizedTitle = normalizeText(title);
        const chapter = chapterInfoCache.chapters.find((item) => normalizeText(item.title) === normalizedTitle)
            || chapterInfoCache.chapters.find((item) => normalizedTitle.includes(normalizeText(item.title)));
        return chapter ? { bookId, chapter } : null;
    }

    function getCurrentReviewChapterTitle() {
        return document.querySelector('.readerCatalog_list_item_selected .readerCatalog_list_item_title_text')
            ?.textContent?.trim()
            || document.querySelector('.readerTopBar_title_chapter')?.textContent?.trim()
            || '';
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

    function htmlToText(html) {
        const node = document.createElement('div');
        node.innerHTML = String(html || '').replace(/<br\s*\/?\s*>/gi, '\n');
        return (node.textContent || '').trim();
    }

    function createTextControl(className, text) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `readerControls_item lv-reader-control ${className}`;
        const icon = document.createElement('span');
        icon.className = `iconRead ${className === 'readToggle' ? 'iconToggle' : 'iconSpeed'}`;
        icon.textContent = text;
        button.appendChild(icon);
        return button;
    }

    function setControlText(button, text) {
        const icon = button.querySelector('.iconRead');
        if (icon) {
            icon.textContent = text;
        }
    }

    function installKeyboardShortcuts() {
        const handleSpace = (event) => {
            const isSpace = event.key === ' '
                || event.key === 'Spacebar'
                || event.code === 'Space';
            if (!isSpace || spaceIndex !== 0 || isEditableTarget(event.target)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (event.type === 'keydown' && !event.repeat) {
                document.querySelector('.readerControls .readToggle')?.click();
            }
        };

        document.addEventListener('keydown', handleSpace, true);
        document.addEventListener('keypress', handleSpace, true);
        document.addEventListener('keyup', handleSpace, true);
    }

    function dispatchArrowRight() {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            which: 39,
            bubbles: true
        }));
    }

    function turnHorizontalPage() {
        const nextButton = document.querySelector('button.renderTarget_pager_button_right');
        if (nextButton && !nextButton.disabled) {
            nextButton.click();
            return;
        }
        dispatchArrowRight();
    }

    function isHorizontalReader() {
        return Boolean(document.querySelector('.wr_horizontalReader'));
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }
        const tagName = target.tagName;
        return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
    }

    function promptNonNegativeNumber(message, currentValue, minimum = 0) {
        const input = prompt(message, String(currentValue));
        if (input === null) {
            return currentValue;
        }
        const value = Number(input.trim());
        return Number.isFinite(value) ? Math.max(minimum, value) : currentValue;
    }

    function normalizeChapterUid(chapterUid) {
        const numericUid = Number(chapterUid);
        return Number.isSafeInteger(numericUid) ? numericUid : chapterUid;
    }

    function delay(milliseconds, signal) {
        if (signal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                signal?.removeEventListener('abort', abort);
                resolve();
            }, milliseconds);
            const abort = () => {
                window.clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    function normalizeIndex(value, length) {
        const index = Math.floor(Number(value));
        return Number.isFinite(index) && index >= 0 && index < length ? index : 0;
    }

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? clamp(number, min, max) : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, '')
            .replace(/[\u00b7\u2022\u30fb]/g, '')
            .trim();
    }
})();
