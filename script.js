/**
 * 图片字幕生成器 - 核心逻辑 V4.0
 * 优化：50/50分屏布局，Toast提示，水印居中，拖拽增强
 */

class SubtitleGenerator {
    constructor() {
        this.canvas = document.getElementById('subtitle-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.dropZone = document.getElementById('drop-zone');
        this.imageInput = document.getElementById('image-input');
        this.textInput = document.getElementById('subtitle-text');
        this.resetBtn = document.getElementById('reset-btn');
        this.downloadBtn = document.getElementById('download-btn');
        this.toastContainer = document.getElementById('toast-container');

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
        // 1. 设置默认内容
        this.textInput.value = "欢迎关注微信公众号：影子AI之旅\nX：@Gollumgulu\nB端产品经理，洞察AI趋势，输出产品思考，带你一起玩转AI应用。";
        this.wmControls.text.value = "公众号：影子AI之旅";

        // 2. 图片上传管理
        this.imageInput.addEventListener('change', (e) => this.handleFile(e.target.files[0]));

        // 区域点击上传
        this.dropZone.addEventListener('click', () => this.imageInput.click());

        // 拖拽上传 (完善实现)
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
            this.showToast('请上传有效的图片文件');
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
            this.showToast('保存失败，请先选择图片');
            return;
        }

        // 使用 Data URL 方式下载
        // 原因：Chrome 在 file:// 协议下会忽略 Blob URL 的 download 属性
        // Data URL 则不受此限制，可确保所有浏览器正确保存为 .png 格式
        const dataUrl = this.canvas.toDataURL('image/png');

        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = dataUrl;
        link.download = `cinema_style_${Date.now()}.png`;

        document.body.appendChild(link);
        link.click();

        // 清理
        setTimeout(() => {
            document.body.removeChild(link);
        }, 100);
    }

}

window.onload = () => { new SubtitleGenerator(); };
