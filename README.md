# Wave Link 3 Universal — FIFINE AmpliGame D6

**English** · [العربية](#arabic)

Developed by [ShkourBashtawi](https://github.com/ShkourBashtawi)

Control **Elgato Wave Link 3** from the keys of the **FIFINE AmpliGame D6** using FIFINE Control Deck.

> Unofficial community project. Not affiliated with FIFINE or Elgato. Product names are trademarks of their owners.

---

## Actions

| Action | What it does |
|---|---|
| **Mute / Unmute** | Toggles mute on the selected target |
| **Volume +** | Raises the target by 10% per press. Hold to keep raising |
| **Volume −** | Lowers the target by 10% per press. Hold to keep lowering |
| **Input** | Mute/unmute key with a "live / muted" state (default target: channel) |
| **Output** | Same, default target: channel in a mix |
| **AUX / Mix** | Same, default target: channel in a mix |

Each key has its own target:

- **Input / channel (source)** — e.g. Mic, Voice Chat, Music
- **Channel in a mix** — e.g. Voice Chat inside the *Personal* mix only
- **Mix / mix output** — the whole mix (e.g. *Stream*)
- **Physical output** — an output device (e.g. your headset)

## Highlights

**Responsiveness**
- Key presses are sent to Wave Link immediately and never wait for the previous reply.
- Rapid presses on the same target are merged (latest value wins), so holding Volume ± never builds a backlog.
- TCP no-delay on the local connections, so small messages aren't held back by the OS.
- Holding Volume ± stops by itself at 0% / 100% (and after 10 s as a safety net).

**Less load on Control Deck**
- Key images and states are only sent when they actually change.
- Background sync no longer overwrites a value you just changed.
- Only one sync runs at a time; physical devices are refreshed less often unless a key uses them.
- The target list is stored as names only, and only rewritten when the list itself changes.

**Stability**
- Reconnects to Wave Link automatically with back-off, including when Wave Link was closed at startup or restarts on a new port.
- The plugin process exits when Control Deck closes it, so no orphan `node.exe` is left running.
- WebSocket client handles fragmented messages and protocol errors without crashing; global error guards.

**Settings panel**
- The target shown in the panel is saved automatically, so a key is never left without a target.
- New **Keep my image** option (on by default): the plugin never replaces the image you set on the key. Untick it to get the plugin's images with the volume %.
- Shows *"Wave Link is not connected"* instead of waiting forever.

**Diagnostics**
- Writes a small log file (capped at 256 KB): `wavelink3.log` inside the plugin folder.

## Requirements

- Windows 10 or newer
- FIFINE AmpliGame D6 + FIFINE Control Deck
- Elgato Wave Link 3, installed and running

## Installation

1. Download the latest `.zip` from **Releases** and extract it.
2. Close anything you are editing in Control Deck (the installer restarts it).
3. Run `Instalar-WaveLink3.bat`.
4. In Control Deck, open the **Wave Link 3 Universal** category and drag the actions onto your keys.

Updating: run the new `Instalar-WaveLink3.bat` over the old version. No need to uninstall; your keys keep their settings.

## Setup

1. Click a key and open its settings.
2. Pick **Target type**, **Target** and, for *Channel in a mix*, the **Mix**.
3. Wait a second: the choice is saved automatically. You can check the version (v1.0.5) at the bottom of the panel.

Example: to lower Discord only in your headset, use *Channel in a mix* → *Voice Chat* → *Personal*.

## Troubleshooting

| Problem | What to do |
|---|---|
| Target list is empty / "Waiting for Wave Link catalog…" | Make sure Wave Link 3 is open, close the settings panel and open it again |
| "Wave Link is not connected" | Open Wave Link 3; the plugin reconnects by itself |
| Key does nothing | Open the key's settings once so the target gets saved |
| Something else | Check the log (below) and open an issue with the last lines |

Log file:

```
%APPDATA%\HotSpot\StreamDock\plugins\com.costner.wavelink3.sdPlugin\wavelink3.log
```

## How it works

Wave Link 3 exposes a local WebSocket (JSON-RPC) endpoint. Its port is read from
`%LOCALAPPDATA%\Packages\Elgato.WaveLink_g54w8ztgkx496\LocalState\ws-info.json`.
The plugin reads channels/mixes with `getChannels` / `getMixes` and writes with `setChannel`, `setMix` and `setOutputDevice`. Levels use a 0.0–1.0 scale. All traffic stays on `127.0.0.1`.

This is not an official public API, so a Wave Link update may break the plugin.

## Files

```
WaveLink3.sdPlugin/
  manifest.json              plugin definition (actions, version)
  plugin/index.js            plugin logic
  plugin/ws.js               minimal WebSocket client
  plugin/launch.exe          launcher (starts Control Deck's node with index.js)
  property-inspector.html    settings panel
  imgs/                      icons
Instalar-WaveLink3.bat       installer launcher
Instalar-WaveLink3.ps1       installer (copies the plugin into Control Deck and restarts it)
```

`launch.exe` SHA-256: `58ee7044119cbccdac5873b88f705b26f96439a391d8895a3484b42a5e9c61e7`

## Known limitations

- **Physical input** targets are listed but cannot be muted or adjusted yet.
- Windows only.

---

<a id="arabic"></a>

<div dir="rtl">

# Wave Link 3 Universal — FIFINE AmpliGame D6 (العربية)

تحكّم ببرنامج **Elgato Wave Link 3** من أزرار جهاز **FIFINE AmpliGame D6** عن طريق برنامج FIFINE Control Deck.

تطوير: [ShkourBashtawi](https://github.com/ShkourBashtawi)

> مشروع غير رسمي، وما إله علاقة بـ FIFINE أو Elgato. أسماء المنتجات علامات تجارية لأصحابها.

---

## الأزرار

| الزر | الوظيفة |
|---|---|
| **Mute / Unmute** | كتم وفك كتم الهدف المختار |
| **Volume +** | يرفع الصوت 10% مع كل ضغطة، وإذا ضليت ضاغط بيضل يرفع |
| **Volume −** | ينزّل الصوت 10% مع كل ضغطة، وإذا ضليت ضاغط بيضل ينزّل |
| **Input** | زر كتم بحالتين (شغّال / مكتوم)، هدفه الافتراضي قناة |
| **Output** | نفسه، هدفه الافتراضي قناة داخل ميكس |
| **AUX / Mix** | نفسه، هدفه الافتراضي قناة داخل ميكس |

كل زر إله هدفه الخاص:

- **قناة (Input / channel)**: مثل Mic أو Voice Chat أو Music
- **قناة داخل ميكس (Channel in a mix)**: مثلاً Voice Chat داخل ميكس *Personal* بس
- **ميكس كامل (Mix)**: مثلاً ميكس *Stream* كله
- **جهاز إخراج (Physical output)**: مثلاً السماعة

## المميزات

**سرعة الاستجابة**
- كل ضغطة بتنبعث لـ Wave Link فوراً، وما بتستنى رد الضغطة اللي قبلها.
- الضغطات المتلاحقة على نفس الهدف بتندمج وبتنبعث آخر قيمة بس، فلما تضل ضاغط على Volume ± ما بيتكدّس طابور أوامر.
- الاتصالات المحلية بدون تأخير الشبكة الداخلي بالويندوز.
- لما تضل ضاغط على Volume ± بيوقف لحاله عند 0% أو 100%، أو بعد 10 ثواني كحماية.

**ضغط أقل على Control Deck**
- صور الأزرار وحالاتها بتنبعث بس لما تتغير فعلاً.
- التحديث بالخلفية ما بيمسح التغيير اللي عملته للتو.
- تحديث واحد بس بنفس الوقت، وأجهزة الصوت بتتحدّث أقل إلا إذا في زر بيستخدمها.
- قائمة الأهداف بتنحفظ أسماء بس، وما بتنكتب من جديد إلا إذا تغيّرت القائمة نفسها.

**الاستقرار**
- بيعيد الاتصال بـ Wave Link لحاله، حتى لو كان مسكّر وقت التشغيل أو انعاد تشغيله على بورت جديد.
- لما يتسكّر Control Deck، البلجن بيسكّر معه، وما بيضل `node.exe` شغّال بالخلفية.
- أي خطأ برسالة واحدة ما بيوقّف البلجن.

**صفحة الإعدادات**
- الهدف المعروض بالصفحة بينحفظ تلقائياً، فما بيضل زر بدون هدف.
- خيار **Keep my image** (مفعّل افتراضياً): البلجن ما بيغيّر الصورة اللي حاططها على الزر. شيل الصح عنه إذا بدك صور البلجن مع نسبة الصوت.
- رسالة واضحة *"Wave Link is not connected"* إذا Wave Link مش متصل.

**التشخيص**
- ملف سجل صغير (حده الأقصى 256KB) اسمه `wavelink3.log` جوا مجلد البلجن.

## المتطلبات

- ويندوز 10 أو أحدث
- جهاز FIFINE AmpliGame D6 مع برنامج FIFINE Control Deck
- Elgato Wave Link 3 مثبّت وشغّال

## التثبيت

1. نزّل آخر ملف `.zip` من **Releases** وفك ضغطه.
2. سكّر أي شي مفتوح بـ Control Deck، لأن المثبّت بيعيد تشغيله.
3. شغّل `Instalar-WaveLink3.bat`.
4. افتح فئة **Wave Link 3 Universal** بـ Control Deck واسحب الأزرار عليها.

**للتحديث:** شغّل ملف الـ bat الجديد فوق النسخة القديمة، بدون ما تلغي التثبيت. إعدادات أزرارك بتضل زي ما هي.

## الإعداد

1. اضغط على الزر وافتح إعداداته.
2. اختار **Target type** و**Target**، وإذا اخترت *Channel in a mix* اختار **Mix** كمان.
3. استنى ثانية حتى ينحفظ الاختيار لحاله. رقم النسخة (v1.0.5) مكتوب تحت الصفحة.

**مثال:** لتنزيل صوت الدسكورد بالسماعة بس، اختار *Channel in a mix* ← *Voice Chat* ← *Personal*.

## حل المشاكل

| المشكلة | الحل |
|---|---|
| قائمة الأهداف فاضية أو "Waiting for Wave Link catalog…" | تأكد إن Wave Link 3 مفتوح، وسكّر صفحة الإعدادات وافتحها من جديد |
| "Wave Link is not connected" | افتح Wave Link 3، والبلجن بيتصل لحاله |
| الزر ما بيعمل شي | افتح إعدادات الزر مرة وحدة حتى ينحفظ الهدف |
| مشكلة غير هيك | شوف ملف السجل وافتح Issue وحط فيه آخر السطور |

ملف السجل:

</div>

```
%APPDATA%\HotSpot\StreamDock\plugins\com.costner.wavelink3.sdPlugin\wavelink3.log
```

<div dir="rtl">

## كيف بيشتغل

Wave Link 3 بيفتح واجهة WebSocket محلية (JSON-RPC)، والبلجن بيقرأ رقم البورت من هالملف:

</div>

```
%LOCALAPPDATA%\Packages\Elgato.WaveLink_g54w8ztgkx496\LocalState\ws-info.json
```

<div dir="rtl">

البلجن بيقرأ القنوات والميكسات بـ `getChannels` و`getMixes`، وبيغيّرها بـ `setChannel` و`setMix` و`setOutputDevice`. مستوى الصوت من 0.0 لـ 1.0، وكل الاتصال بيضل على الجهاز نفسه (`127.0.0.1`).

هاي مش واجهة رسمية من Elgato، فممكن تحديث لـ Wave Link يكسر البلجن.

## الملفات

</div>

```
WaveLink3.sdPlugin/
  manifest.json              تعريف البلجن (الأزرار والنسخة)
  plugin/index.js            منطق البلجن
  plugin/ws.js               اتصال WebSocket
  plugin/launch.exe          المشغّل (بيشغّل node تبع Control Deck مع index.js)
  property-inspector.html    صفحة الإعدادات
  imgs/                      الأيقونات
Instalar-WaveLink3.bat       مشغّل التثبيت
Instalar-WaveLink3.ps1       التثبيت (بينسخ البلجن لـ Control Deck وبيعيد تشغيله)
```

<div dir="rtl">

بصمة `launch.exe` (SHA-256):

</div>

```
58ee7044119cbccdac5873b88f705b26f96439a391d8895a3484b42a5e9c61e7
```

<div dir="rtl">

## قيود معروفة

- أهداف **Physical input** بتظهر بالقائمة بس لسا ما بتنكتم ولا بيتغيّر صوتها.
- ويندوز بس.

</div>
