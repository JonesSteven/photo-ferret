# Photo Ferret: application summary and filter reference

Photo Ferret is a nature-photo gallery website. An admin uploads photos, and TypeSafe's **Jev** image model tags each one with a set of judgments: what the photo contains, how much of the frame each landscape covers, who and what is in it, the weather, the light, the mood and the composition. A few more tags are measured from the pixels in code. The public gallery lets visitors filter, sort and browse the photos by those tags. Every original is kept at full resolution and can be downloaded.

This document describes how the app works and gives an exact description of every filter. For each filter it gives the wording of the question sent to Jev, the question type, and how the answer becomes the stored value. The question text below is generated from the code (`server/questions.ts`) as it stood on 2026-10-18 (revised).

---

## 1. The application

### Public gallery (`/`)
- **Layout:** filters sit in a sidebar on the left quarter of the page, and the photo grid fills the rest. Each side scrolls on its own.
  - On desktop, the sidebar collapses to a thin strip with its ‹ tab.
  - On phones (820 px wide or less) it opens as a drawer from the **Filters** button, which shows how many filters are active.
- **Filters:** one filter panel (the Sliders view), ending with an **EXPERIMENTAL - 3D MAP** section (section 3.9). It shows **Sort**, **Primary subject**, **In the photo** (People, Wildlife, Birds), and the chip groups **Activities**, **Weather & sky** and **Palette**.
  - **Sliders:** a two-handle range slider for every coverage category and every mood, colour and look scale.
    - Above each slider is a density strip: each 10-point band is brighter the more matching photos fall in it (brightness ∝ √count), given the *other* active filters; the parts outside the slider's range are dimmed.
    - A narrowed slider's window can be dragged, or moved with the arrow keys (Shift for steps of 10), keeping its width.
- **Counts:** every option shows how many photos it would leave, given the other active filters.
- **Shareable links:** the whole view lives in the URL query string.
- **Lightbox:** clicking a photo opens it at display size, with:
  - the primary subject, the yes/no tags that apply (an unsure People/Wildlife/Birds answer shows with a dashed outline and a “?”), weather and palette
  - **Approximate coverage:** a bar and a word (Trace, Some, About half, Most, Nearly all) for each category judged present
  - the photo's position on each mood, colour and look scale; a small “?” marks a scale where Jev was split between distant levels
  - a **Download original** button
- **Gallery view:** the **Gallery view** button on the photo (or a click on the photo) shows the photos alone on a black screen, in the current filtered order. Step with the ‹ › buttons, the arrow keys or a swipe; the controls fade after a few seconds of no movement. Leaving (× or Esc) returns to the details of the photo you stopped on.
- **Copy link** (photo details): copies `/?photo=<id>`. Opening it shows the full gallery with that photo's details open; the parameter is then removed from the address. A link to an unpublished or deleted photo just opens the gallery.
- **About:** the **About** link at the top right opens a page with the owner's note (the admin's **About text**, plain text; blank lines make paragraphs, email addresses and links become clickable; hidden when empty) and a plain-language explanation of where the Jev AI model is used and what is measured from the pixels.
- **Slideshow:** the **Slideshow** button beside Gallery view, with a seconds-per-photo box (3–60, remembered in the browser; Enter in the box also starts it). It plays every photo in the current filtered list in gallery view, full screen where the browser allows, on black, looping from the last back to the first. Each photo's time starts once it has loaded. **Fade** (on by default, remembered) crossfades from one photo to the next as the slideshow advances, over about a second (at most a third of the photo's time), once the next photo has loaded; stepping by hand switches at once. Pause with the button at the bottom or the space bar; ‹ › still step and restart the time. Esc (leaving full screen) or × ends it and returns to the photo you stopped on.

### Admin (`/admin/`)
- Sign-in uses a single account, `ADMIN_USER` / `ADMIN_PASSWORD` in `.env`. The session is a 7-day signed cookie.
- **Upload** many photos at once. Each is stored, then processed in the background (two at a time). Each upload row ends as “Uploaded and tagged” or “Uploaded, but tagging failed: …”.
- **The edit panel for each photo shows:**
  - the exact image sent to Jev, with boxes for the most prominent person, wild animal and bird (each only when that tag is “yes”)
  - title, description, and a “Visible on the public site” toggle
  - every tag with Jev's answer and an override control. Yes/no tags show Jev's probability of yes, for example “P(yes) 2% · strong No”, and the second-look probability when there was one. Coverage shows P(present). Answers Jev was unsure about are marked **unsure**.
  - **Re-run Jev**, **Download original** and **Delete**
- Overrides always win over Jev and are kept when Jev runs again. Admins can set yes/no tags to Yes or No (not Unsure).
- **Re-tag all photos** runs the current question set on every photo.

### Storage
Everything is stored in `DATA_DIR` (default `./data`):

| Path | Contents |
|---|---|
| `photos.db` | SQLite (`node:sqlite`). `photos` has one row per photo, including the full normalised Jev result (`jev_result`). `photo_attributes` has one row per photo per tag: Jev's value, a confidence, a JSON detail (level probabilities, most likely level, P(present), P(yes)), and an optional admin override. |
| `originals/<id>.<ext>` | The uploaded photo with its sensitive metadata removed on upload (GPS, serial numbers, names and contact details, maker notes, embedded previews, XMP, IPTC); only the colour profile, orientation and date taken are kept. JPEGs keep their exact image data; PNGs are re-saved losslessly; other formats (HEIC, RAW, WebP…) become a quality-95 JPEG. Duplicates (same SHA-256 of the file as uploaded) are rejected. Public name `Image N` / file `Image_N.<ext>` (N in upload order); the uploaded file name is shown only in the admin. |
| `derived/<id>/thumb.webp` | Grid thumbnail, 800 px on the long side. |
| `derived/<id>/display.webp` | Lightbox image, 2048 px on the long side. |
| `derived/<id>/jev.jpg` | The exact JPEG sent to Jev, also used for the pixel measurements. |

