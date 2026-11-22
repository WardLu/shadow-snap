import { QUOTES, TRANS } from './translations.mjs';

// Locale facts mirror shadow-portal i18n/locales.ts (its source of truth; snapshot 2026-11-01).
// Paths, canonical and hreflang tags, <html lang dir>, og:locale and language names derive from LOCALE_CONFIG;
// components must not branch on locale codes.
export const LOCALE_CONFIG = {
  zh: { nativeName: "简体中文", htmlLang: "zh-CN", hreflang: ["zh"], ogLocale: "zh_CN", dir: "ltr" },
  en: { nativeName: "English", htmlLang: "en", hreflang: ["en"], ogLocale: "en_US", dir: "ltr" },
  "zh-hant": { nativeName: "繁體中文", htmlLang: "zh-Hant", hreflang: ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"], ogLocale: "zh_TW", dir: "ltr" },
  ja: { nativeName: "日本語", htmlLang: "ja", hreflang: ["ja"], ogLocale: "ja_JP", dir: "ltr" },
  ko: { nativeName: "한국어", htmlLang: "ko", hreflang: ["ko"], ogLocale: "ko_KR", dir: "ltr" },
  es: { nativeName: "Español", htmlLang: "es", hreflang: ["es"], ogLocale: "es_ES", dir: "ltr" },
  pt: { nativeName: "Português", htmlLang: "pt-BR", hreflang: ["pt"], ogLocale: "pt_BR", dir: "ltr" },
  fr: { nativeName: "Français", htmlLang: "fr", hreflang: ["fr"], ogLocale: "fr_FR", dir: "ltr" },
  de: { nativeName: "Deutsch", htmlLang: "de", hreflang: ["de"], ogLocale: "de_DE", dir: "ltr" },
  ru: { nativeName: "Русский", htmlLang: "ru", hreflang: ["ru"], ogLocale: "ru_RU", dir: "ltr" },
  id: { nativeName: "Bahasa Indonesia", htmlLang: "id", hreflang: ["id"], ogLocale: "id_ID", dir: "ltr" },
  ar: { nativeName: "العربية", htmlLang: "ar", hreflang: ["ar"], ogLocale: "ar_AR", dir: "rtl" },
};
export const LOCALES = Object.keys(LOCALE_CONFIG);
// x-default and the static (no-JS) 404.html use English, as in shadow-portal. The 404's runtime language follows
// the path prefix instead; see notFoundLocaleFromPath.
export const DEFAULT_LOCALE = 'en';
const ORIGIN = 'https://snap.shadow.wang';
const CONTENT_KEYS = ["description","guideTitle","about","introduction","featuresTitle","features","stepsTitle","steps","faqTitle","supportTitle","support","faq"];

// Page copy per locale. zh and en keep the product wording; the other locales are translations (zh-hant derived from zh).
const CONTENT = {
  zh: {
    description: "影瞬 Shadow Snap 是免费的电影字幕长图与台词拼图工具。导入一张剧照，输入多行对白，调整字体、颜色、字幕条高度和水印，即可在浏览器中拼接并导出长图。图片处理在本地完成，不上传照片，无需登录或安装。",
    guideTitle: "产品指南与常见问题",
    about: "关于影瞬 Shadow Snap",
    introduction: "Shadow Snap 影瞬由 Ward Lu 与 Shadow Lab 创建，帮助电影爱好者和内容创作者把一张剧照与多行对白拼接成字幕长图。首张画面保留完整构图，后续对白使用底部字幕区域切片向下拼接。",
    featuresTitle: "核心功能",
    features: [
      "保留首张剧照，自动切片并拼接后续字幕条。",
      "在本地浏览器中使用 HTML5 Canvas 处理和导出图片，不上传照片。",
      "支持中、英、泰、越、阿等字体，以及字号、颜色、描边、安全边距和水印调整。",
      "无需登录或安装，免费使用；一次导入一张图片。",
    ],
    stepsTitle: "三步制作字幕长图",
    steps: [
      "导入一张电影剧照或视频截图（JPG、PNG 或 WebP）。",
      "输入对白，每行台词对应一条字幕切片。",
      "调整字体、字幕条高度和水印，然后点击“导出长图”。手机可使用分享面板或长按图片保存。",
    ],
    faqTitle: "常见问题",
    supportTitle: "创作者与支持",
    support: "由 Ward Lu 与 Shadow Lab 创建。反馈建议请发送至 support@shadow.wang，或联系 X 账号 @Gollumgulu。",
    faq: [
      ["什么是 Shadow Snap 影瞬？", "Shadow Snap 是免费的电影字幕长图工具，可将一张剧照与多行对白拼接成图片，无需登录或安装。"],
      ["如何拼接电影台词长图？", "导入一张图片，输入多行台词，然后调整字体与字幕条高度并导出。第一张画面完整保留，后续台词使用底部区域切片拼接。"],
      ["照片会上传到服务器吗？", "不会。图片处理和导出在本地浏览器内存中完成。网站会加载字体并使用网站访问统计，这不代表上传图片。"],
      ["手机如何保存长图？", "点击导出后，通过系统分享面板保存图片。不支持分享的浏览器会弹出保存浮层，点「下载原图」或长按图片保存；微信内保存失败时可在系统浏览器打开。"],
      ["支持哪些语言和字体？", "界面支持简体中文、繁体中文、英文、日文、韩文、西班牙文、葡萄牙文、法文、德文、俄文、印尼文和阿拉伯文，共 12 种语言。字体选项包含中文、拉丁文字、泰文、越南文和阿拉伯文。实际字体显示依赖浏览器及字体加载。"],
    ],
  },
  en: {
    description: "Create cinematic subtitle images from one movie still and multiple dialogue lines. Adjust fonts, colors and watermarks, then export locally in your browser.",
    guideTitle: "Product guide and frequently asked questions",
    about: "About Shadow Snap",
    introduction: "Created by Ward Lu and Shadow Lab, Shadow Snap helps film fans and content creators turn a single movie still and multiple dialogue lines into a long subtitle image. It keeps the first frame intact, then joins slices of the lower subtitle region beneath it.",
    featuresTitle: "Key features",
    features: [
      "Keep the first frame intact and stitch the following subtitle slices automatically.",
      "Process and export images locally with HTML5 Canvas without uploading photos.",
      "Choose Chinese, Latin, Thai, Vietnamese and Arabic fonts. Adjust type size, colors, outlines, safe margins and watermarks.",
      "Free to use without an account or installation. Import one image at a time.",
    ],
    stepsTitle: "Make a subtitle image in three steps",
    steps: [
      "Import a movie still or video screenshot in JPG, PNG or WebP format.",
      "Enter dialogue, using a new line for each subtitle slice.",
      "Adjust the font, slice height and watermark, then select Export Image. On mobile, save through the share sheet or long-press the image.",
    ],
    faqTitle: "Frequently asked questions",
    supportTitle: "Creator and support",
    support: "Created by Ward Lu and Shadow Lab. Send feedback to support@shadow.wang or contact @Gollumgulu on X.",
    faq: [
      ["What is Shadow Snap?", "Shadow Snap is a free cinematic subtitle image maker that combines one still image with multiple dialogue lines. No account or installation is required."],
      ["How do I create a movie dialogue image?", "Import one image, enter dialogue on separate lines, adjust the font and slice height, then export. The first frame stays intact and subsequent lines use slices from the lower region."],
      ["Are my photos uploaded to a server?", "No. Image processing and export run in your local browser memory. The site loads fonts and uses website analytics; neither requires uploading your images."],
      ["How do I save an image on mobile?", "After exporting, save the image through the system share sheet. Browsers without sharing support open a save panel: tap Download or long-press the image. If saving inside WeChat fails, open the page in your system browser."],
      ["Which languages and fonts are supported?", "The interface is available in 12 languages: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, Spanish, Portuguese, French, German, Russian, Indonesian and Arabic. Font options include Chinese, Latin, Thai, Vietnamese and Arabic scripts. Rendering depends on your browser and font availability."],
    ],
  },
  "zh-hant": {
    description: "影瞬 Shadow Snap 是免費的電影字幕長圖與臺詞拼圖工具。匯入一張劇照，輸入多行對白，調整字型、顏色、字幕條高度和水印，即可在瀏覽器中拼接並匯出長圖。圖片處理在本機完成，不上傳照片，無需登入或安裝。",
    guideTitle: "產品指南與常見問題",
    about: "關於影瞬 Shadow Snap",
    introduction: "Shadow Snap 影瞬由 Ward Lu 與 Shadow Lab 建立，幫助電影愛好者和內容創作者把一張劇照與多行對白拼接成字幕長圖。首張畫面保留完整構圖，後續對白使用底部字幕區域切片向下拼接。",
    featuresTitle: "核心功能",
    features: [
      "保留首張劇照，自動切片並拼接後續字幕條。",
      "在本機瀏覽器中使用 HTML5 Canvas 處理和匯出圖片，不上傳照片。",
      "支援中、英、泰、越、阿等字型，以及字號、顏色、描邊、安全邊距和水印調整。",
      "無需登入或安裝，免費使用；一次匯入一張圖片。",
    ],
    stepsTitle: "三步製作字幕長圖",
    steps: [
      "匯入一張電影劇照或影片截圖（JPG、PNG 或 WebP）。",
      "輸入對白，每行臺詞對應一條字幕切片。",
      "調整字型、字幕條高度和水印，然後點選「匯出長圖」。手機可使用分享面板或長按圖片儲存。",
    ],
    faqTitle: "常見問題",
    supportTitle: "創作者與支援",
    support: "由 Ward Lu 與 Shadow Lab 建立。回饋建議請傳送至 support@shadow.wang，或聯絡 X 帳號 @Gollumgulu。",
    faq: [
      ["什麼是 Shadow Snap 影瞬？", "Shadow Snap 是免費的電影字幕長圖工具，可將一張劇照與多行對白拼接成圖片，無需登入或安裝。"],
      ["如何拼接電影臺詞長圖？", "匯入一張圖片，輸入多行臺詞，然後調整字型與字幕條高度並匯出。第一張畫面完整保留，後續臺詞使用底部區域切片拼接。"],
      ["照片會上傳到伺服器嗎？", "不會。圖片處理和匯出在本機瀏覽器記憶體中完成。網站會載入字型並使用網站存取統計，這不代表上傳圖片。"],
      ["手機如何儲存長圖？", "點選匯出後，通過系統分享面板儲存圖片。不支援分享的瀏覽器會彈出儲存浮層，點「下載原圖」或長按圖片儲存；微信內儲存失敗時可在系統瀏覽器開啟。"],
      ["支援哪些語言和字型？", "介面支援簡體中文、繁體中文、英文、日文、韓文、西班牙文、葡萄牙文、法文、德文、俄文、印尼文和阿拉伯文，共 12 種語言。字型選項包含中文、拉丁文字、泰文、越南文和阿拉伯文。實際字型顯示依賴瀏覽器及字型載入。"],
    ],
  },
  ja: {
    description: "一枚の映画の劇照と複数行の台詞から、映画風の字幕画像を作成します。フォント、色、透かしを調整し、ブラウザ内でローカルに書き出せます。",
    guideTitle: "製品ガイドとよくある質問",
    about: "Shadow Snap について",
    introduction: "Shadow Snap は Ward Lu と Shadow Lab が制作し、映画ファンやコンテンツ制作者が一枚の劇照と複数行の台詞を字幕長尺画像にまとめるのを支援します。最初のフレームは構図をそのまま残し、その下に字幕領域の切片を順につないでいきます。",
    featuresTitle: "主な機能",
    features: [
      "最初のフレームをそのまま保持し、以降の字幕スライスを自動でつなぎます。",
      "写真をアップロードせず、HTML5 Canvas でブラウザ内に画像を処理・書き出します。",
      "中国語、ラテン文字、タイ語、ベトナム語、アラビア語のフォントを選べます。文字サイズ、色、縁取り、安全余白、透かしを調整できます。",
      "アカウントやインストールなしで無料で使えます。一度に読み込めるのは一枚の画像です。",
    ],
    stepsTitle: "三つのステップで字幕画像を作成",
    steps: [
      "JPG、PNG、WebP 形式の映画の劇照またはビデオのスクリーンショットを読み込みます。",
      "台詞を入力します。改行するごとに一つの字幕スライスになります。",
      "フォント、字幕スライスの高さ、透かしを調整してから「画像を書き出す」を選択します。スマートフォンでは共有シートから保存するか、画像を長押しして保存します。",
    ],
    faqTitle: "よくある質問",
    supportTitle: "制作者とサポート",
    support: "Ward Lu と Shadow Lab が制作しています。フィードバックは support@shadow.wang まで、または X の @Gollumgulu までご連絡ください。",
    faq: [
      ["Shadow Snap とは何ですか？", "Shadow Snap は、一枚の画像と複数行の台詞を組み合わせる無料の映画字幕画像メーカーです。アカウントやインストールは不要です。"],
      ["映画の台詞画像はどのように作成しますか？", "画像を一枚読み込み、台詞を行ごとに入力し、フォントと字幕スライスの高さを調整してから書き出します。最初のフレームはそのまま残り、以降の台詞は下部領域のスライスを使用します。"],
      ["写真はサーバーにアップロードされますか？", "いいえ。画像の処理と書き出しはブラウザのローカルメモリ内で行われます。サイトはフォントを読み込み、ウェブサイトのアクセス解析を使用しますが、いずれも画像のアップロードは必要ありません。"],
      ["スマートフォンで画像を保存するにはどうすればよいですか？", "書き出し後、システムの共有シートから画像を保存してください。共有に対応していないブラウザでは保存パネルが開きます。「ダウンロード」をタップするか、画像を長押ししてください。WeChat 内での保存に失敗した場合は、システムのブラウザでページを開いてください。"],
      ["対応している言語とフォントは何ですか？", "インターフェースは 12 言語に対応しています：簡体字中国語、繁体字中国語、英語、日本語、韓国語、スペイン語、ポルトガル語、フランス語、ドイツ語、ロシア語、インドネシア語、アラビア語。フォントは中国語、ラテン文字、タイ語、ベトナム語、アラビア語の文字に対応しています。表示はブラウザとフォントの利用状況によって異なります。"],
    ],
  },
  ko: {
    description: "Shadow Snap은 영화 스틸컷 한 장과 여러 줄의 대사로 시네마틱 자막 이미지를 만드는 무료 도구입니다. 글꼴, 색상, 워터마크를 조정한 뒤 브라우저에서 로컬로 내보낼 수 있습니다.",
    guideTitle: "제품 가이드 및 자주 묻는 질문",
    about: "Shadow Snap 소개",
    introduction: "Ward Lu와 Shadow Lab이 만든 Shadow Snap은 영화 팬과 콘텐츠 크리에이터가 영화 스틸컷 한 장과 여러 줄의 대사를 자막 롱 이미지로 만들 수 있도록 돕습니다. 첫 프레임의 구도는 그대로 유지하고, 그 아래 자막 영역의 슬라이스를 이어 붙입니다.",
    featuresTitle: "주요 기능",
    features: [
      "첫 프레임을 그대로 유지하고, 이어지는 자막 슬라이스를 자동으로 붙입니다.",
      "HTML5 Canvas로 브라우저 안에서 이미지를 로컬로 처리하고 내보내며, 사진을 업로드하지 않습니다.",
      "중국어, 라틴, 태국어, 베트남어, 아랍어 글꼴을 선택할 수 있으며, 글자 크기, 색상, 외곽선, 안전 여백, 워터마크를 조정할 수 있습니다.",
      "계정이나 설치 없이 무료로 사용할 수 있습니다. 한 번에 이미지 한 장씩 가져올 수 있습니다.",
    ],
    stepsTitle: "세 단계로 자막 이미지 만들기",
    steps: [
      "JPG, PNG 또는 WebP 형식의 영화 스틸컷이나 영상 스크린샷을 가져옵니다.",
      "대사를 입력합니다. 자막 슬라이스마다 한 줄씩 입력합니다.",
      "글꼴, 슬라이스 높이, 워터마크를 조정한 뒤 “이미지 내보내기”를 선택합니다. 모바일에서는 공유 시트를 통해 저장하거나 이미지를 길게 누르세요.",
    ],
    faqTitle: "자주 묻는 질문",
    supportTitle: "제작자 및 지원",
    support: "Ward Lu와 Shadow Lab이 만들었습니다. 의견은 support@shadow.wang로 보내 주시거나 X의 @Gollumgulu로 연락해 주세요.",
    faq: [
      ["Shadow Snap이란 무엇인가요?", "Shadow Snap은 이미지 한 장과 여러 줄의 대사를 결합하는 무료 시네마틱 자막 이미지 메이커입니다. 계정이나 설치가 필요하지 않습니다."],
      ["영화 대사 이미지는 어떻게 만드나요?", "이미지를 한 장 가져온 뒤 각 줄에 대사를 입력하고, 글꼴과 슬라이스 높이를 조정한 다음 내보내면 됩니다. 첫 프레임은 그대로 유지되고, 이후 대사는 아래 영역의 슬라이스를 사용합니다."],
      ["사진이 서버에 업로드되나요?", "아니요. 이미지 처리와 내보내기는 로컬 브라우저 메모리에서 실행됩니다. 사이트는 글꼴을 불러오고 웹사이트 분석 도구를 사용하지만, 어느 쪽도 이미지를 업로드하지 않습니다."],
      ["모바일에서 이미지를 어떻게 저장하나요?", "내보낸 뒤 시스템 공유 시트를 통해 이미지를 저장하세요. 공유를 지원하지 않는 브라우저에서는 저장 패널이 열리며, 다운로드를 누르거나 이미지를 길게 누르면 됩니다. WeChat 안에서 저장이 실패하면 시스템 브라우저에서 페이지를 여세요."],
      ["어떤 언어와 글꼴을 지원하나요?", "인터페이스는 12개 언어로 제공됩니다: 간체 중국어, 번체 중국어, 영어, 일본어, 한국어, 스페인어, 포르투갈어, 프랑스어, 독일어, 러시아어, 인도네시아어, 아랍어. 글꼴 옵션에는 중국어, 라틴, 태국어, 베트남어, 아랍어 문자가 포함됩니다. 실제 표시는 브라우저와 글꼴 가용성에 따라 달라집니다."],
    ],
  },
  es: {
    description: "Crea imágenes cinematográficas con subtítulos a partir de un fotograma y varias líneas de diálogo. Ajusta fuentes, colores y marcas de agua, y exporta localmente en tu navegador.",
    guideTitle: "Guía del producto y preguntas frecuentes",
    about: "Acerca de Shadow Snap",
    introduction: "Creado por Ward Lu y Shadow Lab, Shadow Snap ayuda a aficionados al cine y creadores de contenido a convertir un solo fotograma y varias líneas de diálogo en una imagen larga con subtítulos. Conserva intacto el primer encuadre y une debajo los cortes de la zona inferior de subtítulos.",
    featuresTitle: "Funciones principales",
    features: [
      "Conserva intacto el primer fotograma y une automáticamente los siguientes cortes de subtítulos.",
      "Procesa y exporta imágenes localmente con HTML5 Canvas, sin subir fotos.",
      "Elige tipografías para chino, latino, tailandés, vietnamita y árabe. Ajusta el tamaño de fuente, los colores, los contornos, los márgenes de seguridad y las marcas de agua.",
      "Uso gratuito, sin cuenta ni instalación. Importa una imagen a la vez.",
    ],
    stepsTitle: "Crea una imagen con subtítulos en tres pasos",
    steps: [
      "Importa un fotograma de película o una captura de vídeo en formato JPG, PNG o WebP.",
      "Escribe los diálogos, usando una nueva línea para cada corte de subtítulo.",
      "Ajusta la fuente, la altura del corte y la marca de agua, y selecciona Exportar imagen. En móvil, guarda desde el panel de compartir o mantén pulsada la imagen.",
    ],
    faqTitle: "Preguntas frecuentes",
    supportTitle: "Creador y soporte",
    support: "Creado por Ward Lu y Shadow Lab. Envía tus comentarios a support@shadow.wang o contacta con @Gollumgulu en X.",
    faq: [
      ["¿Qué es Shadow Snap?", "Shadow Snap es un generador gratuito de imágenes de subtítulos cinematográficos que combina una imagen fija con varias líneas de diálogo. No requiere cuenta ni instalación."],
      ["¿Cómo creo una imagen con diálogos de película?", "Importa una imagen, escribe los diálogos en líneas separadas, ajusta la fuente y la altura del corte, y exporta. El primer fotograma se mantiene intacto y las siguientes líneas usan cortes de la zona inferior."],
      ["¿Se suben mis fotos a un servidor?", "No. El procesamiento y la exportación de imágenes se realizan en la memoria de tu navegador. El sitio carga fuentes y usa estadísticas de visitas; ninguna de las dos cosas requiere subir tus imágenes."],
      ["¿Cómo guardo una imagen en el móvil?", "Tras exportar, guarda la imagen desde el panel de compartir del sistema. Los navegadores sin función de compartir abren un panel de guardado: toca Descargar o mantén pulsada la imagen. Si el guardado dentro de WeChat falla, abre la página en el navegador del sistema."],
      ["¿Qué idiomas y fuentes son compatibles?", "La interfaz está disponible en 12 idiomas: chino simplificado, chino tradicional, inglés, japonés, coreano, español, portugués, francés, alemán, ruso, indonesio y árabe. Las opciones de fuente incluyen escrituras china, latina, tailandesa, vietnamita y árabe. La visualización depende del navegador y de la disponibilidad de las fuentes."],
    ],
  },
  pt: {
    description: "Crie imagens cinematográficas com legendas a partir de um único fotograma de filme e de várias falas. Ajuste fontes, cores e marcas d'água e exporte localmente no seu navegador.",
    guideTitle: "Guia do produto e perguntas frequentes",
    about: "Sobre o Shadow Snap",
    introduction: "Criado por Ward Lu e pelo Shadow Lab, o Shadow Snap ajuda fãs de cinema e criadores de conteúdo a transformar um único fotograma de filme e várias falas em uma longa imagem com legendas. Ele mantém o primeiro quadro intacto e, em seguida, une recortes da região inferior de legendas logo abaixo.",
    featuresTitle: "Principais recursos",
    features: [
      "Mantém o primeiro quadro intacto e une automaticamente os recortes de legenda seguintes.",
      "Processa e exporta imagens localmente com HTML5 Canvas, sem enviar fotos.",
      "Escolha fontes para chinês, alfabeto latino, tailandês, vietnamita e árabe. Ajuste o tamanho do texto, as cores, os contornos, as margens de segurança e as marcas d'água.",
      "Gratuito, sem conta ou instalação. Importe uma imagem por vez.",
    ],
    stepsTitle: "Crie uma imagem com legendas em três passos",
    steps: [
      "Importe um fotograma de filme ou uma captura de vídeo nos formatos JPG, PNG ou WebP.",
      "Digite os diálogos, usando uma nova linha para cada recorte de legenda.",
      "Ajuste a fonte, a altura do recorte e a marca d'água e selecione Exportar imagem. No celular, salve pela folha de compartilhamento ou pressionando e segurando a imagem.",
    ],
    faqTitle: "Perguntas frequentes",
    supportTitle: "Criador e suporte",
    support: "Criado por Ward Lu e pelo Shadow Lab. Envie feedback para support@shadow.wang ou entre em contato com @Gollumgulu no X.",
    faq: [
      ["O que é o Shadow Snap?", "O Shadow Snap é um gerador gratuito de imagens de legenda cinematográficas que combina um fotograma com várias falas. Não é preciso conta nem instalação."],
      ["Como criar uma imagem com falas de filme?", "Importe uma imagem, digite as falas em linhas separadas, ajuste a fonte e a altura do recorte e exporte. O primeiro quadro permanece intacto e as falas seguintes usam recortes da região inferior."],
      ["Minhas fotos são enviadas para um servidor?", "Não. O processamento e a exportação das imagens são feitos na memória do seu navegador. O site carrega fontes e usa estatísticas de acesso; nenhum dos dois exige o envio das suas imagens."],
      ["Como salvar uma imagem no celular?", "Depois de exportar, salve a imagem pela folha de compartilhamento do sistema. Navegadores sem suporte a compartilhamento abrem uma janela de salvamento: toque em Baixar ou pressione e segure a imagem. Se o salvamento dentro do WeChat falhar, abra a página no navegador do sistema."],
      ["Quais idiomas e fontes são compatíveis?", "A interface está disponível em 12 idiomas: chinês simplificado, chinês tradicional, inglês, japonês, coreano, espanhol, português, francês, alemão, russo, indonésio e árabe. As opções de fonte incluem os alfabetos chinês, latino, tailandês, vietnamita e árabe. A renderização depende do navegador e da disponibilidade das fontes."],
    ],
  },
  fr: {
    description: "Créez des images de sous-titres façon cinéma à partir d’une image de film et de plusieurs répliques. Ajustez polices, couleurs et filigranes, puis exportez localement dans votre navigateur.",
    guideTitle: "Guide du produit et questions fréquentes",
    about: "À propos de Shadow Snap",
    introduction: "Créé par Ward Lu et Shadow Lab, Shadow Snap aide les cinéphiles et les créateurs de contenu à transformer une seule image de film et plusieurs répliques en une longue image de sous-titres. Il conserve intacte la première image, puis assemble en dessous des tranches de la zone de sous-titres inférieure.",
    featuresTitle: "Fonctions principales",
    features: [
      "Conservez intacte la première image et assemblez automatiquement les tranches de sous-titres suivantes.",
      "Traitez et exportez les images localement avec HTML5 Canvas, sans téléverser vos photos.",
      "Choisissez des polices chinoises, latines, thaïes, vietnamiennes et arabes. Ajustez la taille, les couleurs, les contours, les marges de sécurité et les filigranes.",
      "Utilisation gratuite, sans compte ni installation. Importez une image à la fois.",
    ],
    stepsTitle: "Créez une image de sous-titres en trois étapes",
    steps: [
      "Importez une image de film ou une capture vidéo au format JPG, PNG ou WebP.",
      "Saisissez les dialogues, en allant à la ligne pour chaque tranche de sous-titre.",
      "Ajustez la police, la hauteur des tranches et le filigrane, puis sélectionnez “Exporter l’image”. Sur mobile, enregistrez via le panneau de partage ou par un appui long sur l’image.",
    ],
    faqTitle: "Questions fréquentes",
    supportTitle: "Créateur et support",
    support: "Créé par Ward Lu et Shadow Lab. Envoyez vos commentaires à support@shadow.wang ou contactez @Gollumgulu sur X.",
    faq: [
      ["Qu’est-ce que Shadow Snap ?", "Shadow Snap est un générateur gratuit d’images de sous-titres façon cinéma, qui combine une image fixe et plusieurs répliques. Aucun compte ni installation n’est nécessaire."],
      ["Comment créer une image de répliques de film ?", "Importez une image, saisissez les répliques sur des lignes séparées, ajustez la police et la hauteur des tranches, puis exportez. La première image reste intacte et les lignes suivantes utilisent des tranches de la zone inférieure."],
      ["Mes photos sont-elles envoyées sur un serveur ?", "Non. Le traitement et l’export des images se font dans la mémoire locale de votre navigateur. Le site charge des polices et utilise des statistiques de fréquentation ; aucun de ces éléments n’exige d’envoyer vos images."],
      ["Comment enregistrer une image sur mobile ?", "Après l’export, enregistrez l’image via le panneau de partage du système. Les navigateurs sans partage ouvrent une fenêtre d’enregistrement : appuyez sur Télécharger ou faites un appui long sur l’image. Si l’enregistrement dans WeChat échoue, ouvrez la page dans le navigateur de votre système."],
      ["Quelles langues et polices sont prises en charge ?", "L’interface est disponible en 12 langues : chinois simplifié, chinois traditionnel, anglais, japonais, coréen, espagnol, portugais, français, allemand, russe, indonésien et arabe. Les polices couvrent les écritures chinoise, latine, thaïe, vietnamienne et arabe. Le rendu dépend du navigateur et de la disponibilité des polices."],
    ],
  },
  de: {
    description: "Erstellen Sie aus einem Filmstandbild und mehreren Dialogzeilen filmische Untertitelbilder. Passen Sie Schriften, Farben und Wasserzeichen an und exportieren Sie das Ergebnis lokal im Browser.",
    guideTitle: "Produktanleitung und häufig gestellte Fragen",
    about: "Über Shadow Snap",
    introduction: "Shadow Snap wurde von Ward Lu und Shadow Lab entwickelt. Es hilft Filmfans und Content-Creatorn, ein einzelnes Filmstandbild und mehrere Dialogzeilen zu einem langen Untertitelbild zu verbinden. Das erste Bild bleibt unverändert, darunter werden Segmente des unteren Untertitelbereichs angefügt.",
    featuresTitle: "Wichtige Funktionen",
    features: [
      "Das erste Bild bleibt unverändert, die folgenden Untertitelsegmente werden automatisch angefügt.",
      "Bilder werden mit HTML5 Canvas lokal im Browser verarbeitet und exportiert, ohne dass Fotos hochgeladen werden.",
      "Wählen Sie Schriften für Chinesisch, Lateinisch, Thai, Vietnamesisch und Arabisch. Passen Sie Schriftgröße, Farben, Konturen, Sicherheitsabstände und Wasserzeichen an.",
      "Kostenlos nutzbar ohne Konto oder Installation. Importieren Sie jeweils ein Bild.",
    ],
    stepsTitle: "Ein Untertitelbild in drei Schritten erstellen",
    steps: [
      "Importieren Sie ein Filmstandbild oder einen Videoscreenshot im Format JPG, PNG oder WebP.",
      "Geben Sie die Dialoge ein, wobei jede Untertitelzeile in einer neuen Zeile steht.",
      "Passen Sie Schrift, Segmenthöhe und Wasserzeichen an und wählen Sie dann „Bild exportieren“. Auf dem Smartphone speichern Sie über das Teilen-Menü oder durch langes Drücken auf das Bild.",
    ],
    faqTitle: "Häufig gestellte Fragen",
    supportTitle: "Creator und Support",
    support: "Erstellt von Ward Lu und Shadow Lab. Senden Sie Feedback an support@shadow.wang oder kontaktieren Sie @Gollumgulu auf X.",
    faq: [
      ["Was ist Shadow Snap?", "Shadow Snap ist ein kostenloser Generator für filmische Untertitelbilder, der ein Standbild mit mehreren Dialogzeilen kombiniert. Ein Konto oder eine Installation ist nicht erforderlich."],
      ["Wie erstelle ich ein Bild mit Filmdialog?", "Importieren Sie ein Bild, geben Sie die Dialoge in getrennten Zeilen ein, passen Sie Schrift und Segmenthöhe an und exportieren Sie. Das erste Bild bleibt unverändert, die weiteren Zeilen verwenden Segmente aus dem unteren Bereich."],
      ["Werden meine Fotos auf einen Server hochgeladen?", "Nein. Die Bildverarbeitung und der Export laufen im lokalen Speicher Ihres Browsers. Die Website lädt Schriften und nutzt eine Website-Analyse; keines davon erfordert den Upload Ihrer Bilder."],
      ["Wie speichere ich ein Bild auf dem Smartphone?", "Speichern Sie das Bild nach dem Export über das Teilen-Menü des Systems. Browser ohne Teilfunktion öffnen ein Speicherfenster: Tippen Sie auf „Herunterladen“ oder halten Sie das Bild gedrückt. Schlägt das Speichern innerhalb von WeChat fehl, öffnen Sie die Seite im System-Browser."],
      ["Welche Sprachen und Schriften werden unterstützt?", "Die Oberfläche ist in 12 Sprachen verfügbar: Vereinfachtes Chinesisch, Traditionelles Chinesisch, Englisch, Japanisch, Koreanisch, Spanisch, Portugiesisch, Französisch, Deutsch, Russisch, Indonesisch und Arabisch. Zu den Schriftoptionen gehören Schriften für chinesische, lateinische, thailändische, vietnamesische und arabische Schrift. Die Darstellung hängt von Ihrem Browser und der Verfügbarkeit der Schriften ab."],
    ],
  },
  ru: {
    description: "Создавайте киношные изображения с субтитрами из одного кадра фильма и нескольких реплик. Настраивайте шрифты, цвета и водяные знаки, затем экспортируйте изображение локально в браузере.",
    guideTitle: "Руководство по продукту и частые вопросы",
    about: "О Shadow Snap",
    introduction: "Shadow Snap создан Ward Lu и Shadow Lab. Он помогает любителям кино и создателям контента превратить один кадр из фильма и несколько реплик в длинное изображение с субтитрами. Первый кадр сохраняется целиком, а под ним присоединяются фрагменты нижней области субтитров.",
    featuresTitle: "Основные функции",
    features: [
      "Первый кадр сохраняется целиком, а следующие фрагменты субтитров склеиваются автоматически.",
      "Изображения обрабатываются и экспортируются локально с помощью HTML5 Canvas, фото не загружаются на сервер.",
      "Доступны шрифты для китайского, латиницы, тайского, вьетнамского и арабского языков. Можно настраивать размер шрифта, цвета, обводку, безопасные поля и водяные знаки.",
      "Использование бесплатное, без аккаунта и установки. За раз импортируется одно изображение.",
    ],
    stepsTitle: "Создайте изображение с субтитрами в три шага",
    steps: [
      "Импортируйте кадр из фильма или скриншот видео в формате JPG, PNG или WebP.",
      "Введите диалог, начиная каждый фрагмент субтитров с новой строки.",
      "Настройте шрифт, высоту фрагмента и водяной знак, затем выберите «Экспорт изображения». На телефоне сохраните изображение через меню «Поделиться» или нажмите на него и удерживайте.",
    ],
    faqTitle: "Часто задаваемые вопросы",
    supportTitle: "Автор и поддержка",
    support: "Создано Ward Lu и Shadow Lab. Отзывы отправляйте на support@shadow.wang или напишите автору в X: @Gollumgulu.",
    faq: [
      ["Что такое Shadow Snap?", "Shadow Snap — бесплатный инструмент для создания киношных изображений с субтитрами. Он объединяет один кадр и несколько реплик. Аккаунт и установка не требуются."],
      ["Как создать изображение с репликами из фильма?", "Импортируйте одно изображение, введите реплики на отдельных строках, настройте шрифт и высоту фрагмента, затем экспортируйте результат. Первый кадр сохраняется целиком, а последующие реплики используют фрагменты нижней области."],
      ["Мои фотографии загружаются на сервер?", "Нет. Обработка и экспорт изображений выполняются в локальной памяти браузера. Сайт загружает шрифты и использует веб-аналитику, но ни то ни другое не требует загрузки ваших изображений."],
      ["Как сохранить изображение на телефоне?", "После экспорта сохраните изображение через системное меню «Поделиться». Браузеры без поддержки отправки откроют окно сохранения: нажмите «Скачать» или нажмите на изображение и удерживайте его. Если сохранение внутри WeChat не работает, откройте страницу в системном браузере."],
      ["Какие языки и шрифты поддерживаются?", "Интерфейс доступен на 12 языках: упрощённом китайском, традиционном китайском, английском, японском, корейском, испанском, португальском, французском, немецком, русском, индонезийском и арабском. Варианты шрифтов включают китайскую, латинскую, тайскую, вьетнамскую и арабскую письменности. Отображение зависит от браузера и доступности шрифтов."],
    ],
  },
  id: {
    description: "Buat gambar subtitle sinematik dari satu cuplikan film dan beberapa baris dialog. Atur font, warna, dan watermark, lalu ekspor secara lokal di browser Anda.",
    guideTitle: "Panduan produk dan pertanyaan yang sering diajukan",
    about: "Tentang Shadow Snap",
    introduction: "Dibuat oleh Ward Lu dan Shadow Lab, Shadow Snap membantu penggemar film dan kreator konten mengubah satu cuplikan film dan beberapa baris dialog menjadi gambar subtitle panjang. Bingkai pertama tetap utuh, lalu potongan dari area subtitle di bagian bawah disambung ke bawahnya.",
    featuresTitle: "Fitur utama",
    features: [
      "Pertahankan bingkai pertama tetap utuh dan sambung potongan subtitle berikutnya secara otomatis.",
      "Proses dan ekspor gambar secara lokal dengan HTML5 Canvas tanpa mengunggah foto.",
      "Pilih font Tionghoa, Latin, Thai, Vietnam, dan Arab. Atur ukuran huruf, warna, garis tepi, margin aman, dan watermark.",
      "Gratis digunakan tanpa akun atau instalasi. Impor satu gambar setiap kali.",
    ],
    stepsTitle: "Buat gambar subtitle dalam tiga langkah",
    steps: [
      "Impor cuplikan film atau tangkapan layar video dalam format JPG, PNG, atau WebP.",
      "Masukkan dialog, dengan baris baru untuk setiap potongan subtitle.",
      "Atur font, tinggi potongan, dan watermark, lalu pilih Ekspor Gambar. Di ponsel, simpan melalui panel berbagi atau tekan lama gambarnya.",
    ],
    faqTitle: "Pertanyaan yang sering diajukan",
    supportTitle: "Kreator dan dukungan",
    support: "Dibuat oleh Ward Lu dan Shadow Lab. Kirim masukan ke support@shadow.wang atau hubungi @Gollumgulu di X.",
    faq: [
      ["Apa itu Shadow Snap?", "Shadow Snap adalah pembuat gambar subtitle sinematik gratis yang menggabungkan satu gambar cuplikan dengan beberapa baris dialog. Tidak perlu akun atau instalasi."],
      ["Bagaimana cara membuat gambar dialog film?", "Impor satu gambar, masukkan dialog di baris terpisah, atur font dan tinggi potongan, lalu ekspor. Bingkai pertama tetap utuh dan baris berikutnya menggunakan potongan dari area bawah."],
      ["Apakah foto saya diunggah ke server?", "Tidak. Pemrosesan dan ekspor gambar berjalan di memori browser lokal Anda. Situs ini memuat font dan menggunakan analitik situs web; keduanya tidak memerlukan pengunggahan gambar Anda."],
      ["Bagaimana cara menyimpan gambar di ponsel?", "Setelah diekspor, simpan gambar melalui panel berbagi sistem. Browser yang tidak mendukung berbagi akan membuka panel simpan: ketuk Unduh atau tekan lama gambarnya. Jika penyimpanan di dalam WeChat gagal, buka halaman ini di browser sistem Anda."],
      ["Bahasa dan font apa saja yang didukung?", "Antarmuka tersedia dalam 12 bahasa: Tionghoa Sederhana, Tionghoa Tradisional, Inggris, Jepang, Korea, Spanyol, Portugis, Prancis, Jerman, Rusia, Indonesia, dan Arab. Pilihan font mencakup aksara Tionghoa, Latin, Thai, Vietnam, dan Arab. Hasil tampilan bergantung pada browser dan ketersediaan font Anda."],
    ],
  },
  ar: {
    description: "أنشئ صوراً ترجمية سينمائية من لقطة فيلم واحدة وعدة أسطر حوار. اضبط الخطوط والألوان والعلامات المائية، ثم صدّر الصورة محلياً داخل متصفحك.",
    guideTitle: "دليل المنتج والأسئلة الشائعة",
    about: "عن Shadow Snap",
    introduction: "أنشأ Ward Lu وShadow Lab أداة Shadow Snap لمساعدة محبي الأفلام وصنّاع المحتوى على تحويل لقطة فيلم واحدة وعدة أسطر حوار إلى صورة ترجمة طويلة. تحافظ الأداة على الإطار الأول كما هو، ثم تُلحق به مقاطع من منطقة الترجمة السفلية.",
    featuresTitle: "أبرز الميزات",
    features: [
      "الحفاظ على الإطار الأول كما هو، وتجميع مقاطع الترجمة اللاحقة تلقائياً.",
      "معالجة الصور وتصديرها محلياً باستخدام HTML5 Canvas دون رفع الصور.",
      "اختر خطوط الصينية واللاتينية والتايلاندية والفيتنامية والعربية، واضبط حجم النص والألوان والحدود والهوامش الآمنة والعلامات المائية.",
      "استخدام مجاني دون حساب أو تثبيت. يمكنك استيراد صورة واحدة في كل مرة.",
    ],
    stepsTitle: "أنشئ صورة ترجمة في ثلاث خطوات",
    steps: [
      "استورد لقطة فيلم أو لقطة شاشة من فيديو بصيغة JPG أو PNG أو WebP.",
      "أدخل الحوار، واستخدم سطراً جديداً لكل مقطع ترجمة.",
      "اضبط الخط وارتفاع المقطع والعلامة المائية، ثم اختر «تصدير الصورة». على الجوال، احفظ الصورة من قائمة المشاركة أو اضغط عليها مطولاً.",
    ],
    faqTitle: "الأسئلة الشائعة",
    supportTitle: "صانع المحتوى والدعم",
    support: "أنشأ Ward Lu وShadow Lab هذه الأداة. أرسل ملاحظاتك إلى support@shadow.wang أو تواصل مع @Gollumgulu على X.",
    faq: [
      ["ما هو Shadow Snap؟", "Shadow Snap أداة مجانية لإنشاء صور ترجمة سينمائية، تجمع لقطة واحدة مع عدة أسطر حوار. لا يتطلب استخدامها حساباً أو تثبيتاً."],
      ["كيف أنشئ صورة لحوار فيلم؟", "استورد صورة واحدة، وأدخل الحوار في أسطر منفصلة، واضبط الخط وارتفاع المقطع، ثم صدّر الصورة. يبقى الإطار الأول كما هو، وتستخدم الأسطر اللاحقة مقاطع من المنطقة السفلية."],
      ["هل تُرفع صوري إلى خادم؟", "لا. تتم معالجة الصور وتصديرها في ذاكرة متصفحك المحلية. يحمّل الموقع الخطوط ويستخدم تحليلات الموقع، ولا يتطلب أيٌّ منهما رفع صورك."],
      ["كيف أحفظ الصورة على الجوال؟", "بعد التصدير، احفظ الصورة عبر قائمة المشاركة في النظام. المتصفحات التي لا تدعم المشاركة تفتح نافذة حفظ: اضغط «تنزيل» أو اضغط الصورة مطولاً. إذا تعذّر الحفظ داخل WeChat، فافتح الصفحة في متصفح جهازك."],
      ["ما اللغات والخطوط المدعومة؟", "تتوفر الواجهة بـ 12 لغة: الصينية المبسطة، والصينية التقليدية، والإنجليزية، واليابانية، والكورية، والإسبانية، والبرتغالية، والفرنسية، والألمانية، والروسية، والإندونيسية، والعربية. تشمل خيارات الخطوط الكتابات الصينية واللاتينية والتايلاندية والفيتنامية والعربية. ويعتمد العرض على متصفحك وتوفر الخطوط لديك."],
    ],
  },
};

export const SEO = Object.fromEntries(LOCALES.map((locale) => {
  const config = LOCALE_CONFIG[locale];
  const path = locale === 'zh' ? '/' : `/${locale}/`;
  return [locale, { ...config, url: `${ORIGIN}${path}`, path, lang: config.htmlLang, ...CONTENT[locale] }];
}));

export const SEO_FIELDS = ['url', 'path', 'lang', 'ogLocale', 'dir', 'nativeName', 'hreflang', ...CONTENT_KEYS];
const TRANS_KEYS = Object.keys(TRANS.zh);

// Shared by the static generator, validator and in-page language switch; fails closed on any missing or extra locale fact.
export function assertLocaleCompleteness() {
  for (const locale of LOCALES) {
    const messages = TRANS[locale];
    if (!messages) throw new Error(`locale_messages_missing:${locale}`);
    for (const key of TRANS_KEYS) {
      if (typeof messages[key] !== 'string' || messages[key] === '') throw new Error(`locale_key_missing:${locale}:${key}`);
    }
    for (const key of Object.keys(messages)) {
      if (!TRANS_KEYS.includes(key)) throw new Error(`locale_key_extra:${locale}:${key}`);
    }
    for (const field of SEO_FIELDS) {
      if (SEO[locale][field] === undefined || SEO[locale][field] === '') throw new Error(`locale_field_missing:${locale}:${field}`);
    }
    for (const field of ['features', 'steps']) {
      if (SEO[locale][field].length !== SEO.zh[field].length || SEO[locale][field].some((item) => typeof item !== 'string' || !item)) {
        throw new Error(`locale_shape_invalid:${locale}:${field}`);
      }
    }
    if (SEO[locale].faq.length !== SEO.zh.faq.length || SEO[locale].faq.some((pair) => pair.length !== 2 || pair.some((item) => !item))) {
      throw new Error(`locale_shape_invalid:${locale}:faq`);
    }
  }
  for (const [quote, lines] of Object.entries(QUOTES)) {
    for (const locale of LOCALES) {
      if (!lines[locale]) throw new Error(`locale_quote_missing:${locale}:${quote}`);
    }
  }
}

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// The first path segment selects a locale; `/` (no segment) is Chinese for the product page.
const segmentLocale = (pathname) => {
  const segment = pathname.match(/^\/([^/]+)(?:\/|$)/)?.[1];
  return LOCALES.includes(segment) ? segment : null;
};
// Product page: `/zh/` is not a route, so anything without a known non-zh prefix is Chinese, matching the root page.
export const localeFromPath = (pathname) => {
  const locale = segmentLocale(pathname);
  return locale && locale !== 'zh' ? locale : 'zh';
};
// 404 page: same rule as the product page. Chinese lives at the unprefixed root, so a missing path without a known
// locale prefix (e.g. `/missing`) is Chinese; `/ja/missing` is Japanese. The static 404.html itself stays English for no-JS readers.
export const notFoundLocaleFromPath = (pathname) => localeFromPath(pathname);

// Every page carries the same complete set: each locale's own tags plus x-default pointing at English.
export function hreflangEntries() {
  return [
    ...LOCALES.flatMap((locale) => SEO[locale].hreflang.map((tag) => [tag, SEO[locale].url])),
    ['x-default', SEO[DEFAULT_LOCALE].url],
  ];
}

export const ogAlternateLocales = (locale) => LOCALES.filter((item) => item !== locale).map((item) => SEO[item].ogLocale);

// Native-name links to every locale page; crawlers see them in HTML, the switch intercepts clicks via data-locale.
export function localeLinksHtml(separator = ' · ') {
  return LOCALES.map((locale) => {
    const s = SEO[locale];
    return `<a href="${s.path}" hreflang="${escapeHtml(s.hreflang[0])}" lang="${escapeHtml(s.lang)}" data-locale="${locale}">${escapeHtml(s.nativeName)}</a>`;
  }).join(separator);
}

export function guideHtml(locale) {
  const s = SEO[locale];
  const items = (values) => values.map((value) => `<li>${escapeHtml(value)}</li>`).join('');
  return `<h2>${escapeHtml(s.about)}</h2><p>${escapeHtml(s.introduction)}</p>
<h2>${escapeHtml(s.featuresTitle)}</h2><ul>${items(s.features)}</ul>
<h2>${escapeHtml(s.stepsTitle)}</h2><ol>${items(s.steps)}</ol>
<h2>${escapeHtml(s.faqTitle)}</h2><dl>${s.faq.map(([question, answer]) => `<dt><h3>${escapeHtml(question)}</h3></dt><dd><p>${escapeHtml(answer)}</p></dd>`).join('')}</dl>
<h2>${escapeHtml(s.supportTitle)}</h2><p>${escapeHtml(s.support)}</p>
<p class="locale-links">${localeLinksHtml()}</p>`;
}

export function localizeSchema(data, locale) {
  const s = SEO[locale];
  const result = structuredClone(data);
  for (const node of result['@graph'] ?? [result]) {
    if (node['@type'] === 'WebApplication') {
      node.url = s.url;
      node.inLanguage = s.lang;
      node.description = s.description;
      if (node.featureList) node.featureList = s.features;
      if (node.image) node.image = locale === 'zh' || locale === 'zh-hant' ? 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap.png' : 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap_en.png';
      if (node.offers) node.offers.url = s.url;
    } else if (node['@type'] === 'WebSite') {
      node.description = s.description;
    } else if (node['@type'] === 'FAQPage') {
      node['@id'] = `${s.url}#faq`;
      node.inLanguage = s.lang;
      node.mainEntity = s.faq.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } }));
    }
  }
  return result;
}

