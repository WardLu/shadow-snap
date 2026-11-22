/**
 * 影瞬 Shadow Snap - Cinema Studio Pro
 * 纯本地浏览器 Canvas 院线级台词切割与拼接引擎
 */

import { QUOTES, TRANS } from "./translations.mjs";
import { applyLocaleSeo, localeFromPath, SEO } from "./seo-content.mjs";

const STYLE_PRESETS = {
    nolan: {
        fontColor: "#ffffff",
        strokeColor: "#000000",
        barHeight: 48,
        fontSize: 22,
        paddingX: 32
    },
    wong: {
        fontColor: "#fbbf24",
        strokeColor: "#18181b",
        barHeight: 52,
        fontSize: 22,
        paddingX: 32
    },
    tokyo: {
        fontColor: "#a5f3fc",
        strokeColor: "#0c4a6e",
        barHeight: 46,
        fontSize: 20,
        paddingX: 28
    },
    french: {
        fontColor: "#ffffff",
        strokeColor: "#000000",
        barHeight: 56,
        fontSize: 24,
        paddingX: 36
    }
};

// 单张剧照体积上限：解码后整张位图常驻内存，手机相册的原始照片通常在 3–10MB，
// 30MB 足够覆盖正常素材，同时挡掉会把标签页撑爆的异常大文件。
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// 导出前等待字幕字体切片的上限；低于 canvasToBlob 的 4 秒兜底，避免弱网时导出无响应。
const FONT_WAIT_MS = 2000;