Derived images are upright, sRGB and stripped of metadata. `npm run rebuild-derived` rebuilds them from the originals; `npm run remeasure` recomputes the pixel measurements without calling Jev.

The gallery loads `data.json` (the published photos and their effective tags) once and does all filtering, counting and histograms in the browser. The exported site serves a static `data.json`; in `npm run dev` the local server builds it from the database and caches it until the next database write.

---

## 2. The Jev API calls

**Each photo normally gets one request**, made when it is uploaded, re-run or re-tagged.

| | |
|---|---|
| **Endpoint** | `POST https://api.typesafe.ai/v1/systemone`, via the TypeSafe JavaScript SDK `@typesafe-ai/sdk` 0.7.0 (`client.systemOne(...)`) |
| **Model** | `jev-1.14.0` (`JEV_MODEL` in `.env`). Box questions need Jev 1.14. |
| **Required header** | `TypeSafe-Danger-Zone-Images: true`, which opts in to the image and Box preview features. |
| **Body** | Multipart. The image is attached once as an asset; the JSON part holds `state` and `questions`. |
| **State** | `{ "photo": <the JPEG> }`. Every question refers to the image as `` `photo` ``, so it is uploaded and billed once. |
| **Questions** | **49 in total**, answered in parallel; none can see another's answer. Measured on the album: about 10,000 input and 1,000 output tokens, 0.3–0.6 s per photo. |

| Type | Count | Questions |
|---|---|---|
| Choice | 2 | Primary subject, weather |
| Noul (probability of yes) | 17 | People, wildlife, birds; sunrise/sunset, night sky, rainbow; 6 activities |
| Box (location) | 8 | The most prominent person, wild animal and bird |
| Score, coverage | 12 | Coverage categories |
| Score, scales | 10 | 2 mood, 1 colour, quality, 6 look & composition |

**Speculative questions.** All questions go in the one request, so none can depend on another's answer. Some are therefore asked regardless and kept only when they apply:
- the three Boxes are kept only when the matching yes/no tag is “yes”;
- the activity questions are kept only when People is “yes”;
- sky drama is kept only when sky is judged present;
- weather answered “Can't tell” is stored as no value; see 3.4 for the dropped “Rain, snow or storm” option.

A tag with no value is *unknown*, not zero: it never matches an active filter.

**Second look for small subjects.** When People, Wildlife or Birds comes out unsure, a second request asks only those questions about a 2 × 2 grid of overlapping, sharper tiles cut from the original (four images in one request, `tile_1` … `tile_4`, each question worded as above with `` `tile_n` `` in place of `` `photo` ``). The highest tile probability replaces the first answer and is put through the same thresholds. This costs one extra request, only for those photos.

**Panoramas.** Jev needs every side between 280 and 1568 px, so an image more elongated than 5.6 : 1 can't be sent whole. Such photos are cut into the fewest overlapping tiles (10% overlap) that keep each tile at 3 : 1 or less, usually 2–3, and each tile gets the full question set (one request per tile). The answers are combined:
- coverage: the level probabilities are averaged across tiles; a category is present if it is present in any tile;
- quality: the level probabilities, score and confidence are averaged across tiles, then converted to 1–100;
- yes/no tags: the highest probability of any tile;
- other scales and choices: the centre tile;
- boxes: none, because a box on one tile doesn't describe the panorama.

The admin editor notes “panorama, analysed in n tiles”.

**Preparing the image** (`server/imagePrep.ts`):
- The EXIF rotation is applied to the pixels, because the API strips EXIF.
- Only the first frame is kept, transparency is flattened onto white, and the pixels are converted to sRGB.
- Each side is fitted between 280 and 1568 px; small images are upscaled, never padded.
- The result is a baseline JPEG at quality 90.

**How each answer type becomes a stored value**

| Question type | Jev returns | Stored value |
|---|---|---|
| **Choice** | the chosen option, a probability per option, and a confidence | the option id; confidence = Jev's confidence |
| **Noul** | P(yes) | `true` if P(yes) ≥ 0.7 (≥ 0.9 for the sky tags: Sunrise / sunset, Night sky, Rainbow), `false` if ≤ 0.3, otherwise `uncertain`. Confidence = \|2·P(yes) − 1\| (0 = a coin flip, 1 = certain either way); P(yes) itself is kept in the detail. |
| **Score, coverage** | a probability per level (6), plus confidence | the expected share of the frame, Σ P(level) × share(level), with shares 0, 4, 22, 50, 75, 95 %; **present** = P(any amount) = 1 − P(None) > 0.5. |
| **Score, scale** | the expected score, a probability per level, plus confidence | position 0–100 = expected score ÷ top level × 100 |
| **Box** | `top`, `bottom`, `left`, `right` as fractions of the image, plus confidence | drawn in the admin editor only (see above) |

For every Score the detail also keeps the probabilities and the most likely level. A Score is flagged **unsure** when two levels at least two steps apart each get 30% or more, because the average then lands between two answers Jev actually considered (for example half None, half About half).

---

## 3. Filter reference

**How filters appear in the URL** (all active filters must match):
- Numeric tags: an inclusive range `?<id>=<min>-<max>` from 0 to 100 (for example `?cover_sky=50-100`). Leaving a tag out, or `0-100`, means any.
- Coverage “Contains”: `?cover_<id>=present`.
- Yes/no and choice tags: an exact value (`?wildlife=true`, `?weather=fog`). `uncertain` matches neither `true` nor `false`.
- Palette: one colour family (`?palette=blue`), matching photos that have it among their top two.

### 3.1 Primary subject (Choice)
**Where it appears:** the **Primary subject** menu. URL key `primary_scene`. Shown as “Primary: …” in the lightbox.

**Question id:** `primary_scene`. **Type:** `choice`.

**Instructions:**
> What is the visual focal subject of the nature photo in `photo`: the thing the eye is drawn to, which is not necessarily the largest area?

