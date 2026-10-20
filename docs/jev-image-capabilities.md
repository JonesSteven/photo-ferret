# TypeSafe image models: synopsis and lessons

Sources:
- [docs.typesafe.ai/images](https://docs.typesafe.ai/images)
- [docs.typesafe.ai/primitives/box](https://docs.typesafe.ai/primitives/box)
- [Jev 1.14 release post](https://typesafe.ai/blog/jev-1-14)

Researched 2026-10-15.

## Synopsis

Images and Box are **preview ("dreamer-ready")** features and are not meant for production yet. Request formats, limits, and accuracy may change.

- **Turn it on:** send `TypeSafe-Danger-Zone-Images: true` on every request that has an image or a Box question.
  - Images work on `jev-1.13.0` and `jev-1.14.0`. Box needs **1.14**.
  - JS SDK: `new TypeSafeClient({ defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" } })`.
- **How images are sent:**
  - A top-level `assets` map holds images, each keyed by a reference string (use UUIDs).
  - You put the reference string wherever the image belongs: in **`state`** (shared by all questions, so the cheapest), in a question's **`instructions`**, or in **`criteria`**. In criteria, an image can define what an option *looks like*, for example "same place as this reference photo".
  - The SDKs handle the references for you: `image(bytes)` in JS, an `Image` asset in Python.
  - Over HTTP, multipart is the recommended upload method. Base64 inside JSON costs about a third more toward the 32 MiB body limit.
- **Every primitive accepts images:** Choice, Noul, and Score. **Box** is the new primitive that locates something in an image.
- **Box:**
  - Returns `{top, bottom, left, right}` as 0–1 fractions of the image height and width, plus `confidence`.
  - It **always returns a box** and has no "not found" answer, so pair it with a Noul for presence.
  - One target per question.
  - For small targets, crop to a region first, then run Box on the crop and map the result back.
- **Hard limits:**
  - PNG or JPEG still images only.
  - Each image at most 16 MiB.
  - Each side 280–1568 px (docs said 256 before 2026-10-17), and 78,400–2,458,624 px in total.
  - Requests at most 32 MiB.
  - Images outside the limits are **rejected, not resized**. One bad image fails the whole request.
  - The API strips EXIF and does not apply orientation, so rotate the pixels yourself first.
- **Cost:** image tokens are billed as ordinary input tokens, and there are no separate image rate limits. In this app, one photo plus 14 questions comes to about 4k input tokens.
- **Guidance:** models do worse on images than on text, so break the work into simple, narrow questions.

### New in Jev 1.14 (`jev-1.14.0`, alias `jev-preview`; `jev-latest` moves to it about a week after release)
- Small improvements across the board, with the biggest gains in multilingual tasks.
- The **Box** question type, available on 1.14 only.
- The **images** header, opening up the multimodal support that 1.13 already had.
- **Long context:** `TypeSafe-Danger-Zone-Long-Context: true` allows requests beyond the production context limit.
- Opt-in query sharing to help TypeSafe find model weaknesses. TypeSafe says it won't train on these queries.
- 1.13 stays available for now. TypeSafe promises 60 days' notice before deprecating 1.13, and 30 days' notice for 1.14.

## Lessons from building this app
- One request carries 13 questions (Choice + 11 Nouls + Box) over one image in `state`. Answers came back in about 0.2–0.3 s and used about 4k input tokens.
- Multi-label Nouls catch secondary features that a single Choice hides. For example, a glacier tarn came back as snow 0.99, lake 0.97, and mountains 0.97, while the primary-scene Choice picked "snow".
- Season detection was removed because it was unreliable: summer alpine shots with lingering snow were labelled winter. If you bring it back, try per-cue Nouls (for example "autumn-coloured leaves visible?" or "bare deciduous trees?") and combine them in code instead of asking for the season directly.
- In a test, the person Box tightly framed the person, with confidence about 0.9. When nobody is in the photo, Box still returns a box, but with very low confidence (about 0.04), which is why the app gates it on the Noul.

## Experiment: estimating how much of the frame each surface covers (2026-10-17)

Script: `scripts/coverage-experiment.ts`, a one-off since removed (it's in the git history). It ran on 16 real nature photos with `jev-1.14.0`, using two requests per photo. The report went to `data/experiments/`.

| Method | How | Verdict |
|---|---|---|
| **A: one Score per surface** | Six visual levels per surface, from "none visible" to "fills the frame edge to edge", mapped in code to 0/4/22/50/75/95%. | **Unreliable.** Each surface is judged on its own, so look-alikes get inflated. On ocean photos, lake and river scored 50–84%, and cobbles or snow slopes scored as "mountains" at 42–54%. Totals averaged 166% of the frame, ranging from 71% to 239%. |
| **B: grid tiles** | The image is cut into a 5×3 grid (5×2 for panoramas), with tiles at least 300 px a side. The full photo plus the tile list goes in `state`, with one Choice per tile ("what covers most of this cell?", including "other"). Coverage is the average probability across tiles. | **Best.** It matched an eyeball reading on every photo checked. Examples: aurora sky 63%, water 17%, trees 8%. Snowy forest 56%, mountains 24%. Marmot close-up "other" 72%. Totals are always 100%, and it also gives *where* each surface is. About 2× the input tokens of A (about 15k vs 7k per photo) and about 1.4k output tokens. |
| **C: "random point" Choice** | One Choice: "if a point were picked at random from the photo, what would it land on?" | **Over-concentrates.** It gets the dominant surface right but inflates it (sky 83–100% where B said 57–63%) and squeezes the secondary surfaces toward 0. It's nearly free, but only good for "what's the main surface". |

- **Mood Scores in the same request** looked right on the photos checked:
  - **Light** (night → twilight → sunrise/sunset → golden hour → overcast → midday): mean confidence 0.80. Moon and aurora shots came out as night with confidence 1.0, a snowy overcast scene as overcast, and a kayak at sunset as sunset.
  - **Sky drama:** mean confidence 0.87. The aurora scored 3/3, the moon on a black sky 0.1/3, and a flat grey sky 0.4/3.
  - **Wildness:** mean confidence 0.79. People and boats lowered it as expected.
  - **Jev's perceived warmth vs warmth measured from the pixels** (red channel minus blue channel): correlation 0.91. Measure it in code, which is free and exact, and skip the question.
- **Latency:** each request took about 0.2–0.9 s, whatever the method.

### Run 2 (same day): revised surfaces
- **What changed:**
  - Lake, ocean and river were merged into one **water** surface. Water now covers the surface itself, reflections on it, and underwater views.
  - **Shore** was split out (beach, cobbles, driftwood), because run 1 scored cobbles as mountains.
  - **Sky** now explicitly includes the sun, moon, stars and aurora.
  - Tie-break rules were added: snowy trees count as forest, distant snowy peaks as mountains, and snow only means snow on the ground.
  - Method A's questions now say that "similar-looking surfaces do not count". The tile questions now tell Jev to use the whole photo for context.
- **Results:**
  - **Method A improved sharply.** Its surfaces now total 110% of the frame on average (range 40–151%), down from 166%. The false lake/river readings on sea photos are gone.
  - **A and B are now close**, and each wins in different places:
    - **A** is better on thin bands, such as distant mountains or a narrow strip of water, which a 5×3 grid misses. For example, on a sunset over water with distant mountains, A estimated mountains at 19% and B at 5%, against roughly 10% by eye.
    - **B** is better at putting animals and people into "other". A has no question for "other".
  - **C still over-concentrates** on the dominant surface.
- **Against by-eye estimates for 12 photos:** mean error (in percentage points) and misses of more than 15 points were:

  | Method | Mean error (points) | Misses >15 points |
  |---|---|---|
  | A | 3.0 | 4 |
  | B | 1.9 | 3 |
  | C | 4.3 | 13 |
  | average of A and B | 1.9 | 2 |

- **A wording conflict to fix:** "close-up rocks" under "other" made B file shoreline rocks as "other" on one photo.

## Look & composition scales (2026-10-17)
Four more Score questions, each with four levels: dynamic range, scene complexity, straight lines and curvy lines. All 16 photos were re-tagged.

- **Spot checks looked right:**
  - the moon on a black sky: complexity 0/100, straight lines 1/100
  - the jellyfish: curvy lines 99/100
  - both kayak shots: straight lines about 63/100, from the horizon and paddle
  - the overcast ski slope: dynamic range 36/100, flat
- **Mean confidence:**

  | Scale | Mean confidence |
  |---|---|
  | Complexity | 0.80 |
  | Straight lines | 0.73 |
  | Dynamic range | 0.67 |
  | Curvy lines | 0.60 |

  Curvy-line scores bunch between 45 and 70 on most photos, so that slider separates photos less well than the others.
- **Jev's dynamic range vs the pixel spread** (1st–99th percentile of brightness, stored as the admin-only `dynamic_range_px`): correlation **0.41**, much weaker than warmth's 0.91. They measure different things.
  - Jev judges the scene's contrast: a bright moon on black sky is "extreme".
  - The pixel spread ignores small bright areas: the moon covers less than 1% of the frame, so it scores 49/100.
  - The slider uses Jev's judgment, which matched the photographer's sense of dynamic range on the photos checked.

## People, wildlife and birds as yes/no tags; colour variation (2026-10-17)
- **People, wildlife (not birds) and birds** are now Noul questions ("is there one visible anywhere?") rather than coverage Scores. A small bird or a distant hiker matters even when it fills almost none of the frame.
  - Across 16 photos, every tag matched what's in the photo:
    - Wildlife: deer, jellyfish, sea otter, seals and marmot, with p 0.85–0.99.
    - Birds: only the gull, at p 0.99.
    - People: the skier and both kayakers, at p 0.97–0.99.
  - Everything else scored p ≤ 0.21, except one borderline case: distant specks on the water in a kayak photo gave wildlife 0.44 and birds 0.31, both below the 0.5 cutoff.
- **Colour variation** is a four-level Score, from monochrome to vivid. Mean confidence was 0.78.
  - Compared with a pixel measure (normalised hue entropy times the share of colourful pixels, stored as the admin-only `colour_variation_px`), the correlation was 0.71.
  - The moon scored 0. The sunset kayak and the turquoise beach scored highest (84 and 78).

### Wildness no longer counts people
- **Why:** the people in these photos are usually the photographer's companion in remote places.
- **What changed:** the question now asks Jev to ignore people and the gear they carry or travel with (packs, skis, kayaks, canoes, tents) and to judge only how developed the landscape is.
- **Effect after re-tagging:**
  - The skier went from 66 to 98, and the kayaker under the mountains from 42 to 94, both with confidence above 0.8.
  - Photos without people barely moved.
  - Three photos stayed uncertain, with Jev split between "some development" and "untouched": the sunset kayak (65), the wildfire smoke (62) and the aurora (71). Each has a little distant development, such as shoreline lights or buildings (structures 2–4% of the frame), so the uncertainty is about the landscape, not the people.

## Reviewer feedback round (2026-10-18)
Four reviews of the app were filtered down by the photographer and addressed in one round. Question set: 47 questions in one request, about 10,000 input and 1,000 output tokens, 0.3–0.6 s per photo. All 20 photos were re-tagged without errors.

### Meaning fixes
- **Light split in two.** The old 6-level Light scale (Night, Twilight, Sunset, Golden, Overcast, Midday) wasn't one ordered dimension, so averaging between, say, Night and Overcast landed on "Sunset". It is now **Sun position** (Night → High sun, 5 levels) and **Light quality** (Soft → Hard, 4 levels); overcast and fog moved into a **Weather** Choice.
- **Contains = P(any amount) > 0.5** instead of expected share ≥ 2%. On the album this changed 4 cases, all from "contains" to not: snow on two photos (P(present) 0.27 and 0.20, expected share ~6% from a small chance of a large area), water at 0.46 and desert at 0.08. None went the other way.
- **Yes/no tags have an unsure state** (0.3 < P(yes) < 0.7). Unsure photos match neither With nor Without. Confidence for a Noul is now |2p − 1|, and the admin shows P(yes) itself.
- **Second look:** an unsure People/Wildlife/Birds answer is asked again on a 2 × 2 grid of sharper tiles of the original (four images, one request), taking the highest tile. Results on the album:
  - Kayak with distant specks on the water: wildlife 0.41 → 0.56 (still unsure, which is fair: the specks may be otters); birds 0.32 → 0.22 (now No).
  - Birds on three other photos rose from 0.35–0.48 to 0.51–0.69, so they stay unsure. One is a rainy sea, where raindrops may look like birds. The max-over-tiles rule leans towards Yes; worth watching.
- **Bimodal Scores** (two levels ≥ 2 apart each ≥ 30%) are flagged unsure. Only one reading on the album: wildness on the sunset kayak, split between "some development" and "no visible development".
- Sky drama is no longer stored for photos without sky, and water surface not for photos without water.
- Renames: Dynamic range → **Tonal contrast**; Colour variation → **Colour diversity** (hue count only; vividness is the measured Saturation); Wildness top level → "No visible development"; Main subject is now the *visual focal subject*.

### New Jev tags, first results
- **Reflections** came out unsure on 6 of 20 photos (P 0.35–0.52). Looking at them, all have soft or partial reflections (sunset on water, a gull's reflection, kayakers' reflections), so the question's "mirror-like, recognisable" bar puts them genuinely on the line. If the photographer wants these counted, relax the wording.
- **Moon:** correct on the moon shot, but a false Yes (0.74) on the clear-sky kayak photo. That sky has three faint sensor-dust spots, one of which Jev probably read as the moon.
- **Weather:** a rainy sea photo was tagged Fog / mist at 36% confidence instead of Rain / snow falling.
- Night and aurora shots got Sun position ≈ 0 and Stars / Long exposure correctly; Scale and Depth of field separated the close-ups (otter, gull, bear) from the vistas as expected.

### Measured in code
Saturation ranged 0–96 across the album and brightness 3–70, so both sliders spread well. The palette put "neutral" in the top two for 16 of 20 photos; the 0.2 saturation cut-off for "neutral" could be lowered if blue skies and water should count as blue more often.

### Panoramas
A synthetic 7 : 1 strip was cut into 3 tiles (each 1467 × 571, within limits) and merged. Taking "present" from any tile made a few faint categories present that the whole image probably wouldn't (autumn foliage 0.59 from reddish slopes on one tile); averaging P(present) instead would be stricter but would miss things seen in only one tile.

## Tightening weak tags (2026-10-18)
Each wording was tested on all 20 photos (old and new wording in the same request) before re-tagging.
- **Moon, stars, aurora, rainbow:** the moon tag was a false Yes on a clear-sky kayak photo (P 0.73), most likely a sensor-dust spot. The wording now excludes dots, specks and dust spots, and these four tags need P(yes) ≥ 0.9 to count as Yes, because a false Yes stands out more than a missed one. The false moon dropped to 0.43–0.48 (unsure); the real moon stayed at 0.98–0.99, and the aurora and stars on the night shot stayed at 0.97–0.98.
- **Weather** went from six options to four (Clear, Cloudy, Fog / mist, Rain, snow or storm) plus Can't tell. The rainy sea, previously Fog / mist, is now Rain, snow or storm (0.59).
- **Reflections were removed.** Three wordings were tried:
  - "mirror-like": 0 Yes, 6 unsure
  - "reflects the sky's colours, the landscape or a subject": Yes on 15 of 17 water photos, so it meant little more than "has water"
  - "a recognisable mirrored shape; sky-tinted water doesn't count": 6 Yes, 7 unsure, and the red sunset reflection at 0.38

  None split the album cleanly.

## Sunrise / sunset replaces the light sliders (2026-10-18)
The **Sun position** and **Light quality** scales didn't sort the album usefully, so they were removed. The time of day is now one yes/no tag in Weather & sky, **Sunrise / sunset** ("Was `photo` taken around sunrise or sunset?"), which uses the same 0.9 bar as the other sky tags.

On the album, the clear sunrise and sunset skies scored 0.90–0.98. Several photos in warm, low side light (deer, marmot, gull, sea lions, wildfire smoke) scored 0.67–0.85. At the default 0.7 bar, 11 of 20 photos would have counted. At 0.9 the chip matches exactly the six photos with a sunrise or sunset sky, although the snowy forest with a pink horizon sits right on the line at 0.90.

## Night sky; water surface removed (2026-10-18)
- **Aurora, stars and moon are combined into one tag, Night sky:** "Does `photo` show a night sky?", meaning a dark sky with stars, the Milky Way, star trails, an aurora or the moon in it. Dust spots, specks, noise and lights don't count. It uses the 0.9 bar of the other sky tags. On the album it is Yes on exactly the moon shot and the aurora shot (both 0.99), and under 0.1 on every other photo.
- **Water surface removed.** It was "Rippled" on 15 of the 17 photos with water, so it didn't separate anything. The Water chip group now holds only Long exposure.
