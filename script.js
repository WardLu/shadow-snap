/**
 * 影瞬 Shadow Snap - 核心逻辑 V5.0
 * 优化：i18n国际化支持，打赏功能，界面细节优化
 */

const TRANS = {
    zh: {
        page_title: "影瞬 Shadow Snap | 电影感字幕长图生成器",
        header_title: "<img src='public/brand_assets/shadow_snap.svg' alt='Logo' class='header-logo'> 影瞬 Shadow Snap",
        header_desc: "快速制作具有'切割感'背景的电影对话长图",
        drop_zone_text: "拖拽图片至此 或 点击此处上传",
        group_basic: "📁 基础设置",
        btn_select_img: "选择图片",
        btn_delete_img: "🗑️ 删除图片",
        btn_save_img: "💾 保存图片",
        group_subtitle: "💬 字幕设置",
        hint_enter: "按回车键(Enter)换行",
        placeholder_text: "在这里输入你的台词...",
        label_font: "选择字体",
        label_font_size: "字号",
        label_font_color: "字体颜色 / 描边颜色",
        label_bar_height: "字幕高度",
        label_padding_x: "安全边距",
        group_watermark: "📑 水印设置",
        label_wm_enable: "启用水印",
        label_wm_content: "水印内容",
        label_wm_pos: "水印位置",
        label_wm_opacity: "不透明度",
        label_wm_size: "水印大小",
        label_wm_color: "文字颜色",
        pos_bottom_right: "右下角",
        pos_bottom_left: "左下角",
        pos_top_right: "右上角",
        pos_top_left: "左上角",
        pos_center: "居中",
        footer_feedback: "反馈建议",
        footer_donate: "打赏支持",
        footer_wechat: "影子AI之旅",
        modal_donate_title: "☕ 感谢支持开发者",
        modal_donate_desc: "如果这个工具对你有帮助，欢迎打赏一杯咖啡",
        donate_wechat: "微信支付",
        donate_alipay: "支付宝",
        toast_save_success: "图片保存成功！",
        toast_save_fail: "保存失败，请先选择图片",
        toast_invalid_file: "请上传有效的图片文件",
        default_text: "欢迎关注微信公众号：影子AI之旅\nX：@Gollumgulu\nB端产品经理，洞察AI趋势，输出产品思考，带你一起玩转AI应用。",
        default_wm: "公众号：影子AI之旅"
    },
    en: {
        page_title: "Shadow Snap | Cinematic Subtitle Image Maker",
        header_title: "<img src='public/brand_assets/shadow_snap.svg' alt='Logo' class='header-logo'> Shadow Snap",
        header_desc: "Create cinematic long images with 'cut-out' backgrounds",
        drop_zone_text: "Drag & Drop Image Here or Click to Upload",
        group_basic: "📁 Basic Settings",
        btn_select_img: "Select Image",
        btn_delete_img: "🗑️ Delete Image",
        btn_save_img: "💾 Save Image",
        group_subtitle: "💬 Subtitle Settings",
        hint_enter: "Press Enter for new line",
        placeholder_text: "Enter your subtitles here...",
        label_font: "Font Family",
        label_font_size: "Font Size",
        label_font_color: "Font Color / Stroke",
        label_bar_height: "Bar Height",
        label_padding_x: "Safe Margin",
        group_watermark: "📑 Watermark",
        label_wm_enable: "Enable Watermark",
        label_wm_content: "Content",
        label_wm_pos: "Position",
        label_wm_opacity: "Opacity",
        label_wm_size: "Size",
        label_wm_color: "Color",
        pos_bottom_right: "Bottom Right",
        pos_bottom_left: "Bottom Left",
        pos_top_right: "Top Right",
        pos_top_left: "Top Left",
        pos_center: "Center",
        footer_feedback: "Feedback",
        footer_donate: "Donate",
        footer_wechat: "影子AI之旅",
        modal_donate_title: "☕ Support Developer",
        modal_donate_desc: "If this tool helps you, consider buying me a coffee.",
        donate_wechat: "WeChat Pay",
        donate_alipay: "Alipay",
        toast_save_success: "Image saved successfully!",
        toast_save_fail: "Failed to save. Please select an image first.",
        toast_invalid_file: "Please upload a valid image file.",
        default_text: "Welcome to Shadow Snap\nCreate movie-like subtitles easily.\nJust upload and type!",
        default_wm: "Created by SubtitleGen"
    }
};