**Options (criteria), sent exactly as written:**

| Option id | Criterion text |
|---|---|
| `water` | Water: any body of water — sea, ocean, lake, pond, river or stream — with its shoreline or beach, and waterfalls, rapids and cascades |
| `meadow_forest` | Meadows, grasslands and forests: meadows, grassland, prairie, fields, forest, woodland or trees, including snowy and autumn forest, and deserts: sand dunes, desert scrub and arid canyons |
| `mountains` | Mountains: mountains, peaks, ridges, hills, cliffs and rock faces, including snow-covered peaks, glaciers and snowfields |
| `sky` | Sky: the sky itself: clouds, a sunset or sunrise, the sun, the moon, stars or an aurora |
| `plants` | Plants: flowers, ferns, moss, lichen, fungi or other small plants, usually seen up close |
| `wildlife` | Wildlife: wild animals of any kind: mammals, birds, reptiles, amphibians, fish, insects, spiders and sea life |
| `people` | People: one or more people, such as hikers, skiers, climbers or paddlers |
| `structures` | Structures and tents: anything people have built, such as buildings, cabins, huts, bridges, docks, towers, fences or benches, and tents, tarps or other camping shelters |
| `vehicle` | Vehicles: vehicles such as cars, trucks, trains, planes, helicopters, boats, kayaks, canoes and bicycles |
| `other` | Other: something else, such as snow or ice seen up close, an object, a texture or an abstract pattern |

The options are broader groups than the coverage sliders and **In the photo**, and worded on their own, so the primary subject answers a different question (what the eye goes to) instead of repeating those lists. Snow and rock have no option of their own: snowy peaks and rock faces count as Mountains, snowy forest as Meadows, grasslands and forests (which also takes deserts), and snow or ice up close as Other.

### 3.2 In the photo: People, Wildlife, Birds (Noul)
**Where they appear:** the **In the photo** block, with **Any / With / Without**. URL keys `person`, `wildlife`, `birds` = `true` or `false`.

**Stored value:** `true` / `false` / `uncertain` as in section 2, after the second look when there was one. Unsure photos appear only under **Any**.

#### People
**Question id:** `person_present`. **Type:** `noul`. **Stored as / URL key:** `person`.
> **Instructions:** Is there a person visible anywhere in `photo`?
>
> **true:** At least one human is clearly recognisable as a person, even if small or distant: a head, body and limbs can be made out, including silhouettes, people in boats and clearly visible partial bodies
>
> **false:** No human can be clearly recognised; dark specks, trees, rocks, posts or shadows that only might be a person do not count, and neither do animals, statues, buildings, tents or vehicles alone

#### Wildlife
**Question id:** `wildlife_present`. **Type:** `noul`. **Stored as / URL key:** `wildlife`.
> **Instructions:** Is there a wild animal other than a bird or an insect visible anywhere in `photo`?
>
> **true:** At least one wild animal that is not a bird, insect or spider is clearly visible: a mammal, reptile, amphibian, fish, jellyfish, sea star or other sea life
>
> **false:** No such animal is visible; birds, insects, spiders, people, pets and farm animals do not count, and neither do flowers, plants or specks that only might be an animal

#### Birds
**Question id:** `birds_present`. **Type:** `noul`. **Stored as / URL key:** `birds`.
> **Instructions:** Is there a bird visible anywhere in `photo`?
>
> **true:** At least one bird is visible, however small or distant: flying, perched, wading or on the water
>
> **false:** No birds are visible; other animals, insects and people do not count

#### Insects
**Question id:** `insect_subject`. **Type:** `noul`. **Stored as / URL key:** `insect`.
> **Instructions:** Is an insect or spider a main subject of `photo`, large and clearly visible?
>
> **true:** An insect or spider, such as a bee, butterfly, moth, dragonfly, beetle or spider, is a main subject: large in the frame, with its body, legs or wings clearly visible
>
> **false:** No insect or spider is a main subject; small insects on a flower or leaf, distant specks and insects that take up only a tiny part of the frame do not count

#### Vehicles
**Question id:** `vehicle_present`. **Type:** `noul`. **Stored as / URL key:** `vehicle`.
> **Instructions:** Is there a vehicle visible anywhere in `photo`?
>
> **true:** At least one vehicle is clearly visible: a car, truck, bus, train, plane, helicopter, motorcycle, bicycle, motorboat, ferry, ship, kayak or canoe
>
> **false:** No vehicles are visible; paddleboards, skis and sleds do not count, and neither do roads or contrails alone

#### Flowers
**Question id:** `flower_subject`. **Type:** `noul`. **Stored as / URL key:** `flower`.
> **Instructions:** Is a flower, or a small group of flowers, the main subject of `photo`?
>
> **true:** One or a few flowers are the clear focus of the photo, usually seen up close and filling much of the frame
>
> **false:** No flower is the main subject; small flowers in the background, scattered wildflowers or a whole meadow of flowers do not count

#### Tents
**Question id:** `tent_present`. **Type:** `noul`. **Stored as / URL key:** `tent`.
> **Instructions:** Is there a tent visible anywhere in `photo`?
>
> **true:** At least one tent, tarp shelter or bivy is clearly visible, even if small or distant
>
> **false:** No tents are visible; cabins, huts, umbrellas, sleeping bags, packs and gear piles do not count, and neither do rocks or bright patches that only might be a tent

#### Structures
**Question id:** `structure_present`. **Type:** `noul`. **Stored as / URL key:** `structure`.
> **Instructions:** Is there a built structure visible anywhere in `photo`?
>
> **true:** At least one thing people have built is clearly visible: a building, house, cabin, hut, lookout, skyscraper or city skyline, bridge, dock, pier, lighthouse, tower, dam, fence, sign, bench or picnic table
>
> **false:** Nothing built is visible; tents, tarps, boats, kayaks, vehicles, people's gear, roads, trails and paths do not count, and neither do natural features such as rocks, cliffs, logs, trees, smoke or animals

