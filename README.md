# ГОСТ 2.304-68 — чертёжный шрифт типа А в DXF

Готовые контуры букв для чертежей, лазера, гравировки и 3D-печати. Советский стандарт
«Шрифты чертёжные», тип А: высота 5 мм, наклонный вариант 75° и прямой.

Внутри кириллица (заглавные и строчные), латиница, цифры и знаки. Всё — полилинии, не шрифт:
файл открывается где угодно, ничего устанавливать в систему не нужно.

## Что в папке

```
dxf\gost-2.304-68-type-a-5mm-sheet.dxf            все знаки, прямой, лист 347 x 119 мм
dxf\gost-2.304-68-type-a-5mm-slant75-sheet.dxf    то же с наклоном 75°, 350 x 119 мм
dxf\gost-2.304-68-cnc-5mm-paths.dxf               только рабочие контуры для гравировки, 356 x 103 мм
dxf\gost-2.304-68-cnc-5mm-slant75-paths.dxf       то же с наклоном 75°
preview\hershey-cyrillic-stroke.png               как выглядят однолинейные буквы
tools\                                            конвертеры и генераторы листов
LICENSE                                           MIT для скриптов
NOTICE.md                                         откуда взята геометрия и что не входит
```

Первый файл — с рамкой листа для 3D-печати и образцов, третий и четвёртый — без лишнего, их
сразу тащат в CAM.

## Как применять

- AutoCAD / nanoCAD / BricsCAD: открыть DXF или вставить как блок, масштаб 1:1, единицы — мм.
- FreeCAD: File → Import, дальше Draft/ShapeString работает с полученными полилиниями.
- LightBurn: File → Import, режим гравировки, буквы однолинейные — нет двойного контура.
- VCarve / Aspire: Import vectors, тип инструмента — V-bit, профиль режется сразу.
- Лазер и 3D-печать: контуры замкнутые, толщина линии не важна, заливка не нужна.

## Как сделано

Скрипты в `tools\` конвертируют исходные формы в DXF:

```
node tools\shx2dxf.js   <font.shx>      SHX (AutoCAD) -> DXF
node tools\ttf2dxf.js   <font.ttf>      TTF -> DXF по контуру глифов
node tools\hershey2dxf.js               Hershey (public domain) -> DXF
node tools\dxf2tsv.js   <file.dxf>      проверка: координаты вершин в TSV
node tools\render-dxf.js <file.dxf>     растр для быстрой проверки глазами
node tools\sheet*.js / cnc-sheet.js     сборка листов: раскладка, рамка, наклон
```

## Точность

Геометрия соответствует типу А в той реализации, что ходит в AutoCAD (`GOST_A.SHX`): высота
5 мм, угол наклона 75°, толщина линии — по стандарту не задаётся, контуры без обводки.
Если нужна строгая сверка с изданием 1968 года по каждому знаку — сверяй по таблицам
стандарта, отличия от издания 1981 года в отдельных знаках возможны.

Стандарт ГОСТ 2.304-68 «Шрифты чертёжные» — государственный стандарт, сами формы букв
нормативны. В папке лежит наша реализация этих форм в виде координат, а не чужие файлы шрифтов.

## Заказ

Любой шрифт в ЧПУ или 3D: присылай TTF, OTF, SHX или Hershey — отдам DXF/SVG с однолинейными
контурами под лазер, V-carve или фрезу, либо выдавленный солид (STL/STEP) под 3D-печать.
Высота, наклон, толщина линии, глубина реза — по твоим размерам. Срок обычно 1-2 дня, контакт
Telegram: @Arsenum.

## Лицензия

Скрипты — MIT. Данные (DXF, PNG) — см. `NOTICE.md`: часть геометрии выведена из свободных
источников, часть построена по стандарту.

## EN

GOST 2.304-68 (Soviet drafting font standard), type A, 5 mm, upright and 75 deg slanted.
Cyrillic, Latin, digits, all as DXF polylines - no font installation needed. Opens in AutoCAD,
FreeCAD, LightBurn, VCarve and any laser/CNC CAM. Sheets: 347 x 119 mm and 356 x 103 mm,
millimetres, scale 1:1. Scripts in `tools\` convert SHX/TTF/Hershey to DXF and build the sheets.
Scripts MIT, geometry per `NOTICE.md`.

## Order (EN)

Any font you have - TTF, OTF, SHX, Hershey - as CAM-ready DXF/SVG for laser, V-carve or mill, or
as an extruded solid (STL/STEP) for 3D printing. Any height, slant, stroke width, cut depth.
Usually 1-2 days. Telegram: @Arsenum