class SubtitleGenerator {
    constructor() {
        this.currentLang = 'zh'; // 默认中文

        // Canvas & Core
        this.canvas = document.getElementById('subtitle-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.dropZone = document.getElementById('drop-zone');
        this.imageInput = document.getElementById('image-input');
        this.textInput = document.getElementById('subtitle-text');
        this.resetBtn = document.getElementById('reset-btn');
        this.downloadBtn = document.getElementById('download-btn');
        this.toastContainer = document.getElementById('toast-container');

        // UI Extras
        this.langSelect = document.getElementById('lang-select');
        this.donateTrigger = document.getElementById('donate-trigger');
        this.donateModal = document.getElementById('donate-modal');
        this.modalClose = document.getElementById('modal-close');

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
        // 0. 初始化语言 (检测浏览器语言)
        const browserLang = navigator.language || navigator.userLanguage;
        if (!browserLang.startsWith('zh')) {
            this.currentLang = 'en';
        }
        this.applyLanguage(this.currentLang);

        // 1. 设置默认内容
        // 注意：applyLanguage 中会设置 placeholder，这里设置默认 value
        this.textInput.value = this.t('default_text');
        this.wmControls.text.value = this.t('default_wm');

        // 2. 图片上传管理
        this.imageInput.addEventListener('change', (e) => this.handleFile(e.target.files[0]));
        this.dropZone.addEventListener('click', () => this.imageInput.click());

        // 拖拽上传
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

        // 3. 基础功能按钮
        this.resetBtn.addEventListener('click', () => this.resetImage());
        this.downloadBtn.addEventListener('click', () => this.download());

        // 语言切换
        this.langSelect.addEventListener('change', () => {
            this.currentLang = this.langSelect.value;
            this.applyLanguage(this.currentLang);
            this.render(); // 重新渲染以更新可能画在 Canvas 上的文字(如下载时的水印)
        });

        // 打赏弹窗
        this.donateTrigger.addEventListener('click', () => {
            this.donateModal.classList.add('active');
        });
        this.modalClose.addEventListener('click', () => {
            this.donateModal.classList.remove('active');
        });
        this.donateModal.addEventListener('click', (e) => {
            if (e.target === this.donateModal) {
                this.donateModal.classList.remove('active');
            }
        });

        // 4. 实时渲染绑定
        const refreshEvents = ['input', 'change'];

        // 字幕控制项
        Object.values(this.controls).forEach(control => {
            refreshEvents.forEach(evt => {
                control.addEventListener(evt, () => {
                    this.updateValueDisplays();
                    this.render();
                });
            });
        });

        // 文本域改变
        this.textInput.addEventListener('input', () => this.render());

        // 水印开关
        this.wmEnable.addEventListener('change', () => {
            this.wmControlsPanel.classList.toggle('active', this.wmEnable.checked);
            this.render();
        });

        // 水印控制项
        Object.values(this.wmControls).forEach(control => {
            refreshEvents.forEach(evt => {
                control.addEventListener(evt, () => {
                    this.updateValueDisplays();
                    this.render();
                });
            });
        });

        this.updateValueDisplays();
    }

    // --- i18n Helpers ---
    t(key) {
        return TRANS[this.currentLang][key] || key;
    }

    applyLanguage(lang) {
        // 更新普通 DOM 文本
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (TRANS[lang][key]) {
                // 如果是 header_title，使用 innerHTML 渲染 HTML
                if (key === 'header_title') {
                    el.innerHTML = TRANS[lang][key];
                } else {
                    el.innerText = TRANS[lang][key];
                }
            }
        });

        // 更新 Placeholder
        this.textInput.placeholder = this.t('placeholder_text');

        // 更新下拉选择器的值
        this.langSelect.value = lang;

        // 更新 <HTML> 标签
        document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    }
    // --------------------

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
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.originalImage = img;
                this.dropZone.classList.add('hidden');
                this.render();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    resetImage() {
        this.originalImage = null;
        this.imageInput.value = "";
        this.dropZone.classList.remove('hidden');
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.width = 0;
        this.canvas.height = 0;
    }

    async render() {
        if (!this.originalImage) return;
        await document.fonts.ready;

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

        this.canvas.width = imgW;
        this.canvas.height = totalHeight;

        // 1. 绘制背景
        this.ctx.drawImage(this.originalImage, 0, 0);
        if (lines.length > 1) {
            for (let i = 1; i < lines.length; i++) {
                const destY = imgH + (i - 1) * barHeight;
                this.ctx.drawImage(this.originalImage, 0, imgH - barHeight, imgW, barHeight, 0, destY, imgW, barHeight);
            }
        }

        // 2. 绘制字幕
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.font = `${fontSize}px ${fontFamily}`;
        this.ctx.fillStyle = fontColor;
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = fontSize / 10;

        lines.forEach((line, index) => {
            let textY = index === 0 ? imgH - (barHeight / 2) : imgH + (index - 1) * barHeight + (barHeight / 2);
            this.ctx.strokeText(line, imgW / 2, textY, imgW - paddingX * 2);
            this.ctx.fillText(line, imgW / 2, textY, imgW - paddingX * 2);
        });

        // 3. 绘制水印
        this.drawWatermark();
    }

    drawWatermark() {
        if (!this.wmEnable.checked) return;
        this.ctx.save();
        this.ctx.globalAlpha = parseFloat(this.wmControls.opacity.value);
        this.ctx.font = `${parseInt(this.wmControls.size.value)}px sans-serif`;
        this.ctx.fillStyle = this.wmControls.color.value;

        const margin = 24;
        const sideMargin = 20;

        let x, y;
        this.ctx.textBaseline = 'middle';

        switch (this.wmControls.pos.value) {
            case 'top-left':
                x = sideMargin; y = margin; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top'; break;
            case 'top-right':
                x = this.canvas.width - sideMargin; y = margin; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'top'; break;
            case 'bottom-left':
                x = sideMargin; y = this.canvas.height - margin; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'bottom'; break;
            case 'bottom-right':
                x = this.canvas.width - sideMargin; y = this.canvas.height - margin; this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'bottom'; break;
            case 'center':
                x = this.canvas.width / 2; y = this.canvas.height / 2; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; break;
        }

        this.ctx.fillText(this.wmControls.text.value, x, y);
        this.ctx.restore();
    }

    download() {
        if (!this.originalImage) {
            this.showToast(this.t('toast_save_fail'));
            return;
        }

        // 使用 Data URL 方式下载
        const dataUrl = this.canvas.toDataURL('image/png');

        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = dataUrl;
        link.download = `cinema_style_${Date.now()}.png`;

        document.body.appendChild(link);
        link.click();
        this.showToast(this.t('toast_save_success'));

        // 清理
        setTimeout(() => {
            document.body.removeChild(link);
        }, 100);
    }
}

window.onload = () => { new SubtitleGenerator(); };