#### Locations (not filters)
- `person_box` (`box`): “the most prominent person in `photo`”
- `wildlife_box` (`box`): “the most prominent wild animal that is not a bird, insect or spider in `photo`”
- `birds_box` (`box`): “the most prominent bird in `photo`”
- `insect_box` (`box`): “the most prominent insect or spider in `photo`”
- `vehicle_box` (`box`): “the most prominent vehicle in `photo`”
- `flower_box` (`box`): “the main flower in `photo`”
- `tent_box` (`box`): “the most prominent tent in `photo`”
- `structure_box` (`box`): “the most prominent built structure in `photo`”

Shown in the admin editor only when the matching tag is `true`.

### 3.3 Activities (Noul)
**Where they appear:** the **Activities** chips; each chip is `?<id>=true`. Stored only when People is `true` (the questions are speculative: “If there is a person…”), so photos without people have no activity values. Thresholds as in section 2.

**Hiking and Skiing exclude each other.** They split on what is on the person's feet (skis, a snowboard or snowshoes count as skiing; on foot, including up snow, as hiking), and each question says the other doesn't count. If both still come out yes, the less likely one is stored as unsure, so a photo never has both. (Before this, 7 photos of people going uphill in snow with poles had both.)

#### Hiking
**Question id:** `flag_act_hiking`. **Type:** `noul`. **Stored as / URL key:** `act_hiking`.
> **Instructions:** If there is a person in `photo`, are they hiking or walking on foot?
>
> **true:** A person in the photo is hiking or walking on foot: on a trail, on a summit, over open ground or up snow on foot (bootpacking), without skis, a snowboard or snowshoes on their feet, usually with a pack or poles
>
> **false:** No person in the photo is hiking or walking on foot, or no person is visible; people on skis, a snowboard or snowshoes count as skiing, not hiking

#### Skiing
**Question id:** `flag_act_skiing`. **Type:** `noul`. **Stored as / URL key:** `act_skiing`.
> **Instructions:** If there is a person in `photo`, are they skiing, snowboarding or snowshoeing?
>
> **true:** A person in the photo is skiing, snowboarding or snowshoeing: travelling over snow on skis, a snowboard or snowshoes, including ski touring uphill, or carrying skis or a board
>
> **false:** No person in the photo is skiing, snowboarding or snowshoeing, or no person is visible; people walking or bootpacking in snow on foot, without skis, a board or snowshoes, count as hiking, not skiing

#### Paddling
**Question id:** `flag_act_paddling`. **Type:** `noul`. **Stored as / URL key:** `act_paddling`.
> **Instructions:** If there is a person in `photo`, are they paddling?
>
> **true:** A person in the photo is paddling: in or with a kayak, canoe, paddleboard or rowing boat
>
> **false:** No person in the photo is paddling, or no person is visible

#### Climbing
**Question id:** `flag_act_climbing`. **Type:** `noul`. **Stored as / URL key:** `act_climbing`.
> **Instructions:** If there is a person in `photo`, are they climbing?
>
> **true:** A person in the photo is climbing: rock climbing, ice climbing or scrambling up steep terrain with hands
>
> **false:** No person in the photo is climbing, or no person is visible

#### Cycling
**Question id:** `flag_act_cycling`. **Type:** `noul`. **Stored as / URL key:** `act_cycling`.
> **Instructions:** If there is a person in `photo`, are they cycling?
>
> **true:** A person in the photo is cycling: riding or pushing a bicycle
>
> **false:** No person in the photo is cycling, or no person is visible

#### Camping
**Question id:** `flag_act_camping`. **Type:** `noul`. **Stored as / URL key:** `act_camping`.
> **Instructions:** If there is a person in `photo`, are they camping?
>
> **true:** A person in the photo is camping: at a tent or campsite, by a campfire or cooking outdoors
>
> **false:** No person in the photo is camping, or no person is visible

### 3.4 Weather & sky
**Where they appear:** the **Weather & sky** chips: one chip per weather option, then a chip per sky feature (`?<id>=true`).

#### Weather
**Question id:** `choice_weather`. **Type:** `choice`. **URL key:** `weather`.
> **Instructions:** What is the weather like in `photo`?

| Option id | Criterion text | Stored |
|---|---|---|
| `clear` | Clear: a blue or starry sky with few or no clouds | yes |
| `cloudy` | Cloudy: clouds cover part or all of the sky, with no fog, rain or snow | yes |
| `fog` | Fog / mist: fog, mist, low cloud or haze softens or hides parts of the scene | yes |
| `precipitation` | Rain, snow or storm: falling rain, snow or sleet, raindrops on the water, or dark storm clouds | dropped¹ |
| `unknown` | Can't tell: no sky is visible and the weather can't be judged | no value |

¹ Still asked, so the other options keep their probabilities, but never stored and has no chip: it was mostly snow lying on the ground, frost and droplets on close-ups (3 right out of 16). A photo where it wins gets the most likely remaining option, or no value when the remaining options have under 25% between them.

The sky features count as **yes** only at P(yes) ≥ 0.9, because a false yes (for example a sensor-dust spot read as the moon or a star, or any warm low light read as sunset) stands out more than a missed one. Between 0.3 and 0.9 they are stored as unsure and don't match the chip.

#### Sunrise / sunset
**Question id:** `flag_sunset`. **Type:** `noul`. **Stored as / URL key:** `sunset`.
> **Instructions:** Was `photo` taken around sunrise or sunset?
>
> **true:** The sun is low at or near the horizon, or the sky or light glows orange, pink, red or gold from a rising or setting sun, including the minutes just before sunrise and after sunset
>
> **false:** Daytime with the sun well above the horizon, full night, or warm colours that come from something else, such as autumn leaves, fire, smoke or artificial light

