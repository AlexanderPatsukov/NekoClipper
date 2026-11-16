/* NekoClipper — языки интерфейса (ru / en).
   Исходный язык интерфейса — русский. Для English строки переводятся на лету по словарю:
   тексты, подсказки (title) и плейсхолдеры, в том числе те, что появляются потом (тосты, статусы),
   надписи на canvas и тексты confirm/prompt. Пользовательский контент (субтитры, чат, названия) не трогается. */
(() => {
  const KEY = 'nekoLang';
  let lang = 'ru';
  try { lang = localStorage.getItem(KEY) || ((navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en'); } catch { }
  window.LANG = lang;
  window.setLang = l => { try { localStorage.setItem(KEY, l); } catch { } location.reload(); };
  document.documentElement.lang = lang;
  if (lang === 'ru') { window.T = s => s; return; }

  /* ------------------------------------------------------------ точные строки */
  const D = {
    // шапка и главный экран
    'Ссылка на стрим (YouTube, Twitch) или путь к видеофайлу': 'Stream link (YouTube, Twitch) or path to a video file',
    'В каком качестве скачивать стрим (если у стрима нет 60 fps — скачается 30)': 'Download quality (if the stream has no 60 fps, 30 fps is used)',
    'Лучшее, что есть': 'Best available', 'Сразу отрендерить все найденные клипы': 'Render all found clips right away',
    'сразу рендерить': 'auto-render', 'Нарезать': 'Clip it', 'Настройки': 'Settings', '⚙ Настройки': '⚙ Settings',
    'Язык / Language': 'Language / Язык', 'Стримы': 'Streams', 'Пока пусто': 'Nothing yet',
    'Вставь ссылку на стрим — получишь шортсы': 'Paste a stream link — get shorts',
    'Программа скачает запись, распознает речь, найдёт самые живые моменты по громкости, чату и смыслу\n       и соберёт вертикальные клипы с субтитрами. Любой клип можно поправить в редакторе или вырезать свой вручную.':
      'NekoClipper downloads the VOD, transcribes speech, finds the liveliest moments by loudness, chat and meaning, and builds vertical clips with subtitles. Any clip can be tweaked in the editor, or you can cut your own.',
    'Заново найти моменты (видео и расшифровка не пересчитываются)': 'Find moments again (video and transcript are reused)',
    '↻ Найти моменты заново': '↻ Find moments again',
    'Скачать видео стрима заново в другом качестве (речь и клипы останутся)': 'Re-download the stream video in another quality (transcript and clips stay)',
    '⬇ Качество видео': '⬇ Video quality', '📂 Папка с клипами': '📂 Clips folder', 'Удалить': 'Delete',
    'Пробел': 'Space', 'Клавиша I': 'Key I', '[ Начало': '[ Start', 'Клавиша O': 'Key O', 'Конец ]': 'End ]',
    'Проиграть выделенный отрезок по кругу': 'Loop the selected range', '⟲ Отрезок': '⟲ Loop',
    '✂ Вырезать клип и открыть редактор': '✂ Cut clip and open editor',
    'Потяни мышью по шкале, чтобы выделить отрезок · колесо — масштаб · Shift+колесо — прокрутка · I / O — начало и конец · ← → — перемотка':
      'Drag on the timeline to select a range · wheel — zoom · Shift+wheel — scroll · I / O — start and end · ← → — seek',
    'Клипы': 'Clips', 'Отрендерить все': 'Render all', 'ошибка': 'error',
    'Создан вручную': 'Made manually', 'Оценка вирусности': 'Virality score',
    'выбрала нейросеть': 'picked by AI', 'всплеск эмоций': 'emotion spike', 'вручную': 'manual', 'настроен': 'customized',
    'рендер…': 'rendering…', 'в очереди': 'queued', '▶ Шортс': '▶ Short', 'Скачать': 'Download', 'Отрендерить заново': 'Render again',
    'Настройки изменились после рендера': 'Settings changed after render', 'изменён': 'changed', 'готов': 'ready',
    'Сделать шортс': 'Make short', 'Проиграть отрезок': 'Play range', '✎ Редактор': '✎ Editor',
    'Моменты не найдены. Выдели отрезок на шкале и вырежи клип вручную.': 'No moments found. Select a range on the timeline and cut a clip manually.',
    'Клипы появятся после анализа. Свой клип можно вырезать уже сейчас, как только загрузится видео.': 'Clips will appear after analysis. You can cut your own as soon as the video is loaded.',
    'Мой клип': 'My clip', 'Видео ещё скачивается': 'Video is still downloading',
    // редактор: шапка
    '← К списку': '← Back', 'Предыдущий клип': 'Previous clip', 'Следующий клип': 'Next clip', 'Заголовок шортса': 'Short title',
    'Скачать вырезанный отрезок без оформления': 'Download the raw cut', '⬇ Без оформления': '⬇ Raw cut',
    'Просто вырезать этот отрезок из стрима как есть: исходный кадр, без раскладки и текста': 'Just cut this range from the stream as is: original frame, no layout or text',
    '✂ Вырезать как есть': '✂ Raw cut', '▶ Готовый шортс': '▶ Finished short',
    'Сохраняю…': 'Saving…', 'Сохранено': 'Saved', 'Шортс готов': 'Short is ready', 'Изменён после рендера': 'Changed after render',
    'Вырезаю отрезок как есть — файл появится в папке с клипами': 'Cutting the range as is — the file will appear in the clips folder',
    // редактор: исходник и шкалы
    'Исходный кадр — рамки можно двигать и тянуть за края': 'Source frame — boxes can be moved and resized by their edges',
    'Шкала клипа: тяни по шкале — перемотка · голубые края — длина клипа · колесо — масштаб · Alt+тяни (или средняя кнопка, Shift+колесо) — прокрутка':
      'Clip timeline: drag — scrub · blue edges — clip length · wheel — zoom · Alt+drag (or middle button, Shift+wheel) — scroll',
    'Отдалить': 'Zoom out', 'Приблизить': 'Zoom in', 'Показать клип целиком': 'Fit the clip', 'Клип': 'Clip',
    'Показать весь стрим': 'Show the whole stream', 'Весь стрим': 'Whole stream',
    '🎬 Слои': '🎬 Layers', 'полоска — когда слой виден: тяни за края, двигай · щелчок — выбрать слой': 'bar — when the layer is visible: drag edges, move · click — select layer',
    '🔊 Звуковая дорожка': '🔊 Audio track',
    'выдели кусок мышкой · жёлтая линия — громкость, её можно тянуть · двойной щелчок — выделить слово': 'drag to select a piece · yellow line — volume, drag it · double-click — select a word',
    'Найти мат в расшифровке и поставить на него «пик»': 'Find swear words in the transcript and bleep them', 'Запикать мат': 'Bleep swears',
    'Общая громкость всего клипа': 'Volume of the whole clip', 'Весь клип': 'Whole clip', 'весь клип': 'whole clip',
    'Прослушать выделенное': 'Listen to the selection', '▶ Прослушать': '▶ Listen',
    'Заглушить и поставить «пик»; слово в субтитрах закроется звёздочками': 'Mute and bleep; the word in subtitles is masked with asterisks', '🔇 Пик': '🔇 Bleep',
    'Вырезать звук на этом куске — будет тишина': 'Cut the sound here — silence', '✂ Вырезать звук': '✂ Cut sound',
    'Тише в 2 раза': '2× quieter', '− Тише': '− Quieter', 'Громче в 1.5 раза': '1.5× louder', '+ Громче': '+ Louder',
    'Громкость куска': 'Piece volume', 'Громкость': 'Volume', 'Delete — вернуть звук как был': 'Delete — restore the original sound', '✕ Убрать правку': '✕ Remove edit',
    'Ничего не выделено — протяни мышкой по дорожке, чтобы выделить кусок': 'Nothing selected — drag over the track to select a piece',
    'выделено': 'selected', 'пик': 'bleep', 'звук вырезан': 'sound cut', 'громкость': 'volume',
    'Мата в расшифровке не нашлось. Если он есть — выдели кусок на дорожке (двойной щелчок по слову) и нажми «Пик»': 'No swear words found in the transcript. If there are some — select a piece on the track (double-click a word) and press “Bleep”',
    'Начало': 'Start', 'Конец': 'End',
    'Текст субтитров — исправь слово прямо здесь; стёртое слово не показывается': 'Subtitle text — fix words right here; an erased word is hidden',
    'Вернуть как было': 'Reset', 'В этом отрезке речи не найдено.': 'No speech in this range.',
    'Окна вебки и игры: середина — перенос, углы — размер, стороны — обрезка · колесо — масштаб · двойной щелчок — вернуть как было':
      'Webcam and game windows: middle — move, corners — size, sides — crop · wheel — scale · double-click — reset',
    // панель: пресет и раскладка
    'Пресет': 'Preset', 'Применить пресет к этому клипу': 'Apply the preset to this clip', 'Применить': 'Apply', '💾 Сохранить пресет': '💾 Save preset',
    'Применить выбранный пресет ко всем клипам стрима': 'Apply the selected preset to all clips of the stream', 'На все клипы': 'To all clips',
    'Удалить выбранный пресет': 'Delete the selected preset', '— пресетов пока нет —': '— no presets yet —',
    'Правки этого шортса остаются только в нём. «Сохранить пресет» — текущая разметка (окна, текст, логотипы, экспорт) станет основной для новых клипов.':
      'Edits to this short stay in it only. “Save preset” makes the current setup (windows, text, logos, export) the default for new clips.',
    'Название пресета (тот же — перезапишет):': 'Preset name (same name overwrites):', 'Мой пресет': 'My preset',
    'Пресет применён ко всем клипам': 'Preset applied to all clips',
    'Раскладка': 'Layout', 'Вебка и игра стопкой, остальное — размытый фон': 'Webcam and game stacked, blurred background',
    'Вебка + игра': 'Cam + game', 'Игра на весь экран, вебка плашкой поверх': 'Game fullscreen, webcam on top', 'Вебка поверх': 'Cam overlay',
    'Кадр целиком по ширине': 'Whole frame by width', 'Фон': 'Blur bg', 'Вырез 9:16 на весь экран': '9:16 crop, fullscreen', 'Заполнить': 'Fill',
    'Готовые пресеты': 'Quick presets', 'Вебка сверху целиком, под ней игровое поле 4:3 без обрезки': 'Webcam on top, 4:3 playfield below, uncropped',
    'Вебка сверху, игра 16:9 заполняет остальное': 'Webcam on top, 16:9 game fills the rest', 'Игра крупно': 'Big game',
    'Вебка': 'Webcam', 'Искать вебку в каждом клипе': 'Detect the webcam in every clip', 'Авто': 'Auto', 'Своя рамка': 'Custom box',
    'Вручную': 'Manual', 'Без вебки': 'No webcam', 'Найти заново': 'Detect again', 'Вебка сверху': 'Cam on top', 'Вебка снизу': 'Cam at bottom',
    'Высота вебки': 'Webcam height', '(0 — по пропорциям)': '(0 — by aspect)', 'Размер вебки': 'Webcam size', 'Приближение вебки': 'Webcam zoom',
    'Вебка скрыта': 'Webcam hidden', 'Своя рамка — тяни её на кадре': 'Custom box — drag it on the frame', 'Нарисуй рамку вебки на исходном кадре': 'Draw the webcam box on the source frame',
    'Ищу вебку…': 'Looking for the webcam…', 'Найдена автоматически': 'Detected automatically', 'В этом клипе вебки нет — будет только игра': 'No webcam in this clip — game only',
    'Игра': 'Game', 'Весь кадр': 'Full frame', 'Центральная часть 4:3 — игровое поле osu!': 'Central 4:3 part — the osu! playfield', 'Центр 4:3': 'Center 4:3',
    'Потяни голубую рамку на исходном кадре': 'Drag the blue box on the source frame', 'Своя': 'Custom', 'Заполнение': 'Fill amount', '(0 — целиком)': '(0 — whole)',
    'Приближение': 'Zoom', 'Сдвиг по горизонтали': 'Horizontal offset', 'Сдвиг по вертикали': 'Vertical offset',
    // слои
    'Слои': 'Layers', '+ Текст': '+ Text', '+ Картинка / лого': '+ Image / logo', 'Любая часть исходного кадра отдельным окном': 'Any part of the source frame as its own window',
    '+ Кусок кадра': '+ Frame piece', 'Название': 'Name', 'Текст слоя (Enter — новая строка)': 'Layer text (Enter — new line)', 'Шрифт': 'Font', 'Размер': 'Size',
    'Оформление': 'Style', 'плашка': 'box', 'обводка': 'outline', 'без': 'none', 'Текст': 'Text', 'Плашка / обводка': 'Box / outline',
    'Толщина обводки': 'Outline width', 'Плотность плашки': 'Box opacity', 'Жирный': 'Bold', 'Заменить картинку': 'Replace image',
    'Что показывать — розовая рамка на исходном кадре слева; куда — окно на превью.': 'What to show — the pink box on the source frame on the left; where — the window in the preview.',
    'Непрозрачность': 'Opacity', 'Плавно появляться, с': 'Fade in/out, s', 'Показывать': 'Show', 'с какой секунды клипа': 'from which second of the clip',
    'конец': 'end', 'до какой секунды клипа': 'until which second of the clip', 'Начать слой с текущего места плеера': 'Start the layer at the playhead',
    'С этого места': 'From here', 'До конца клипа': 'Until the end', 'Поверх других слоёв': 'Above other layers', '▲ Выше': '▲ Up', '▼ Ниже': '▼ Down', 'Копия': 'Duplicate',
    'Скрыть / показать': 'Hide / show', 'Кусок кадра': 'Frame piece', 'кусок кадра': 'frame piece', 'слой': 'layer', 'ТЕКСТ': 'TEXT',
    'Добавь текст, логотип или кусок кадра — у каждого слоя своё время показа на дорожке «Слои».': 'Add text, a logo or a frame piece — every layer has its own time on the “Layers” track.',
    'Розовая рамка на исходном кадре — что вырезать, окно на шортсе — куда поставить': 'Pink box on the source frame — what to cut, window on the short — where to put it',
    'Не удалось загрузить картинку': 'Could not upload the image', 'Картинка добавлена: тяни её в превью, углы — размер': 'Image added: drag it in the preview, corners — size',
    // чат
    'Чат стрима': 'Stream chat', 'Показывать чат на шортсе': 'Show chat on the short', 'Скачать чат со стрима ещё раз (YouTube / Twitch)': 'Download the stream chat again (YouTube / Twitch)',
    'Подтянуть чат': 'Fetch chat', 'Качаю чат…': 'Downloading chat…', 'Размер текста': 'Text size', 'Подложка': 'Background', 'Показывать раньше': 'Show earlier',
    'Чат реагирует с задержкой — можно показать сообщения чуть раньше': 'Chat reacts with a delay — show messages a bit earlier',
    'Щёлкни по сообщению, чтобы скрыть его с шортса:': 'Click a message to hide it from the short:', 'Щёлкни — скрыть или вернуть сообщение': 'Click — hide or restore the message',
    'В этом месте стрима чата нет': 'No chat at this point of the stream', 'Нет сообщений в этом отрезке': 'No messages in this range',
    'У этого стрима на площадке нет сохранённого чата': 'The platform has no saved chat for this stream',
    // субтитры, заголовок, формат
    'Субтитры': 'Subtitles', 'Показывать субтитры по словам': 'Word-by-word subtitles', 'Высота на экране': 'Height on screen', 'Слов в строке': 'Words per line',
    'Обводка': 'Outline', 'Цвет текста': 'Text color', 'Активное слово': 'Active word', 'ЗАГЛАВНЫМИ': 'UPPERCASE',
    'Заголовок': 'Title', 'Показывать заголовок на видео': 'Show the title on the video', 'Плашка': 'Box',
    'Формат и рендер': 'Format & render', 'Размер кадра': 'Frame size', 'Свой размер': 'Custom size', 'Ширина × высота': 'Width × height',
    'Кадров в секунду': 'Frames per second', 'Как в стриме': 'As the stream', 'Экспорт': 'Export', 'Контейнер': 'Container', 'Кодек': 'Codec',
    'H.264 — играет везде': 'H.264 — plays everywhere', 'H.265 — меньше файл': 'H.265 — smaller file', 'AV1 — сильнее всего жмёт': 'AV1 — best compression', 'ProRes — для монтажа': 'ProRes — for editing',
    'Кодировать на': 'Encode on', 'видеокарте, если умеет': 'GPU if possible', 'видеокарте': 'GPU', 'процессоре': 'CPU', 'видеокарта': 'GPU', 'процессор': 'CPU',
    'Битрейт подбирается сам под картинку': 'Bitrate adapts to the picture', 'Постоянное качество': 'Constant quality', 'Задать битрейт вручную': 'Set the bitrate manually', 'Свой битрейт': 'Custom bitrate',
    'Качество': 'Quality', '(левее — лучше)': '(left — better)', 'Битрейт видео, Мбит/с': 'Video bitrate, Mbit/s', 'Скорость': 'Speed', 'быстро': 'fast', 'баланс': 'balanced', 'качественнее': 'better',
    'Звук': 'Audio', '128 кбит/с': '128 kbit/s', '192 кбит/с': '192 kbit/s', '256 кбит/с': '256 kbit/s', '320 кбит/с': '320 kbit/s',
    'Фон и расположение': 'Background & position', 'Затемнение фона': 'Background dim', 'Блоки сдвинуты вручную': 'Blocks moved manually', 'Вернуть на место': 'Reset positions',
    'Настройки сохраняются сами и запоминаются: следующий клип и новые стримы откроются с ними же.': 'Settings save automatically.',
    'VP9 кодируется только процессором — медленнее': 'VP9 is CPU-only — slower', 'AV1 на видеокарте — только RTX 40/50, иначе процессор (медленно)': 'AV1 on GPU needs RTX 40/50, otherwise CPU (slow)',
    'H.265 не везде играет в браузере, но YouTube и TikTok его принимают': 'H.265 does not play in every browser, but YouTube and TikTok accept it',
    'В окне просмотра может не проиграться — открой файл из папки': 'May not play in the viewer — open the file from the folder',
    // диалоги
    'Перекачать видео стрима': 'Re-download stream video', 'авто': 'auto', 'только H.264': 'H.264 only', 'любой (VP9/AV1)': 'any (VP9/AV1)',
    'Скачается только видео. Расшифровка, найденные моменты и твои клипы останутся. Если такого качества у стрима нет, скачается ближайшее ниже.':
      'Only the video is downloaded. The transcript, found moments and your clips stay. If the stream has no such quality, the nearest lower one is used.',
    'Отмена': 'Cancel', 'Перекачать': 'Re-download', 'Качество': 'Quality',
    'Нейросеть (любой OpenAI-совместимый сервер)': 'AI model (any OpenAI-compatible server)', 'Использовать LLM для выбора моментов и заголовков': 'Use an LLM to pick moments and titles',
    'Адрес сервера': 'Server URL', 'API-ключ (если нужен)': 'API key (if needed)', 'пусто для локальной модели': 'empty for a local model', 'Модель': 'Model',
    'пусто — первая модель с сервера': 'empty — first model from the server', 'Проверить связь': 'Test connection', 'Проверяю…': 'Checking…',
    'Распознавание речи': 'Speech recognition', 'Модель Whisper': 'Whisper model', 'Язык (пусто — авто)': 'Language (empty — auto)',
    'Моменты': 'Moments', 'Сколько клипов (0 — авто)': 'How many clips (0 — auto)', 'Мин. длина, с': 'Min length, s', 'Макс. длина, с': 'Max length, s',
    'Скачивание стримов': 'Stream download', 'Прокси (если YouTube не грузит)': 'Proxy (if YouTube won\'t load)',
    'socks5://127.0.0.1:1080 или http://адрес:порт': 'socks5://127.0.0.1:1080 or http://host:port',
    '⟳ Продолжить скачивание': '⟳ Resume download', '⟳ Продолжить обработку': '⟳ Resume processing', 'прервано': 'interrupted',
    'Докачать стрим с места обрыва и продолжить обработку': 'Continue the download from where it stopped and finish processing', 'Разрешение': 'Resolution', 'до 720p': 'up to 720p', 'до 1080p': 'up to 1080p', 'до 1440p': 'up to 1440p', 'до 4K': 'up to 4K',
    'лучшее': 'best', '60, если есть': '60 if available', '30': '30',
    '«Авто»: до 1080p берётся H.264 (быстрее режется), выше — VP9/AV1, потому что YouTube отдаёт 1440p и 4K только в них.': '“Auto”: up to 1080p uses H.264 (faster to cut), above that VP9/AV1, since YouTube serves 1440p and 4K only in those.',
    'Рендер': 'Render', 'Выравнивать громкость': 'Normalize loudness', 'Сохранить': 'Save', 'Закрыть': 'Close', 'Настройки сохранены': 'Settings saved',
    'Часть готовых шортсов изменена после рендера. Перерендерить и их тоже?': 'Some finished shorts changed after rendering. Re-render them too?',
    'Все клипы уже отрендерены': 'All clips are already rendered',
    'Найти моменты заново? Неотрендеренные авто-клипы будут заменены, ручные и готовые останутся.': 'Find moments again? Unrendered auto clips will be replaced; manual and finished ones stay.',
    // сервер: этапы, ошибки, предупреждения
    'Проект не найден': 'Project not found', 'Укажи ссылку на стрим или путь к файлу': 'Enter a stream link or a file path', 'Проект сейчас обрабатывается': 'The project is being processed',
    'Это локальный файл — перекачивать нечего': 'This is a local file — nothing to re-download', 'Проект сейчас обрабатывается — дождись окончания': 'The project is being processed — wait until it finishes',
    'Анализ уже идёт': 'Analysis is already running', 'Видео ещё не скачано': 'Video is not downloaded yet', 'Кадр не найден': 'Frame not found',
    'Нужна картинка: PNG, JPG, WEBP или GIF': 'An image is needed: PNG, JPG, WEBP or GIF', 'Файл пустой или больше 30 МБ': 'The file is empty or larger than 30 MB',
    'Картинка не найдена': 'Image not found', 'Это локальный файл — чата у него нет': 'This is a local file — it has no chat', 'Неверный диапазон клипа': 'Invalid clip range',
    'Клип короче секунды': 'The clip is shorter than a second', 'Клип не найден': 'Clip not found', 'Клип ещё не отрендерен': 'The clip is not rendered yet', 'Файл клипа не найден': 'Clip file not found',
    'Стрим ещё не начался': 'The stream has not started yet', 'Перекачиваю видео': 'Re-downloading video', 'Скачиваю стрим': 'Downloading the stream', 'Извлекаю звук': 'Extracting audio',
    'Распознаю речь': 'Transcribing speech', 'Считаю громкость и активность чата': 'Measuring loudness and chat activity', 'Ищу лучшие моменты (LLM)': 'Finding the best moments (LLM)',
    'Клип удалён': 'Clip deleted', 'В очереди': 'Queued', 'Готово': 'Done', 'Исходное видео не найдено': 'Source video not found', 'Клип слишком короткий': 'The clip is too short',
    'LLM недоступна — моменты выбраны только по громкости, чату и речи.': 'LLM unavailable — moments picked by loudness, chat and speech only.',
    'Скачивание не удалось: файл не появился': 'Download failed: no file appeared', 'Старое видео занято (открыт плеер?) — закрой просмотр и попробуй ещё раз': 'The old video is in use (player open?) — close the viewer and try again',
    'В файле нет видеодорожки': 'The file has no video track', 'Сервер не вернул ни одной модели': 'The server returned no models', 'В ответе модели нет JSON': 'No JSON in the model answer',
  };

  /* ------------------------------------------------------------ шаблоны с числами */
  const P = [
    [/^клипов: (\d+)$/, 'clips: $1'], [/^слов: (\d+)$/, 'words: $1'], [/^сообщений чата: (\d+)$/, 'chat messages: $1'],
    [/^([\d.]+) с$/, '$1 s'], [/^([\d.]+) с\)$/, '$1 s)'], [/^готово (\d+)$/, '$1 done'], [/^(\d+) · готово (\d+)$/, '$1 · $2 done'],
    [/^([^·]+) \(([\d.]+) с\)$/, (m, a, b) => `${a} (${b} s)`], [/^громкость (\d+%)$/, 'volume $1'],
    [/^([\d.]+)–([\d.]+|конец) с$/, (m, a, b) => `${a}–${b === 'конец' ? 'end' : b} s`],
    [/^Видео перекачано: (.+), (\d+) fps$/, 'Video re-downloaded: $1, $2 fps'],
    [/^Скачивание остановилось\.[^\n]*\n?([\s\S]*)$/, 'Download stopped. What was downloaded is kept — “⟳ Resume download” continues from the same spot. If YouTube blocks you, turn on a VPN or set a proxy in settings.\n$1'], [/^Ошибка: ([\s\S]*)$/, (m, a) => `Error: ${tr(a)}`], [/^Ошибка рендера: ([\s\S]*)$/, (m, a) => `Render error: ${tr(a)}`],
    [/^Рендер… (\d+)%$/, 'Rendering… $1%'], [/^Вырезаю без оформления… (\d+)%$/, 'Cutting raw… $1%'],
    [/^Рендер: (.+)$/, 'Render: $1'], [/^Вырезаю: (.+)$/, 'Cutting: $1'], [/^([\d.]+) Мбит\/с$/, '$1 Mbit/s'],
    [/^([^—]+) — (\d+)%$/, (m, a, b) => `${tr(a.trim())} — ${b}%`],
    [/^Запикано слов: (\d+) — проверь на дорожке, лишнее убери$/, 'Bleeped words: $1 — check the track and remove extras'],
    [/^Сообщений рядом с клипом: (\d+)$/, 'Messages near the clip: $1'], [/^скрыто: (\d+)$/, 'hidden: $1'], [/^Чат скачан: (\d+) сообщений$/, 'Chat downloaded: $1 messages'],
    [/^Пресет «(.+)» сохранён — новые клипы будут с ним\. Чтобы применить к уже найденным — «На все клипы»$/, 'Preset “$1” saved — new clips will use it. To apply it to existing clips — “To all clips”'],
    [/^Пресет «(.+)» применён к этому клипу$/, 'Preset “$1” applied to this clip'],
    [/^Применить пресет «(.+)» ко всем (\d+) клипам стрима\?\n[\s\S]*$/, 'Apply preset “$1” to all $2 clips of the stream?\nTheir own settings (windows, layers, export) will be replaced. Subtitle text, audio and clip length stay.'],
    [/^Удалить пресет «(.+)»\?$/, 'Delete preset “$1”?'], [/^Удалить «([\s\S]+)» вместе со скачанным видео и всеми клипами\?$/, 'Delete “$1” together with the downloaded video and all clips?'],
    [/^В очереди на рендер: (\d+)$/, 'Queued for render: $1'],
    [/^Новые стримы будут качаться в (.+), (\d+) fps$/, (m, a, b) => `New streams will download in ${a === 'лучшем качестве' ? 'best quality' : a}, ${b} fps`],
    [/^Сейчас: (.+), (\d+) fps\.$/, 'Now: $1, $2 fps.'], [/^лучшее (\d+)fps$/, 'best $1fps'],
    [/^ProRes HQ — для монтажа, файл огромный \(≈(\d+) МБ на этот клип\)$/, 'ProRes HQ — for editing, huge file (≈$1 MB for this clip)'],
    [/^Файл ≈ ([\d.]+) МБ\. Для шортсов обычно хватает 8–16 Мбит\/с в 1080p, 30–45 в 4K$/, 'File ≈ $1 MB. For shorts 8–16 Mbit/s in 1080p and 30–45 in 4K is usually enough'],
    [/^Стрим скачан в (\d+) fps — (\d+) fps даст только повтор кадров\. .*$/, 'The stream is downloaded at $1 fps — $2 fps only repeats frames. For real 60 fps re-download the stream (⬇ Video quality) if it has 60'],
    [/^LLM: фрагмент (\d+)\/(\d+) пропущен — ([\s\S]*)$/, 'LLM: chunk $1/$2 skipped — $3'], [/^LLM: не удалось оценить часть моментов — ([\s\S]*)$/, 'LLM: could not rate some moments — $1'],
    [/^LLM недоступна: ([\s\S]*)$/, 'LLM unavailable: $1'], [/^LLM вернула (\d+): ([\s\S]*)$/, 'LLM returned $1: $2'],
    [/^Файл не найден: ([\s\S]*)$/, 'File not found: $1'], [/^Картинка слоя не найдена: (.+) — загрузи её заново$/, 'Layer image not found: $1 — upload it again'],
    [/^ffmpeg не умеет кодировать (.+) — выбери другой кодек$/, 'ffmpeg cannot encode $1 — pick another codec'],
    [/^Не удалось распознать речь: ([\s\S]*)$/, 'Speech recognition failed: $1'], [/^Не удалось скачать ffmpeg: ([\s\S]*)$/, 'Could not download ffmpeg: $1'],
    [/^(.+) завершился с ошибкой:\n([\s\S]*)$/, '$1 failed:\n$2'], [/^(.+) копия$/, '$1 copy'],
  ];

  const CYR = /[А-Яа-яЁё]/;
  function tr(s) {
    if (s == null) return s;
    const str = String(s), k = str.trim();
    if (!k || !CYR.test(k)) return s;
    let v = D[k];
    if (v == null) for (const [re, rep] of P) { if (re.test(k)) { v = k.replace(re, rep); break; } }
    if (v == null && k.includes(' · ')) { const parts = k.split(' · '), out = parts.map(tr); if (out.some((x, i) => x !== parts[i])) v = out.join(' · '); }
    return v == null ? s : str.replace(k, v);
  }
  window.T = tr;

  /* ------------------------------------------------------------ DOM: тексты и подсказки */
  const SKIP = '.proj > b, .reason, #pTitle, #subEdit, #chatList, .cmsg, script, style, textarea';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function trText(n) { const p = n.parentElement; if (!p || p.closest(SKIP)) return; const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  function trAttrs(el) { if (el.closest(SKIP) && !el.matches('#chatList .cmsg')) return; for (const a of ATTRS) { const o = el.getAttribute(a); if (o && CYR.test(o)) { const v = tr(o); if (v !== o) el.setAttribute(a, v); } } }
  function trTree(root) {
    if (root.nodeType === 3) return trText(root);
    if (root.nodeType !== 1) return;
    trAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? trText(n) : trAttrs(n);
  }
  const obs = new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'characterData') trText(m.target);
      else if (m.type === 'attributes') trAttrs(m.target);
      else m.addedNodes.forEach(trTree);
    }
  });
  const start = () => { trTree(document.body); document.title = tr(document.title); obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  /* ------------------------------------------------------------ canvas и диалоги браузера */
  const CANVAS = new Set(['Загрузка видео…', 'здесь будут субтитры', 'Загружаю звук…', 'ПИК', 'ВЫРЕЗАН', 'игра', 'вебка', 'вебка (авто)', 'кусок кадра', 'Кусок кадра',
    'чат: сообщений пока нет', 'чат (у стрима нет сообщений)', 'Слоёв нет — добавь текст, картинку или кусок кадра в панели «Слои» справа']);
  Object.assign(D, { 'Загрузка видео…': 'Loading video…', 'здесь будут субтитры': 'subtitles go here', 'Загружаю звук…': 'Loading audio…', 'ПИК': 'BLEEP', 'ВЫРЕЗАН': 'CUT',
    'игра': 'game', 'вебка': 'webcam', 'вебка (авто)': 'webcam (auto)', 'чат: сообщений пока нет': 'chat: no messages yet', 'чат (у стрима нет сообщений)': 'chat (the stream has no messages)',
    'Слоёв нет — добавь текст, картинку или кусок кадра в панели «Слои» справа': 'No layers — add text, an image or a frame piece in the “Layers” panel on the right' });
  const C2D = CanvasRenderingContext2D.prototype;
  for (const fn of ['fillText', 'strokeText', 'measureText']) {
    const orig = C2D[fn];
    C2D[fn] = function (text, ...rest) {
      const k = String(text).trim();
      if (CANVAS.has(k)) text = String(text).replace(k, D[k]);
      else if (/^(?:▣|🖼|T) Кусок кадра$/.test(k)) text = String(text).replace('Кусок кадра', 'Frame piece');
      return orig.call(this, text, ...rest);
    };
  }
  for (const fn of ['confirm', 'prompt', 'alert']) { const orig = window[fn]; window[fn] = (msg, ...rest) => orig.call(window, tr(msg), ...rest.map(x => typeof x === 'string' ? tr(x) : x)); }
})();