// Runtime switch: lang, dir, title, metadata and the guide follow the locale; og:locale:alternate is replaced as a set.
export function applyLocaleSeo(locale) {
  const s = SEO[locale];
  const t = TRANS[locale];
  const isZh = locale === 'zh' || locale === 'zh-hant';
  const shareImage = isZh
    ? 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap.png'
    : 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap_en.png';
  const meta = (attribute, key, value) => document.querySelector(`meta[${attribute}="${key}"]`).setAttribute('content', value);
  document.title = t.page_title;
  document.documentElement.lang = s.lang;
  document.documentElement.dir = s.dir;
  document.querySelector('link[rel="canonical"]').href = s.url;
  meta('name', 'description', s.description);
  for (const prefix of ['og', 'twitter']) {
    const attribute = prefix === 'og' ? 'property' : 'name';
    meta(attribute, `${prefix}:title`, t.page_title);
    meta(attribute, `${prefix}:description`, s.description);
    meta(attribute, `${prefix}:image:alt`, t.share_image_alt);
    meta(attribute, `${prefix}:image`, shareImage);
  }
  meta('property', 'og:url', s.url);
  meta('property', 'og:locale', s.ogLocale);
  document.querySelectorAll('meta[property="og:locale:alternate"]').forEach((node) => node.remove());
  for (const ogLocale of ogAlternateLocales(locale)) {
    const node = document.createElement('meta');
    node.setAttribute('property', 'og:locale:alternate');
    node.setAttribute('content', ogLocale);
    document.head.append(node);
  }
  document.querySelector('#product-guide summary').textContent = s.guideTitle;
  const guide = document.querySelector('#product-guide article');
  guide.setAttribute('aria-label', s.guideTitle);
  guide.innerHTML = guideHtml(locale);
  for (const id of ['shadow-snap-structured-data', 'shadow-snap-geo-data']) {
    const script = document.getElementById(id);
    script.textContent = JSON.stringify(localizeSchema(JSON.parse(script.textContent), locale), null, 2);
  }
  document.querySelector('[data-product-link]').href = `https://shadow.wang/${locale}/products/shadow-snap`;
  document.querySelector('[data-portal-link]').href = `https://shadow.wang/${locale}`;
}