#### Night sky
**Question id:** `flag_night_sky`. **Type:** `noul`. **Stored as / URL key:** `night_sky`.
> **Instructions:** Does `photo` show a night sky?
>
> **true:** A dark night sky with stars, the Milky Way, star trails, an aurora or the moon clearly visible in it
>
> **false:** Not a night sky: daytime, sunset or twilight with no stars, or a dark sky with nothing in it. Dust spots, specks, image noise and lights do not count as stars or the moon

#### Rainbow
**Question id:** `flag_rainbow`. **Type:** `noul`. **Stored as / URL key:** `rainbow`.
> **Instructions:** Is a rainbow visible in `photo`?
>
> **true:** A rainbow or a clear part of one is visible, including in waterfall spray
>
> **false:** No rainbow; lens flare, sunset colours, coloured clouds and colour fringes do not count

### 3.5 Coverage: approximate share of the frame (Score, 6 levels)
**Where they appear:**
- **Sliders view:** the “Landscape” section (range of the expected share).
- **Lightbox:** “Approximate coverage”, showing the nearest level word rather than a precise percentage.

**Stored value:** the expected % of the frame, Σ P(level) × share(level) with shares 0, 4, 22, 50, 75, 95 %. **Present (Contains):** P(any amount) = 1 − P(None) > 0.5, or, when the admin has overridden the value, override > 0.

**Slider value:** a category judged absent counts as **0%** on the sliders, in the histograms, and in sorting; otherwise it is the expected share. Without this, a photo where Jev is 80% sure there is no snow but gives a little weight to large shares would average to about 6% snow and match a 2–14% snow filter.

**Why presence isn't “expected share ≥ 2%”:** a 90% chance of None and 10% of A quarter gives an expected 2.2%, which would have counted as “contains” although Jev thinks it is probably absent. On the album, the new rule dropped 4 such cases (two faint snow readings, a doubtful water and a doubtful desert) and added none.

Each category is its own Score question, so the shares are independent estimates that can add up to more than 100%. This is deliberate for snow and autumn foliage, which overlap what they cover.

**Instructions template:**
> How much of the area of `photo` is covered by {noun}, meaning {definition}? Count only areas that are clearly {noun}; similar-looking things do not count.

**Levels**, low (0) to high (5), with {noun} substituted:
0. None: no {noun} visible anywhere in the photo (share 0%, shown as “None”)
1. A trace: {noun} only as a small patch, a distant sliver, a thin line or a small figure; almost all of the frame is something else (share 4%, shown as “Trace”)
2. A quarter: a clear band or area of {noun}, roughly a quarter of the frame; most of the frame is something else (share 22%, shown as “Some”)
3. About half: {noun} and other things share the frame about equally (share 50%, shown as “About half”)
4. Most of the frame: {noun} everywhere except smaller areas of other things (share 75%, shown as “Most”)
5. Nearly all: {noun} edge to edge across the frame, with little or nothing else visible (share 95%, shown as “Nearly all”)

**The 12 categories**, instructions exactly as sent:

| Filter label | Question id = URL key | Group | Full instructions |
|---|---|---|---|
| Water | `cover_water` | Landscape | How much of the area of `photo` is covered by water, meaning any body of water — sea, ocean, lake, pond, river or stream — including its surface, reflections on it and underwater views; not waterfalls? Count only areas that are clearly water; similar-looking things do not count. |
| Waterfall | `cover_waterfall` | Landscape | How much of the area of `photo` is covered by waterfall, meaning white water falling over a drop, such as a waterfall or cascade? Count only areas that are clearly waterfall; similar-looking things do not count. |
| Sky | `cover_sky` | Landscape | How much of the area of `photo` is covered by sky, meaning any sky — clear, cloudy, hazy, at sunset or at night — including clouds, the sun, the moon, stars and aurora? Count only areas that are clearly sky; similar-looking things do not count. |
| Forest / trees | `cover_forest` | Landscape | How much of the area of `photo` is covered by trees, meaning forest, woodland, tree canopy or individual trees and shrubs, including trees covered in snow, autumn trees and silhouetted trees; not small plants or flowers seen up close? Count only areas that are clearly trees; similar-looking things do not count. |
| Mountains | `cover_mountains` | Landscape | How much of the area of `photo` is covered by mountains, meaning mountains, peaks, ridges, hills and cliffs, including snow-covered ones; not boulders or beach stones? Count only areas that are clearly mountains; similar-looking things do not count. |
| Snow / ice | `cover_snow` | Landscape | How much of the area of `photo` is covered by snow or ice, meaning snow or ice covering any surface — the ground, trees, mountains or rocks — plus glaciers and frozen water; count snow-covered trees and mountains as snow too? Count only areas that are clearly snow or ice; similar-looking things do not count. |
| Autumn foliage | `cover_autumn` | Landscape | How much of the area of `photo` is covered by autumn foliage, meaning leaves that have turned red, orange, yellow or gold for autumn, on trees, shrubs or the ground; count trees in autumn colour as autumn foliage too? Count only areas that are clearly autumn foliage; similar-looking things do not count. |
| Rock | `cover_rock` | Landscape | How much of the area of `photo` is covered by bare rock, meaning bare rock seen up close or in the middle distance: boulders, outcrops, rock walls, cliff faces, scree and rocky ground; distant mountains count as mountains, not rock? Count only areas that are clearly bare rock; similar-looking things do not count. |
| Flowers / plants | `cover_plants` | Landscape | How much of the area of `photo` is covered by flowers and small plants, meaning flowers, wildflowers, ferns, moss, lichen, fungi and other small plants, seen up close or as a carpet; not trees, shrubs or ordinary grass? Count only areas that are clearly flowers and small plants; similar-looking things do not count. |
| Shore / beach | `cover_shore` | Landscape | How much of the area of `photo` is covered by shore, meaning a beach or shoreline: sand, pebbles, cobbles, driftwood or tidal rocks at the water's edge? Count only areas that are clearly shore; similar-looking things do not count. |
| Meadow / grass | `cover_meadow` | Landscape | How much of the area of `photo` is covered by grass or meadow, meaning grassland, meadow, prairie, fields or low green or golden vegetation? Count only areas that are clearly grass or meadow; similar-looking things do not count. |
| Desert | `cover_desert` | Landscape | How much of the area of `photo` is covered by desert, meaning arid desert land with little or no vegetation, such as sand dunes, desert scrub, salt flats or dry red-rock canyons; not snow drifts or wind-sculpted snow, beach or riverbank sand, scree, rocky mountain slopes or dry grassland? Count only areas that are clearly desert; similar-looking things do not count. |

