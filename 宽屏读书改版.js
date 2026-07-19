// ==UserScript==
// @name    微信读书
// @icon    https://weread.qq.com/favicon.ico
// @namespace    https://greasyfork.org/users/878514
// @version    20260719.3
// @description    经典阅读器宽屏显示、自动阅读、空格翻页、右侧快捷按钮与目录位置调整；双栏阅读器保留基础布局和书友想法按钮。
// @author    Velens
// @match    https://weread.qq.com/web/reader/*
// @require    https://code.jquery.com/jquery-3.6.0.min.js
// @license    MIT
// @grant    GM_addStyle
// @grant    GM_registerMenuCommand
// @grant    GM_setValue
// @grant    GM_getValue
// @downloadURL https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.user.js
// @updateURL https://update.greasyfork.org/scripts/440339/%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6.meta.js
// ==/UserScript==


/* globals jQuery, $, waitForKeyElements */
const widths = [{titlew:"满列",width:"100%",align_items:"flex-end",margin_left:"45.5%"},{titlew:"宽列",width:"80%",align_items:"center",margin_left:"41.5%"},{titlew:"默认",width:"",align_items:"flex-start",margin_left:""}];
const SCROLL_BOOK_REVIEW_STATE_KEY = "scrollShowBookReviews";
const CATALOG_SHIFT_KEY = "catalogShiftPx";
const SPACE_PLAY_PAUSE_KEY = "spacePlayPauseEnabled";
let iw = GM_getValue("numw",0);
let spacePlayPauseEnabled = GM_getValue(SPACE_PLAY_PAUSE_KEY,true) !== false;
let catalogShiftPx = Number(GM_getValue(CATALOG_SHIFT_KEY,0));
if(!Number.isFinite(catalogShiftPx)){catalogShiftPx = 0;}
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

function getBookReviewConfig(payload){
    if(!payload || typeof payload !== 'object'){return null;}
    const config = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if(config.displayTopReview === undefined || config.displayTopReview === null){return null;}
    return Boolean(Number(config.displayTopReview));
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

async function toggleScrollBookReviews(button){
    const previous = scrollBookReviewsEnabled;
    const requestId = ++scrollBookReviewsRequestId;
    scrollBookReviewsEnabled = !previous;
    updateScrollBookReviewButton(button,true);
    try{
        const response = await fetch('/web/user_config/modify',{
            method:'POST',
            credentials:'include',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({displayTopReview:scrollBookReviewsEnabled ? 1 : 0})
        });
        const payload = await response.json();
        if(!response.ok || Number(payload && payload.errCode || 0) !== 0){
            throw new Error(`HTTP ${response.status}`);
        }
        if(requestId !== scrollBookReviewsRequestId){return;}
        GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,scrollBookReviewsEnabled);
        updateScrollBookReviewButton(button,false);
    }catch(error){
        if(requestId !== scrollBookReviewsRequestId){return;}
        scrollBookReviewsEnabled = previous;
        updateScrollBookReviewButton(button,false);
        console.warn('[weixin-read-wide] 切换书友想法失败',error);
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

    if(document.querySelector('.wr_horizontalReader')){
        const nativeButton = controls.querySelector('.showBookReviews_active, .showBookReviews');
        if(nativeButton && !nativeButton.classList.contains('lv-scroll-book-reviews')){
            scrollBookReviewsEnabled = nativeButton.classList.contains('showBookReviews_active');
            GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,scrollBookReviewsEnabled);
        }
        controls.querySelector('.lv-scroll-book-reviews-control')?.remove();
        return;
    }

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
    syncBookReviewControl();
    new MutationObserver(syncBookReviewControl).observe(document.documentElement,{
        childList:true,
        subtree:true
    });

    if(!document.querySelector('.wr_horizontalReader')){
        fetch('/web/user_config',{credentials:'include'})
            .then(function(response){return response.ok ? response.json() : null;})
            .then(function(payload){
                const enabled = getBookReviewConfig(payload);
                if(enabled === null){return;}
                scrollBookReviewsEnabled = enabled;
                GM_setValue(SCROLL_BOOK_REVIEW_STATE_KEY,enabled);
                updateScrollBookReviewButton(document.querySelector('.lv-scroll-book-reviews'),false);
            })
            .catch(function(error){console.warn('[weixin-read-wide] 读取书友想法设置失败',error);});
    }
}

initBookReviewControl();

if (!document.querySelector(".wr_horizontalReader")){
    GM_addStyle(`.reader-font-control-panel-wrapper .font-panel-content-arrow {display: none;}`);
    GM_addStyle(`.wr_whiteTheme .reader-font-control-panel-wrapper .font-panel-content-arrow {display: none;}`);

    GM_registerMenuCommand("宽度：" + widths[iw].titlew,width)
    if(widths[iw].titlew != "默认"){
        GM_addStyle(`.readerContent .app_content, .readerTopBar {max-width: ${widths[iw].width};}`);
        GM_addStyle(`.readerControls {align-items: ${widths[iw].align_items};}`);
        GM_addStyle(`.readerControls {margin-left: ${widths[iw].margin_left};}`);}
    function width(){
        if(iw < widths.length-1){iw++;}
        else{iw = 0;}
        GM_setValue("numw",iw);
        location.reload();
    };

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