class CinemaStudio {
    constructor() {
        this.currentLang = 'zh';

        // 画布与核心 DOM
        this.canvas = document.getElementById('subtitle-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.dropZone = document.getElementById('drop-zone');
        this.canvasWrapper = document.getElementById('canvas-wrapper');
        this.canvasViewport = document.getElementById('canvas-viewport');
        this.workspace = document.querySelector('.studio-workspace');
        this.imageInput = document.getElementById('image-input');
        this.textInput = document.getElementById('subtitle-text');
        this.resetBtn = document.getElementById('reset-btn');
        this.downloadBtn = document.getElementById('download-btn');
        this.toastContainer = document.getElementById('toast-container');
        this.stageStatus = document.getElementById('stage-status-text');

        // 移动端保存浮层（系统分享不可用时的长按保存路径）
        this.saveOverlay = document.getElementById('save-overlay');
        this.savePreview = document.getElementById('save-preview');
        this.saveDownload = document.getElementById('save-download');
        this.saveCloseBtn = document.getElementById('save-close');

        // 视口缩放控制
        this.viewFitBtn = document.getElementById('view-fit-btn');
        this.viewActualBtn = document.getElementById('view-actual-btn');
        this.userModifiedStyle = false;

        // 导航与语言
        this.langSelect = document.getElementById('lang-select');

        // 选项卡
        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.tabPanes = document.querySelectorAll('.tab-pane');

        // 字幕控制项
        this.controls = {
            fontFamily: document.getElementById('font-family'),
            fontSize: document.getElementById('font-size'),
            fontColor: document.getElementById('font-color'),
            strokeColor: document.getElementById('stroke-color'),
            barHeight: document.getElementById('bar-height'),
            paddingX: document.getElementById('padding-x')
        };

        // 水印控制项
        this.wmEnable = document.getElementById('wm-enable');
        this.wmControlsPanel = document.getElementById('wm-controls');
        this.wmControls = {
            text: document.getElementById('wm-text'),
            pos: document.getElementById('wm-pos'),
            opacity: document.getElementById('wm-opacity'),
            size: document.getElementById('wm-size'),
            color: document.getElementById('wm-color')
        };

        // 数值显示
        this.values = {
            fontSize: document.getElementById('font-size-val'),
            barHeight: document.getElementById('bar-height-val'),
            paddingX: document.getElementById('padding-x-val'),
            wmOpacity: document.getElementById('wm-opacity-val'),
            wmSize: document.getElementById('wm-size-val')
        };

        this.originalImage = null;
        this.init();
    }

    init() {
        // 1. 初始化语言
        this.currentLang = localeFromPath(location.pathname);
        this.applyLanguage(this.currentLang);

        // 2. 默认台词与水印
        this.textInput.value = this.t('default_text');
        if (this.wmControls.text) {
            this.wmControls.text.value = this.t('default_wm');
        }

        // 3. 初始视口状态：展示独立取景框，隐藏未载入的 canvas
        if (this.canvasWrapper) {
            this.canvasWrapper.classList.add('hidden');
        }
        if (this.dropZone) {
            this.dropZone.classList.remove('hidden');
        }

        // 4. 剧照上传与拖拽监听
        this.imageInput.addEventListener('change', (e) => this.handleFile(e.target.files[0]));
        this.dropZone.addEventListener('click', () => this.imageInput.click());

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        this.dropZone.addEventListener('dragover', () => this.dropZone.classList.add('drag-over'));
        this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drag-over'));
        this.dropZone.addEventListener('drop', (e) => {
            this.dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            this.handleFile(file);
        });

        // 5. 操作按钮
        this.resetBtn.addEventListener('click', () => this.resetImage());
        this.downloadBtn.addEventListener('click', () => {
            // download() 内部已覆盖各失败分支并给出提示，这里只兜住意外 reject
            this.download().catch(() => {});
        });

        if (this.saveCloseBtn) {
            this.saveCloseBtn.addEventListener('click', () => this.closeSaveOverlay());
        }
        if (this.saveOverlay) {
            // 点击遮罩空白处关闭
            this.saveOverlay.addEventListener('click', (event) => {
                if (event.target === this.saveOverlay) this.closeSaveOverlay();
            });
        }

        // 视口缩放模式切换 (适应窗口 vs 1:1 原画)
        if (this.viewFitBtn && this.viewActualBtn && this.canvasViewport) {
            this.viewFitBtn.addEventListener('click', () => {
                this.canvasViewport.classList.remove('mode-actual');
                this.viewFitBtn.classList.add('active');
                this.viewActualBtn.classList.remove('active');
            });
            this.viewActualBtn.addEventListener('click', () => {
                this.canvasViewport.classList.add('mode-actual');
                this.viewActualBtn.classList.add('active');
                this.viewFitBtn.classList.remove('active');
            });
        }

        // 6. 选项卡切换
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.getAttribute('data-tab');
                this.switchTab(targetTab);
            });
        });

        // 7. 经典台词快捷填充
        document.querySelectorAll('.quote-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const quoteKey = chip.getAttribute('data-quote');
                if (QUOTES[quoteKey]) {
                    this.textInput.value = QUOTES[quoteKey][this.currentLang] || QUOTES[quoteKey].en;
                    this.render();
                    this.showToast(this.t('toast_quote_applied'));
                }
            });
        });

        // 8. 胶片调色预设
        document.querySelectorAll('.preset-card').forEach(card => {
            card.addEventListener('click', () => {
                const presetKey = card.getAttribute('data-preset');
                this.userModifiedStyle = true;
                this.applyPreset(presetKey);
            });
        });

        // 9. 语言选择切换
        this.langSelect.addEventListener('change', () => {
            this.changeLanguage(this.langSelect.value);
        });
        // Keep real URLs for crawlers/no-JS; intercept only ordinary same-tab clicks.
        document.getElementById('product-guide').addEventListener('click', (event) => {
            const link = event.target.closest('.locale-links a');
            if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
            event.preventDefault();
            this.changeLanguage(link.dataset.locale);
        });
        window.addEventListener('popstate', () => {
            this.currentLang = localeFromPath(location.pathname);
            this.applyLanguage(this.currentLang);
            this.render();
        });

        // 10. 实时交互事件绑定
        const refreshEvents = ['input', 'change'];
        Object.values(this.controls).forEach(control => {
            if (!control) return;
            refreshEvents.forEach(evt => {
                control.addEventListener(evt, () => {
                    this.userModifiedStyle = true;
                    this.updateValueDisplays();
                    this.render();
                });
            });
        });

        this.textInput.addEventListener('input', () => this.render());

        if (this.wmEnable) {
            this.wmEnable.addEventListener('change', () => {
                this.wmControlsPanel.classList.toggle('disabled-group', !this.wmEnable.checked);
                this.render();
            });
        }

        Object.values(this.wmControls).forEach(control => {
            if (!control) return;
            refreshEvents.forEach(evt => {
                control.addEventListener(evt, () => {
                    this.updateValueDisplays();
                    this.render();
                });
            });
        });

        this.updateValueDisplays();

        // 11. 字体异步加载完成后自动补刷一次（不阻塞初始渲染）
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                if (this.originalImage) {
                    this.render();
                }
            }).catch(() => {});
        }

        // 12. 移动端：编辑台词时收起顶部吸附的预览舞台，
        // 避免软键盘弹出后画布仍在顶部挤占本就有限的编辑高度
        const narrowScreen = window.matchMedia('(max-width: 960px)');
        const syncEditingState = () => {
            if (!this.workspace) return;
            this.workspace.classList.toggle(
                'is-editing',
                narrowScreen.matches && document.activeElement === this.textInput
            );
        };
        this.textInput.addEventListener('focus', syncEditingState);
        this.textInput.addEventListener('blur', syncEditingState);
        // 横竖屏切换等视口变化后重新判定，防止编辑态被残留
        if (typeof narrowScreen.addEventListener === 'function') {
            narrowScreen.addEventListener('change', syncEditingState);
        }
    }

    switchTab(tabId) {
        this.tabBtns.forEach(btn => {
            const isTarget = btn.getAttribute('data-tab') === tabId;
            btn.classList.toggle('active', isTarget);
            btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
        });

        this.tabPanes.forEach(pane => {
            pane.classList.toggle('active', pane.id === `pane-${tabId}`);
        });
    }

    applyPreset(presetKey) {
        const preset = STYLE_PRESETS[presetKey];
        if (!preset) return;

        document.querySelectorAll('.preset-card').forEach(card => {
            card.classList.toggle('active', card.getAttribute('data-preset') === presetKey);
        });

        this.controls.fontColor.value = preset.fontColor;
        this.controls.strokeColor.value = preset.strokeColor;
        this.controls.barHeight.value = preset.barHeight;
        this.controls.fontSize.value = preset.fontSize;
        this.controls.paddingX.value = preset.paddingX;

        this.updateValueDisplays();
        this.render();
    }

    t(key) {
        return TRANS[this.currentLang][key] || key;
    }

    applyLanguage(lang) {
        // 约定：带图标的控件（导出/清空/视图切换等）必须把 data-i18n 挂在内部文本 <span> 上。
        // innerText 赋值会清空子节点，挂在按钮上会把同级的 SVG 图标一并抹掉。
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (TRANS[lang] && TRANS[lang][key]) {
                if (key === 'header_title') {
                    el.innerHTML = TRANS[lang][key];
                } else {
                    el.innerText = TRANS[lang][key];
                }
            }
        });

        // 悬停提示与无障碍标签：同样走词条，避免英文界面里残留中文
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (TRANS[lang] && TRANS[lang][key]) {
                el.title = TRANS[lang][key];
            }
        });

        document.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            if (TRANS[lang] && TRANS[lang][key]) {
                el.setAttribute('aria-label', TRANS[lang][key]);
            }
        });

        document.querySelectorAll('[data-i18n-alt]').forEach(el => {
            const key = el.getAttribute('data-i18n-alt');
            if (TRANS[lang] && TRANS[lang][key]) {
                el.setAttribute('alt', TRANS[lang][key]);
            }
        });

        this.textInput.placeholder = this.t('placeholder_text');
        this.langSelect.value = lang;
        document.documentElement.lang = SEO[lang].lang;
        document.documentElement.dir = SEO[lang].dir;
        applyLocaleSeo(lang);

        // 更新状态指示文案
        if (!this.originalImage && this.stageStatus) {
            this.stageStatus.innerText = this.t('stage_ready');
        } else if (this.originalImage && this.stageStatus) {
            this.stageStatus.innerText = `${this.t('stage_loaded')} · ${this.originalImage.width} × ${this.originalImage.height}`;
        }
    }

    changeLanguage(lang) {
        if (!SEO[lang]) return;
        this.currentLang = lang;
        if (location.pathname !== SEO[lang].path) {
            // 切换到 `/` 时带上 history.state 标记，刷新后仍停在 `/`（见 locale-redirect.js）；这是历史记录状态，不是存储。
            const state = SEO[lang].path === '/' ? { shadowLocaleChosen: true } : null;
            history.pushState(state, '', SEO[lang].path + location.search + location.hash);
        }
        this.applyLanguage(lang);
        this.render();
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    updateValueDisplays() {
        if (this.values.fontSize) this.values.fontSize.textContent = this.controls.fontSize.value;
        if (this.values.barHeight) this.values.barHeight.textContent = this.controls.barHeight.value;
        if (this.values.paddingX) this.values.paddingX.textContent = this.controls.paddingX.value;
        if (this.values.wmOpacity) this.values.wmOpacity.textContent = this.wmControls.opacity.value;
        if (this.values.wmSize) this.values.wmSize.textContent = this.wmControls.size.value;
    }

    handleFile(file) {
        if (!file || !file.type.startsWith('image/')) {
            this.showToast(this.t('toast_invalid_file'));
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            this.showToast(
                this.t('toast_file_too_large').replace('{limit}', `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`)
            );
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.originalImage = img;
                this.scaleNoticeShown = false;
                if (this.dropZone) {
                    this.dropZone.classList.add('hidden');
                }
                if (this.canvasWrapper) {
                    this.canvasWrapper.classList.remove('hidden');
                }
                // 每次载入新剧照时自动恢复为【适应窗口】模式，保证画面与台词一眼看全
                if (this.canvasViewport && this.viewFitBtn && this.viewActualBtn) {
                    this.canvasViewport.classList.remove('mode-actual');
                    this.viewFitBtn.classList.add('active');
                    this.viewActualBtn.classList.remove('active');
                }
                // 若用户尚未手动调节过样式，根据剧照分辨率自适应建议字号与切片高度
                if (!this.userModifiedStyle && img.width > 900) {
                    const scale = img.width / 1000;
                    const autoFontSize = Math.min(80, Math.max(22, Math.round(22 * scale)));
                    const autoBarHeight = Math.min(160, Math.max(48, Math.round(autoFontSize * 2)));
                    this.controls.fontSize.value = autoFontSize;
                    this.controls.barHeight.value = autoBarHeight;
                    this.updateValueDisplays();
                }
                if (this.stageStatus) {
                    this.stageStatus.innerText = `${this.t('stage_loaded')} · ${img.width} × ${img.height}`;
                }
                this.render();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    resetImage() {
        this.originalImage = null;
        this.scaleNoticeShown = false;
        this.imageInput.value = "";
        if (this.dropZone) {
            this.dropZone.classList.remove('hidden');
        }
        if (this.canvasWrapper) {
            this.canvasWrapper.classList.add('hidden');
        }
        if (this.canvasViewport && this.viewFitBtn && this.viewActualBtn) {
            this.canvasViewport.classList.remove('mode-actual');
            this.viewFitBtn.classList.add('active');
            this.viewActualBtn.classList.remove('active');
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.width = 0;
        this.canvas.height = 0;
        if (this.stageStatus) {
            this.stageStatus.innerText = this.t('stage_ready');
        }
    }

    // 浏览器画布面积上限：iOS Safari 约 1670 万像素，超出后 drawImage 会静默失败、
    // 得到空白画面；桌面端上限宽松得多。触屏设备留出约 28% 余量（12M 像素），
    // 因为贴着平台上限时编码与导出更容易失败。
    maxCanvasArea() {
        const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
        const touchDevice = coarsePointer || (navigator.maxTouchPoints || 0) > 0;
        return touchDevice ? 12 * 1024 * 1024 : 64 * 1024 * 1024;
    }

    notifyCanvasScaling(scale) {
        if (scale >= 1 || this.scaleNoticeShown) return;
        this.scaleNoticeShown = true;
        this.showToast(
            this.t('toast_canvas_scaled').replace('{size}', `${this.canvas.width} × ${this.canvas.height}`)
        );
    }

    render() {
        if (!this.originalImage) return;

        const lines = this.textInput.value.split('\n').filter(line => line.trim() !== '');
        const barHeight = parseInt(this.controls.barHeight.value);
        const fontSize = parseInt(this.controls.fontSize.value);
        const paddingX = parseInt(this.controls.paddingX.value);
        const fontFamily = this.controls.fontFamily.value;
        const fontColor = this.controls.fontColor.value;
        const strokeColor = this.controls.strokeColor.value;

        const imgW = this.originalImage.width;
        const imgH = this.originalImage.height;
        const totalHeight = imgH + (lines.length > 0 ? (lines.length - 1) * barHeight : 0);

        // 超出平台画布面积上限时整体等比缩小：绘制仍全部走原始图片坐标系，
        // 由变换矩阵完成缩放，后续所有排版数值（字号、切片高度、边距）无需换算。
        const scale = Math.min(1, Math.sqrt(this.maxCanvasArea() / (imgW * totalHeight)));
        this.logicalWidth = imgW;
        this.logicalHeight = totalHeight;
        this.canvas.width = Math.max(1, Math.floor(imgW * scale));
        this.canvas.height = Math.max(1, Math.floor(totalHeight * scale));
        this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
        this.notifyCanvasScaling(scale);

        // 1. 绘制背景切片序列（带安全高度裁剪，防止小图/异常尺寸负坐标）
        this.ctx.drawImage(this.originalImage, 0, 0);
        if (lines.length > 1) {
            const sliceH = Math.min(barHeight, imgH);
            const sourceY = Math.max(0, imgH - sliceH);
            for (let i = 1; i < lines.length; i++) {
                const destY = imgH + (i - 1) * barHeight;
                this.ctx.drawImage(this.originalImage, 0, sourceY, imgW, sliceH, 0, destY, imgW, barHeight);
            }
        }

        // 2. 绘制电影字幕
        // 描边改用环绕偏移填充实现：strokeText 会在中文字形尖锐收笔处甩出细刺伪影，
        // lineJoin/miterLimit 无法消除，且描边越粗越明显。
        const outlineWidth = Math.max(2, Math.round(fontSize / 9));
        const outlineDistance = outlineWidth / 2 + 0.5;
        const outlineOffsets = Array.from({ length: 16 }, (_, step) => {
            const angle = (step / 16) * Math.PI * 2;
            return [Math.cos(angle) * outlineDistance, Math.sin(angle) * outlineDistance];
        });

        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.font = `${fontSize}px ${fontFamily}`;

        lines.forEach((line, index) => {
            const textY = index === 0 ? imgH - (barHeight / 2) : imgH + (index - 1) * barHeight + (barHeight / 2);
            const maxTextWidth = imgW - paddingX * 2;

            this.ctx.fillStyle = strokeColor;
            for (const [offsetX, offsetY] of outlineOffsets) {
                this.ctx.fillText(line, imgW / 2 + offsetX, textY + offsetY, maxTextWidth);
            }
            this.ctx.fillStyle = fontColor;
            this.ctx.fillText(line, imgW / 2, textY, maxTextWidth);
        });

        // 3. 绘制水印
        this.drawWatermark();

        // 4. 字幕字体按 unicode-range 切片按需加载，画布不会在字体到达后自动重绘：
        //    所需切片未就绪时加载，只为最近一次的字体与文字重绘一次（加载失败不重试，避免循环；
        //    连续输入时早先的加载完成后不再各自重绘）。
        const text = lines.join('');
        const font = this.ctx.font;
        if (text && document.fonts && document.fonts.check && document.fonts.load && !document.fonts.check(font, text)) {
            const key = `${font}\n${text}`;
            this.pendingFontKey = key;
            document.fonts.load(font, text).then(() => {
                if (this.pendingFontKey !== key) return;
                this.pendingFontKey = null;
                if (document.fonts.check(font, text)) this.render();
            }).catch(() => {});
        }
    }

    // 导出前等待字幕字体的所需切片，最多等 FONT_WAIT_MS，弱网时不让导出停在“导出中”，也尽量不耗尽
    // 移动端分享所需的用户手势时效；超时或加载失败时按当前画布导出（可能是回退字体）。
    async ensureSubtitleFont() {
        if (!document.fonts || !document.fonts.load || !document.fonts.check) return;
        const text = this.textInput.value.split('\n').filter(line => line.trim() !== '').join('');
        const font = `${parseInt(this.controls.fontSize.value)}px ${this.controls.fontFamily.value}`;
        if (!text || document.fonts.check(font, text)) return;
        let timer;
        const loaded = await Promise.race([
            document.fonts.load(font, text).then(() => true, () => false),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), FONT_WAIT_MS); }),
        ]);
        clearTimeout(timer);
        if (loaded && document.fonts.check(font, text)) this.render();
    }

    drawWatermark() {
        if (!this.wmEnable || !this.wmEnable.checked) return;
        this.ctx.save();
        this.ctx.globalAlpha = parseFloat(this.wmControls.opacity.value);
        this.ctx.font = `${parseInt(this.wmControls.size.value)}px sans-serif`;
        this.ctx.fillStyle = this.wmControls.color.value;

        const margin = 24;
        const sideMargin = 20;
        // 定位必须用原始坐标系尺寸：canvas.width/height 是缩放后的物理像素，
        // 在缩放变换下直接使用会让水印跑到画面外
        const width = this.logicalWidth || this.canvas.width;
        const height = this.logicalHeight || this.canvas.height;

        let x, y;
        this.ctx.textBaseline = 'middle';

        switch (this.wmControls.pos.value) {
            case 'top-left':
                x = sideMargin; y = margin; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top'; break;
            case 'top-right':
                x = width - sideMargin; y = margin; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'top'; break;
            case 'bottom-left':
                x = sideMargin; y = height - margin; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'bottom'; break;
            case 'bottom-right':
                x = width - sideMargin; y = height - margin; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'bottom'; break;
            case 'center':
                x = width / 2; y = height / 2; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; break;
        }

        this.ctx.fillText(this.wmControls.text.value, x, y);
        this.ctx.restore();
    }

    // 导出长图。移动端优先走系统分享面板：iOS/Android 浏览器对 <a download> 的
    // data: 链接普遍拦截（iOS Safari 历史上直接忽略 download 属性），而分享面板里的
    // 「存储图像 / 保存到相册」是手机上唯一稳定可靠的落盘路径；其余情况回退到 Blob
    // 对象 URL 下载。全程不使用 canvas.toDataURL：大图会生成几十 MB 的 base64 字符串，
    // iOS Safari 在接近画布上限时会静默返回 "data:,"，点击后毫无反应。
    async download() {
        if (!this.originalImage) {
            this.showToast(this.t('toast_save_fail'));
            return;
        }

        this.showToast(this.t('toast_exporting'));

        await this.ensureSubtitleFont();
        const blob = await this.canvasToBlob();
        if (!blob) {
            this.showToast(this.t('toast_save_encode_fail'));
            return;
        }

        const fileName = `shadow_snap_cinema_${Date.now()}.png`;
        const touchDevice = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0;

        if (touchDevice && this.hasReliableFileShare() && typeof File === 'function' && typeof navigator.canShare === 'function') {
            const file = new File([blob], fileName, { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file] });
                    this.showToast(this.t('toast_share_success'));
                    return;
                } catch (error) {
                    // 用户主动取消分享：静默返回，既不误报失败也不改走其他路径
                    if (error && error.name === 'AbortError') return;
                    // 其余失败（含手势失效、内核不支持）落到下面的浮层分支
                }
            }
        }

        if (touchDevice) {
            // 触屏但拿不到系统分享（夸克、微信、UC 等内核对 navigator.share 支持不一）：
            // 改为展示浮层，提供「长按图片保存」与可点击下载两条路径——长按另存是移动端
            // 最通用的落盘方式，不依赖任何浏览器 API 的实现细节。
            await this.openSaveOverlay(blob);
            return;
        }

        this.triggerBlobDownload(blob, fileName);
        this.showToast(this.t('toast_save_success'));
    }

    // 微信内置浏览器不认 blob: 图片（长按保存会提示「保存图片到手机失败」），
    // 程序化下载也会被拦下并提示"在浏览器打开"，这两处需要单独处理。
    isWeChatBrowser() {
        return /MicroMessenger/i.test(navigator.userAgent || '');
    }

    // 夸克、UC 的 canShare({ files }) 返回 true，但 share() 既不弹面板也不结束，
    // 导出会一直挂起、走不到下面的保存浮层，因此这两类内核直接跳过系统分享。
    hasReliableFileShare() {
        return !/Quark|UCBrowser|UCWEB/i.test(navigator.userAgent || '');
    }

    readAsDataUrl(blob) {
        return new Promise((resolve) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            } catch {
                resolve(null);
            }
        });
    }

    async openSaveOverlay(blob) {
        const inWeChat = this.isWeChatBrowser();
        this.saveOverlay.classList.toggle('is-wechat', inWeChat);

        let objectUrl = URL.createObjectURL(blob);
        let src = objectUrl;
        // 微信、夸克、UC 长按保存会按图片地址重新下载，取不到 blob: 地址，预览改用内联 data URL；
        // 下载按钮仍用 blob（夸克、UC 的程序化下载可用）。
        if (inWeChat || !this.hasReliableFileShare()) {
            const dataUrl = await this.readAsDataUrl(blob);
            if (dataUrl) {
                // 内联图片不必让内核再取一次资源，长按保存才有机会成功
                src = dataUrl;
                if (inWeChat) {
                    URL.revokeObjectURL(objectUrl);
                    objectUrl = '';
                }
            }
        }

        this.savePreview.src = src;
        this.saveDownload.href = objectUrl || src;
        this.saveDownload.download = `shadow_snap_cinema_${Date.now()}.png`;
        this.saveOverlay.classList.remove('hidden');
    }

    closeSaveOverlay() {
        if (this.saveOverlay.classList.contains('hidden')) return;
        this.saveOverlay.classList.add('hidden');
        // 夸克、UC 的预览是 data URL，blob 只挂在下载按钮上，因此按下载链接回收
        const src = this.saveDownload.getAttribute('href') || '';
        this.savePreview.removeAttribute('src');
        this.saveDownload.removeAttribute('href');
        if (src.startsWith('blob:')) {
            // 延迟回收：避免打断刚触发的下载
            setTimeout(() => URL.revokeObjectURL(src), 2000);
        }
    }

    // 优先 toBlob（内存占用远低于 base64），失败、返回空或迟迟不回调时回退 toDataURL。
    // 部分国产内核的 toBlob 实现不可靠（既不回调也不报错），故加超时兜底，避免导出静默卡死。
    canvasToBlob() {
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                resolve(value);
            };
            const fromDataUrl = () => {
                try {
                    const dataUrl = this.canvas.toDataURL('image/png');
                    if (!dataUrl || dataUrl === 'data:,' || !dataUrl.startsWith('data:image/png')) {
                        finish(null);
                        return;
                    }
                    const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    finish(new Blob([bytes], { type: 'image/png' }));
                } catch {
                    finish(null);
                }
            };
            timer = setTimeout(fromDataUrl, 4000);
            try {
                this.canvas.toBlob((blob) => (blob ? finish(blob) : fromDataUrl()), 'image/png');
            } catch {
                fromDataUrl();
            }
        });
    }

    triggerBlobDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            link.remove();
        }, 1000);
    }
}

window.onload = () => { new CinemaStudio(); };