### 3.6 Mood (Score scales)
**Where they appear:** the “Mood” slider section, the lightbox and sorting. URL key = attribute id, a 0–100 range.

**Stored value:** expected score ÷ top level × 100. Ticks and lightbox labels show the nearest level's short label.

The time of day is the **Sunrise / sunset** tag in Weather & sky, and overcast and fog are in **Weather**. Scales for the light itself didn't sort the album usefully (see `docs/jev-image-capabilities.md`).

#### Sky drama
**Question id:** `mood_sky_drama`. **Type:** `score` (4 levels). **URL key:** `sky_drama`. **Slider ends:** Plain ↔ Spectacular. Stored only when sky is judged present.
> **Instructions:** How dramatic is the sky in `photo`? If no sky is visible, choose the lowest level.

| Level | Short label | Level text |
|---|---|---|
| 0 | Plain | Plain: clear uniform blue or flat featureless grey, or no sky visible |
| 1 | Some clouds | Some ordinary clouds add a little interest, but the sky is not a focus |
| 2 | Striking | Striking clouds, colour, mist or light rays make the sky a notable part of the picture |
| 3 | Spectacular | The sky is spectacular and sets the mood: storm clouds, blazing sunset colours, aurora, rainbow or the Milky Way |

#### Wildness
**Question id:** `mood_wildness`. **Type:** `score` (4 levels). **URL key:** `wildness`. **Slider ends:** Developed ↔ No visible development.
> **Instructions:** How wild and undeveloped is the landscape in `photo`? Ignore any people and the gear they carry or travel with, such as packs, skis, kayaks, canoes and tents; judge only the place itself.

| Level | Short label | Level text |
|---|---|---|
| 0 | Developed | Clearly developed: roads, buildings, towns, farms, power lines or vehicles are prominent |
| 1 | Some development | Some development: a few buildings, a road, docks, moored boats or managed land are visible, but nature dominates |
| 2 | Light traces | Light traces only: a trail, fence, small bridge, signpost or a single distant structure |
| 3 | No visible development | No visible development: nothing built or managed can be seen, even if people are in the photo |

### 3.7 Colour (one Jev scale and four measurements)
**Where they appear:** the “Colour” slider section and the **Palette** chips, the lightbox and sorting.

#### Colour diversity
**Question id:** `look_colour_diversity`. **Type:** `score` (4 levels). **URL key:** `colour_diversity`. **Slider ends:** One hue ↔ Many. Counts hues only; vividness is the separate Saturation measurement.
> **Instructions:** How many distinct hues appear in `photo`? Count different colours, not how vivid they are.

| Level | Short label | Level text |
|---|---|---|
| 0 | One hue | One hue: a single colour family, or black and white, as in fog, a night sky or a one-colour scene |
| 1 | Few | Few: two or three closely related hues |
| 2 | Several | Several: several distinct hues |
| 3 | Many | Many: many distinct hues from around the colour wheel |

#### Measured in code from `jev.jpg` (not asked of Jev)

| Tag (URL key) | Ends | How it's calculated |
|---|---|---|
| Colour warmth (`warmth`) | Cool ↔ Warm | From the mean red R and blue B: 50 + (R − B) ÷ ((R + B) ÷ 2) × 100, clamped to 0–100. A (near-)black image (R + B < 8) is 50. Jev's own judgment agreed at r = 0.91, so Jev isn't asked. |
| Saturation (`saturation`) | Muted ↔ Vivid | Mean HSV saturation over a 128 px copy (near-black pixels count as 0), with 0–0.6 mapped onto 0–100. |
| Brightness (`brightness`) | Low-key ↔ High-key | Mean luminance (Rec. 709 weights) of a 128 px copy, 0–100. |
| Palette (`palette`) | chips | Each pixel of a 128 px copy is assigned a family by hue (red, orange, yellow, green, teal, blue, purple, pink), or neutral when saturation < 0.2. Near-black pixels (brightness < 0.12, shadows) and near-white ones (every channel ≥ 95%, the sun or glare) count as nothing. Neutral's count is divided by 4 before ranking, so it comes first only when it covers over four times the top colour (snow, fog, night, black and white). Stored: the top family, plus the next *colour* (never neutral) when it covers at least 15% of the counted pixels, e.g. `blue,orange`. Neutral is on about 23% of photos. The chips are a multi-select: `?palette=red,yellow` matches photos with any of the chosen colours, and **Primary colour only** (`palette_primary=1`) matches, and counts, only each photo's first colour. |

### 3.8 Look & composition (Score scales)
**Where they appear:** the “Look & composition” slider section, the lightbox and sorting.

**Stored value:** expected score ÷ 3 × 100 (4 levels), except Quality.

#### Quality
**Question id:** `quality`. **Type:** `score` (8 levels). **URL key:** `quality`. **Slider ends:** Unusable ↔ Excellent. **Sort:** “Quality: Excellent first”. The first slider in the section.

One overall judgment, not a weighted mix of aspects: many strong nature photos are deliberately soft in places (shallow depth of field, motion blur), and a separate sharpness aspect would wrongly penalise them. Jev plays a judge at a nature photography club competition for keen amateurs, told to reward design in close-ups and abstracts as much as a grand view, and the level texts describe the photo rather than how ordinary its subject is. A magazine editor choosing a cover, the obvious framing, favoured grand vistas and scored well-made close-ups and abstracts low (tracks in snow, a forest texture, snow curves: 35–46). Milder rewording of that framing (“amateurs”, “on its own terms”) moved scores by only a point or two; the club judge lifted those close-ups by 6–14 points and left vistas where they were.
> **Instructions:** You are an experienced judge at a nature photography club competition for keen amateur photographers. How highly do you rate `photo`? Judge it as a photograph, on its own terms: reward strong design (pattern, texture, line, shape, rhythm, light and shadow) in close-ups, details, minimal and abstract photos as much as a grand view. Weigh technical quality (focus, exposure, noise), composition, light, and how interesting or memorable the photo is. Soft or blurred areas count against the photo only if they look accidental, not when they are a deliberate choice such as a shallow depth of field or motion blur.

| Level | Short label | Level text |
|---|---|---|
| 0 | Unusable | Unusable: an accidental shot, or badly blurred or badly exposed |
| 1 | Poor | Poor: obvious technical faults, or no clear subject or idea |
| 2 | Snapshot | Snapshot: technically acceptable, but little care over composition or light |
| 3 | Decent | Decent: a competent, pleasant photo that is unremarkable |
| 4 | Good | Good: well made, with a clear subject or idea and a pleasing composition |
| 5 | Strong | Strong: appealing light, composition, design or moment |
| 6 | Great | Great: striking and memorable; an award contender |
| 7 | Excellent | Excellent: outstanding; a winning photo |

**Stored value:** round(1 + 99 × curve(expected score ÷ 7)), an integer from 1 to 100; the top level (7) is taken from the number of probabilities returned. The probability-weighted score is used rather than the most likely level, which would bunch photos into 8 values. Jev rarely gives a photo much weight on the top level, so on a straight line no photo reached Excellent (the best scored 87). The curve (`QUALITY_CURVE` in `server/jev.ts`) is piecewise linear through fixed points set from this album: the median expected score (0.61) lifts slightly to 0.63, the 95th percentile (0.7414) goes to where Excellent starts (0.9286), and 0 and 1 stay put. It never changes the order of photos. On the 2,859 photos: Excellent 147 (5%), Great 351, Strong 870, Good 1,305, Decent 171, Snapshot 15; values 25 to 96, mean 66. The label is the nearest level, as for the other scales. An answer that isn't a Score leaves the value unknown, never 0. Stored with the level probabilities, the confidence and the model (`jev_detail.model`); the exact expected score is kept in `jev_result.quality`. Flagged unsure, like the other scales, when the two most likely levels are at least two steps apart and the second has P ≥ 0.3. Admin overrides are 1–100 and survive re-runs.

**Changing the curve:** edit `QUALITY_CURVE`, then `npm run remap-quality` recomputes every stored value from the stored reading without asking Jev. Overrides are left alone.

**Photos classified before the question existed:** `npm run score-quality` asks only this question (of the same `jev.jpg`, or the same panorama tiles), writes only the quality value and leaves every other tag and override alone. Photos that already have a score are skipped; `-- --force` rescores them all, which is needed after any change to the wording or levels (the result is then a new scale, and the curve's fixed points may need resetting). About 4,750 input tokens per photo (13.6 million for the 2,859 photos).

#### Tonal contrast
**Question id:** `look_tonal_contrast`. **Type:** `score` (4 levels). **URL key:** `tonal_contrast`. **Slider ends:** Flat ↔ Extreme.
> **Instructions:** How wide is the range of brightness in `photo`, from its darkest areas to its brightest?

| Level | Short label | Level text |
|---|---|---|
| 0 | Flat | Flat: low contrast with no deep shadows or bright highlights, as in fog, haze or soft overcast light |
| 1 | Moderate | Moderate: some contrast between lighter and darker areas, but no very deep shadows or very bright highlights |
| 2 | High | High: both deep shadows and bright highlights are present in the same scene |
| 3 | Extreme | Extreme: a very bright light source such as the sun in the frame or strong backlight against very dark areas; highlights may be blown out or shadows pure black |

#### Scene complexity
**Question id:** `look_complexity`. **Type:** `score` (4 levels). **URL key:** `complexity`. **Slider ends:** Minimal ↔ Complex.
> **Instructions:** How visually complex is the scene in `photo`?

| Level | Short label | Level text |
|---|---|---|
| 0 | Minimal | Minimal: a single subject against a plain or empty background |
| 1 | Simple | Simple: a few clear elements and plenty of uncluttered space |
| 2 | Busy | Busy: many elements, textures or details competing for attention |
| 3 | Complex | Very complex: dense detail and clutter throughout the frame, with no single clear subject |

#### Straight lines
**Question id:** `look_straight_lines`. **Type:** `score` (4 levels). **URL key:** `straight_lines`. **Slider ends:** None ↔ Dominant.
> **Instructions:** How much do straight lines and geometric edges shape the picture in `photo`, such as horizons, tree trunks, buildings, fences, paddles, shorelines, sharp edges and blocky rocks?

| Level | Short label | Level text |
|---|---|---|
| 0 | None | None: entirely organic, irregular shapes with no noticeable straight lines |
| 1 | A few | Slight: a horizon or one or two faint straight edges |
| 2 | Prominent | Clear: several distinct straight lines that are part of the composition |
| 3 | Dominant | Dominant: strong straight lines or geometric structure define the composition |

#### Curvy lines
**Question id:** `look_curvy_lines`. **Type:** `score` (4 levels). **URL key:** `curvy_lines`. **Slider ends:** None ↔ Dominant.
> **Instructions:** How much do curves, arcs and flowing lines shape the picture in `photo`, such as winding rivers, waves, dunes, curved branches, cloud swirls or animal outlines?

| Level | Short label | Level text |
|---|---|---|
| 0 | None | None: no noticeable curves or flowing lines |
| 1 | A few | Slight: a few gentle curves |
| 2 | Prominent | Clear: prominent curves that are part of the composition |
| 3 | Dominant | Dominant: sweeping, flowing curves define the composition |

#### Scale
**Question id:** `look_scale`. **Type:** `score` (4 levels). **URL key:** `scale`. **Slider ends:** Macro ↔ Vista.
> **Instructions:** How close is the camera to its subject in `photo`, and how wide is the view?

| Level | Short label | Level text |
|---|---|---|
| 0 | Macro | Macro: an extreme close-up of something small, such as an insect, a flower, frost crystals or a rock texture, filling the frame |
| 1 | Close-up | Close-up: a single plant, animal, person or small detail of the landscape, seen from a few metres away |
| 2 | Landscape | Landscape: an ordinary view of a scene, such as a stretch of shore, a forest clearing or a lake and its far bank |
| 3 | Vista | Grand vista or aerial: a sweeping view over a great distance, such as a mountain range or a wide valley, or a view from the air |

#### Depth of field
**Question id:** `look_depth_of_field`. **Type:** `score` (4 levels). **URL key:** `depth_of_field`. **Slider ends:** Deep ↔ Bokeh.
> **Instructions:** How much of `photo` is in sharp focus?

| Level | Short label | Level text |
|---|---|---|
| 0 | Deep | Deep focus: everything from the nearest foreground to the far distance is sharp |
| 1 | Mostly sharp | Mostly sharp: the nearest foreground or the far background is slightly soft |
| 2 | Shallow | Shallow: the subject is sharp and the background is clearly blurred |
| 3 | Bokeh | Very shallow: only a thin slice is sharp and the rest dissolves into a smooth blur (bokeh) |

### 3.9 Experimental 3D map
The last section of the filter panel, collapsed until opened (remembered per browser). One cube, each axis 0–100, that you drag to rotate; each photo is a dot (hover to preview, click to move the pointer onto it). The pointer is set by clicking a dot or with the **Water → mtns**, **Colour** and **Scale** sliders, and **Pointer size** grows it into a sphere, up to 174 (covers the whole cube from anywhere). It is an ordinary filter: **off** until the pointer is placed (clicking a dot or moving any of its sliders turns it on, starting from a sphere of 25 at the centre), and **×** or **Clear filters** turns it off; it then counts as one active filter. URL: `m3=x,y,z,r`. (Earlier versions had a separate Map view with two flat plots; `view`, `m1`, `m2` and `mapuse` are removed from old links.)

| Axis | Meaning |
|---|---|
| Across (x) | Water → mountains: three places, matching the primary-subject groups: **water** 0 (water, shore, waterfalls), **foothills** 50 (everything between the water and the mountains: meadows, forests, flowers and small plants, desert), **mountains** 100 (mountains, rock). Sky is left out, since nearly every photo has some. The photo sits at the average of the three places weighted by the shares of the categories judged present there (60% foothills and 40% mountains → 70); photos with a single group sit exactly on its place. Snow and autumn foliage add their share to what they cover (snowy trees → foothills, a glacier → mountains), or sit at 100 and 50 when nothing else is present. Photos with only sky aren't placed. The slider names the place (“Water”, “Water – Foothills”, …). |
| Up (y) | Main colour, **stretched where photos are crowded**: photos with a main colour are placed by their rank among all published photos' colours (12 + 88 × rank), so the many blue skies and orange-lit photos spread out instead of piling up in thin bands; colours keep their order. Photos with little colour sit in a neutral band at 5. The response includes `colourAxis` ([cube position, even colour-axis position] pairs) so the Colour slider can name the colour and draw its strip to match. The colour picker in the Sliders view stays evenly spaced by hue. |
| Depth (z) | Scale: macro 0 → vista 100 (the Jev scale) |

**Colour picker** (Sliders view, top of the Colour section): a square with the colour axis across (a grey neutral band at 0–10, then red → orange → yellow → green → teal → blue → purple → pink across 12–100, as on the map) and saturation up (muted → vivid). Drag out a box to filter on both: `hue=a-b` on the colour axis and `saturation=c-d` (saturation has no slider of its own; the picker is how it is filtered). Photos are placed by their **main colour** (`main_hue`): the colour family covering the most pixels (saturation ≥ 0.2, not near-black) and its mean hue, or neutral when under 10% of the frame is coloured. It is measured from the pixels, not asked of Jev. The dots are every photo the other filters allow; those inside the box are highlighted.

**Selection:** with the pointer placed, only photos inside the sphere pass, together with every other filter (photos the cube can't place, such as sky-only ones, don't pass unless Pointer size is at Everything, which lets every photo through). If none are inside, no photos are shown, as with any filter. Counts on the other filters include the map selection.

### 3.10 Sorting
- **Random** is the default (no `sort` param): a shuffle that is new on each visit, steady while filtering. Choosing Random again picks a new shuffle and puts it in the link (`seed=…`), so a shared link reproduces it; `sort=random` also works. No text is shown on the photos.
- **Image number** (`sort=number`): Image 1 first; each thumbnail shows its name (“Image 12”) when Display value is ticked.
- **Newest first** (`sort=newest`): by the date taken (EXIF DateTimeOriginal from the original, read on upload and stored as `taken_at`). Photos without one follow, most recently uploaded first. Each thumbnail shows “Date: …”, or “Date: Unknown”.
- Any numeric tag can sort, highest first: “Most water”, “Sun position: High sun first”, and so on. `?sort=<id>`, with `&order=asc` for lowest first.
- When sorting by a tag, each thumbnail shows that tag's value, unless **Display value** (a checkbox under Sort, remembered per browser) is unticked.

---

## 4. Re-tagging and history
- **Re-tag all photos** (admin) or **Re-run Jev** (one photo) asks the current question set again. Overrides are kept; values the new run doesn't produce become unknown.
- Tags left over from older question sets, and overrides that are no longer valid, are removed when the server starts.
- How the coverage method was chosen, and the wording changes since, are recorded in `docs/jev-image-capabilities.md`.
