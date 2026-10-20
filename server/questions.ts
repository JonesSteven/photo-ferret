import { box, choice, noul, type Questions, score } from "@typesafe-ai/sdk";
import { isNumericKind } from "../shared/gallery.ts";
import { type AttributeDef, COVER_LEVELS } from "../shared/types.ts";

// One source of truth for what Jev is asked and what is stored per photo. Coverage uses one Score per
// category ("Method A" in docs/jev-image-capabilities.md): each category is judged on its own, so totals
// can exceed 100%, and snow deliberately overlaps whatever it covers.

export interface CoverDef {
  id: string;
  label: string; // shown in the UI
  noun: string; // used inside the question and level text
  what: string; // full definition sent to Jev
  group: "surface";
}

export const COVERS: CoverDef[] = [
  // Surfaces: what the frame is made of.
  {
    id: "water",
    label: "Water",
    noun: "water",
    what: "any body of water — sea, ocean, lake, pond, river or stream — including its surface, reflections on it and underwater views; not waterfalls",
    group: "surface",
  },
  { id: "waterfall", label: "Waterfall", noun: "waterfall", what: "white water falling over a drop, such as a waterfall or cascade", group: "surface" },
  {
    id: "sky",
    label: "Sky",
    noun: "sky",
    what: "any sky — clear, cloudy, hazy, at sunset or at night — including clouds, the sun, the moon, stars and aurora",
    group: "surface",
  },
  {
    id: "forest",
    label: "Forest / trees",
    noun: "trees",
    what: "forest, woodland, tree canopy or individual trees and shrubs, including trees covered in snow, autumn trees and silhouetted trees; not small plants or flowers seen up close",
    group: "surface",
  },
  {
    id: "mountains",
    label: "Mountains",
    noun: "mountains",
    what: "mountains, peaks, ridges, hills and cliffs, including snow-covered ones; not boulders or beach stones",
    group: "surface",
  },
  {
    id: "snow",
    label: "Snow / ice",
    noun: "snow or ice",
    what: "snow or ice covering any surface — the ground, trees, mountains or rocks — plus glaciers and frozen water; count snow-covered trees and mountains as snow too",
    group: "surface",
  },
  {
    id: "autumn",
    label: "Autumn foliage",
    noun: "autumn foliage",
    what: "leaves that have turned red, orange, yellow or gold for autumn, on trees, shrubs or the ground; count trees in autumn colour as autumn foliage too",
    group: "surface",
  },
  {
    id: "rock",
    label: "Rock",
    noun: "bare rock",
    what: "bare rock seen up close or in the middle distance: boulders, outcrops, rock walls, cliff faces, scree and rocky ground; distant mountains count as mountains, not rock",
    group: "surface",
  },
  {
    id: "plants",
    label: "Flowers / plants",
    noun: "flowers and small plants",
    what: "flowers, wildflowers, ferns, moss, lichen, fungi and other small plants, seen up close or as a carpet; not trees, shrubs or ordinary grass",
    group: "surface",
  },
  { id: "shore", label: "Shore / beach", noun: "shore", what: "a beach or shoreline: sand, pebbles, cobbles, driftwood or tidal rocks at the water's edge", group: "surface" },
  { id: "meadow", label: "Meadow / grass", noun: "grass or meadow", what: "grassland, meadow, prairie, fields or low green or golden vegetation", group: "surface" },
  // Desert was matching wind-sculpted snow, beach sand, scree and dry grassland (23 photos, none deserts).
  {
    id: "desert",
    label: "Desert",
    noun: "desert",
    what: "arid desert land with little or no vegetation, such as sand dunes, desert scrub, salt flats or dry red-rock canyons; not snow drifts or wind-sculpted snow, beach or riverbank sand, scree, rocky mountain slopes or dry grassland",
    group: "surface",
  },
];

// Coverage levels describe situations; each maps in code to a rough share of the frame (COVER_LEVELS).
const coverLevels = (noun: string) => [
  `None: no ${noun} visible anywhere in the photo`,
  `A trace: ${noun} only as a small patch, a distant sliver, a thin line or a small figure; almost all of the frame is something else`,
  `A quarter: a clear band or area of ${noun}, roughly a quarter of the frame; most of the frame is something else`,
  `About half: ${noun} and other things share the frame about equally`,
  `Most of the frame: ${noun} everywhere except smaller areas of other things`,
  `Nearly all: ${noun} edge to edge across the frame, with little or nothing else visible`,
];

export interface MoodDef {
  id: string;
  label: string;
  instructions: string;
  levels: string[]; // full rubric sent to Jev, low to high
  short: string[]; // tick labels
}

export const MOODS: MoodDef[] = [
  {
    id: "sky_drama",
    label: "Sky drama",
    // Speculative premise: photos without sky answer the lowest level, and code then stores no value
    // (sky drama doesn't apply) when the sky coverage says no sky is present.
    instructions: "How dramatic is the sky in `photo`? If no sky is visible, choose the lowest level.",
    levels: [
      "Plain: clear uniform blue or flat featureless grey, or no sky visible",
      "Some ordinary clouds add a little interest, but the sky is not a focus",
      "Striking clouds, colour, mist or light rays make the sky a notable part of the picture",
      "The sky is spectacular and sets the mood: storm clouds, blazing sunset colours, aurora, rainbow or the Milky Way",
    ],
    short: ["Plain", "Some clouds", "Striking", "Spectacular"],
  },
  {
    id: "wildness",
    label: "Wildness",
    // People in these photos are usually the photographer's companion in remote places, so people and the
    // gear they carry or travel with are explicitly ignored; only the landscape's development counts.
    instructions:
      "How wild and undeveloped is the landscape in `photo`? Ignore any people and the gear they carry or travel with, such as packs, skis, kayaks, canoes and tents; judge only the place itself.",
    levels: [
      "Clearly developed: roads, buildings, towns, farms, power lines or vehicles are prominent",
      "Some development: a few buildings, a road, docks, moored boats or managed land are visible, but nature dominates",
      "Light traces only: a trail, fence, small bridge, signpost or a single distant structure",
      "No visible development: nothing built or managed can be seen, even if people are in the photo",
    ],
    short: ["Developed", "Some development", "Light traces", "No visible development"],
  },
];

// Look & composition: how the photo is built rather than what is in it.
export const LOOKS: MoodDef[] = [
  {
    id: "tonal_contrast",
    label: "Tonal contrast",
    instructions: "How wide is the range of brightness in `photo`, from its darkest areas to its brightest?",
    levels: [
      "Flat: low contrast with no deep shadows or bright highlights, as in fog, haze or soft overcast light",
      "Moderate: some contrast between lighter and darker areas, but no very deep shadows or very bright highlights",
      "High: both deep shadows and bright highlights are present in the same scene",
      "Extreme: a very bright light source such as the sun in the frame or strong backlight against very dark areas; highlights may be blown out or shadows pure black",
    ],
    short: ["Flat", "Moderate", "High", "Extreme"],
  },
  {
    id: "complexity",
    label: "Scene complexity",
    instructions: "How visually complex is the scene in `photo`?",
    levels: [
      "Minimal: a single subject against a plain or empty background",
      "Simple: a few clear elements and plenty of uncluttered space",
      "Busy: many elements, textures or details competing for attention",
      "Very complex: dense detail and clutter throughout the frame, with no single clear subject",
    ],
    short: ["Minimal", "Simple", "Busy", "Complex"],
  },
  {
    id: "straight_lines",
    label: "Straight lines",
    instructions:
      "How much do straight lines and geometric edges shape the picture in `photo`, such as horizons, tree trunks, buildings, fences, paddles, shorelines, sharp edges and blocky rocks?",
    levels: [
      "None: entirely organic, irregular shapes with no noticeable straight lines",
      "Slight: a horizon or one or two faint straight edges",
      "Clear: several distinct straight lines that are part of the composition",
      "Dominant: strong straight lines or geometric structure define the composition",
    ],
    short: ["None", "A few", "Prominent", "Dominant"],
  },
  {
    id: "curvy_lines",
    label: "Curvy lines",
    instructions:
      "How much do curves, arcs and flowing lines shape the picture in `photo`, such as winding rivers, waves, dunes, curved branches, cloud swirls or animal outlines?",
    levels: [
      "None: no noticeable curves or flowing lines",
      "Slight: a few gentle curves",
      "Clear: prominent curves that are part of the composition",
      "Dominant: sweeping, flowing curves define the composition",
    ],
    short: ["None", "A few", "Prominent", "Dominant"],
  },
  {
    id: "scale",
    label: "Scale",
    instructions: "How close is the camera to its subject in `photo`, and how wide is the view?",
    levels: [
      "Macro: an extreme close-up of something small, such as an insect, a flower, frost crystals or a rock texture, filling the frame",
      "Close-up: a single plant, animal, person or small detail of the landscape, seen from a few metres away",
      "Landscape: an ordinary view of a scene, such as a stretch of shore, a forest clearing or a lake and its far bank",
      "Grand vista or aerial: a sweeping view over a great distance, such as a mountain range or a wide valley, or a view from the air",
    ],
    short: ["Macro", "Close-up", "Landscape", "Vista"],
  },
  {
    id: "depth_of_field",
    label: "Depth of field",
    instructions: "How much of `photo` is in sharp focus?",
    levels: [
      "Deep focus: everything from the nearest foreground to the far distance is sharp",
      "Mostly sharp: the nearest foreground or the far background is slightly soft",
      "Shallow: the subject is sharp and the background is clearly blurred",
      "Very shallow: only a thin slice is sharp and the rest dissolves into a smooth blur (bokeh)",
    ],
    short: ["Deep", "Mostly sharp", "Shallow", "Bokeh"],
  },
];

// One overall judgment, not a mix of aspects: a separate sharpness aspect would penalise deliberate
// softness. A club judge for keen amateurs rather than a magazine editor choosing a cover, which favoured
// grand vistas over well-made close-ups and abstracts, and level texts about the photo rather than how
// ordinary the subject is (jev-image-album-description.md). Any change to these texts needs a forced
// re-score (npm run score-quality -- --force).
export const QUALITY: MoodDef = {
  id: "quality",
  label: "Quality",
  instructions:
    "You are an experienced judge at a nature photography club competition for keen amateur photographers. How highly do you rate `photo`? Judge it as a photograph, on its own terms: reward strong design (pattern, texture, line, shape, rhythm, light and shadow) in close-ups, details, minimal and abstract photos as much as a grand view. Weigh technical quality (focus, exposure, noise), composition, light, and how interesting or memorable the photo is. Soft or blurred areas count against the photo only if they look accidental, not when they are a deliberate choice such as a shallow depth of field or motion blur.",
  levels: [
    "Unusable: an accidental shot, or badly blurred or badly exposed",
    "Poor: obvious technical faults, or no clear subject or idea",
    "Snapshot: technically acceptable, but little care over composition or light",
    "Decent: a competent, pleasant photo that is unremarkable",
    "Good: well made, with a clear subject or idea and a pleasing composition",
    "Strong: appealing light, composition, design or moment",
    "Great: striking and memorable; an award contender",
    "Excellent: outstanding; a winning photo",
  ],
  short: ["Unusable", "Poor", "Snapshot", "Decent", "Good", "Strong", "Great", "Excellent"],
};
export const QUALITY_QUESTION_ID = "quality";

// Colour diversity is asked of Jev; vividness is measured separately in code (saturation).
export const COLOUR_SCALES: MoodDef[] = [
  {
    id: "colour_diversity",
    label: "Colour diversity",
    instructions: "How many distinct hues appear in `photo`? Count different colours, not how vivid they are.",
    levels: [
      "One hue: a single colour family, or black and white, as in fog, a night sky or a one-colour scene",
      "Few: two or three closely related hues",
      "Several: several distinct hues",
      "Many: many distinct hues from around the colour wheel",
    ],
    short: ["One hue", "Few", "Several", "Many"],
  },
];

// Yes/no tags for living subjects: a small bird or a distant hiker matters even when it fills little of
// the frame, so these are Nouls (is it there?) rather than coverage Scores.
export interface PresenceDef {
  id: string; // attribute id
  questionId: string;
  label: string; // tag name
  boxLabel: string; // label on its box: singular, since Jev outlines only one of them
  question: string;
  yes: string;
  no: string;
  box: string; // what the speculative Box question looks for
  closeLook?: false; // no second look on tiles (see the entries below for why)
  yesMin?: number; // stricter bar for "yes" than YES_MIN in jev.ts
  closeLookYesMin?: number; // stricter bar for "yes" from the close look
}

// The close look reads specks as subjects. Birds: tiny distant specks and dark dots on waves got through
// that way (first look 0.35–0.51, then 0.72–0.92 on a tile), while real birds in the album all scored
// 0.92+ on the first look, so birds need 0.85 on the first look and get no close look. Wildlife: every
// photo the close look turned into "yes" was a flower. People: trees on a snow slope scored 0.75 on a
// tile, a real hiker by a tent 0.91. Vehicles: every close-look "yes" was a distant speck or nothing.
const BIRD_YES_MIN = 0.85;
const PERSON_CLOSE_LOOK_YES_MIN = 0.85;
// Insects are only tagged as a main subject, and a false one stands out.
const INSECT_YES_MIN = 0.85;
const STRUCTURE_YES_MIN = 0.8;

export const PRESENCE: PresenceDef[] = [
  {
    id: "person",
    questionId: "person_present",
    label: "People",
    boxLabel: "Person",
    question: "Is there a person visible anywhere in `photo`?",
    yes: "At least one human is clearly recognisable as a person, even if small or distant: a head, body and limbs can be made out, including silhouettes, people in boats and clearly visible partial bodies",
    no: "No human can be clearly recognised; dark specks, trees, rocks, posts or shadows that only might be a person do not count, and neither do animals, statues, buildings, tents or vehicles alone",
    box: "the most prominent person in `photo`",
    closeLookYesMin: PERSON_CLOSE_LOOK_YES_MIN,
  },
  {
    id: "wildlife",
    questionId: "wildlife_present",
    label: "Wildlife",
    boxLabel: "Wild animal",
    question: "Is there a wild animal other than a bird or an insect visible anywhere in `photo`?",
    yes: "At least one wild animal that is not a bird, insect or spider is clearly visible: a mammal, reptile, amphibian, fish, jellyfish, sea star or other sea life",
    no: "No such animal is visible; birds, insects, spiders, people, pets and farm animals do not count, and neither do flowers, plants or specks that only might be an animal",
    box: "the most prominent wild animal that is not a bird, insect or spider in `photo`",
    closeLook: false,
  },
  {
    id: "birds",
    questionId: "birds_present",
    label: "Birds",
    boxLabel: "Bird",
    question: "Is there a bird visible anywhere in `photo`?",
    yes: "At least one bird is visible, however small or distant: flying, perched, wading or on the water",
    no: "No birds are visible; other animals, insects and people do not count",
    box: "the most prominent bird in `photo`",
    closeLook: false,
    yesMin: BIRD_YES_MIN,
  },
  {
    id: "insect",
    questionId: "insect_subject",
    label: "Insects",
    boxLabel: "Insect",
    question: "Is an insect or spider a main subject of `photo`, large and clearly visible?",
    yes: "An insect or spider, such as a bee, butterfly, moth, dragonfly, beetle or spider, is a main subject: large in the frame, with its body, legs or wings clearly visible",
    no: "No insect or spider is a main subject; small insects on a flower or leaf, distant specks and insects that take up only a tiny part of the frame do not count",
    box: "the most prominent insect or spider in `photo`",
    closeLook: false, // the tag is for insects that are large in the whole photo
    yesMin: INSECT_YES_MIN,
  },
  {
    id: "vehicle",
    questionId: "vehicle_present",
    label: "Vehicles",
    boxLabel: "Vehicle",
    question: "Is there a vehicle visible anywhere in `photo`?",
    yes: "At least one vehicle is clearly visible: a car, truck, bus, train, plane, helicopter, motorcycle, bicycle, motorboat, ferry, ship, kayak or canoe",
    no: "No vehicles are visible; paddleboards, skis and sleds do not count, and neither do roads or contrails alone",
    box: "the most prominent vehicle in `photo`",
    closeLook: false, // the close look turned boat specks and an empty sunset beach into "yes"
  },
  {
    id: "flower",
    questionId: "flower_subject",
    label: "Flowers",
    boxLabel: "Flower",
    question: "Is a flower, or a small group of flowers, the main subject of `photo`?",
    yes: "One or a few flowers are the clear focus of the photo, usually seen up close and filling much of the frame",
    no: "No flower is the main subject; small flowers in the background, scattered wildflowers or a whole meadow of flowers do not count",
    box: "the main flower in `photo`",
    closeLook: false, // a tile can make a background flower look like the subject
  },
  // Tents and structures were read from their coverage answers at first; structures that way tagged
  // tents, kayaks, roads and plain wilderness, so both are questions of their own now (and get a box).
  {
    id: "tent",
    questionId: "tent_present",
    label: "Tents",
    boxLabel: "Tent",
    question: "Is there a tent visible anywhere in `photo`?",
    yes: "At least one tent, tarp shelter or bivy is clearly visible, even if small or distant",
    no: "No tents are visible; cabins, huts, umbrellas, sleeping bags, packs and gear piles do not count, and neither do rocks or bright patches that only might be a tent",
    box: "the most prominent tent in `photo`",
    closeLook: false,
  },
  {
    id: "structure",
    questionId: "structure_present",
    label: "Structures",
    boxLabel: "Structure",
    question: "Is there a built structure visible anywhere in `photo`?",
    yes: "At least one thing people have built is clearly visible: a building, house, cabin, hut, lookout, skyscraper or city skyline, bridge, dock, pier, lighthouse, tower, dam, fence, sign, bench or picnic table",
    no: "Nothing built is visible; tents, tarps, boats, kayaks, vehicles, people's gear, roads, trails and paths do not count, and neither do natural features such as rocks, cliffs, logs, trees, smoke or animals",
    box: "the most prominent built structure in `photo`",
    closeLook: false,
    // Only structures a person sees at a glance: a hut half-buried in snow, a tarp on a far slope, fence
    // posts and a lit window at night scored 0.75–0.78; clear cabins, bridges and boardwalks 0.84+.
    yesMin: STRUCTURE_YES_MIN,
  },
];

// Other yes/no tags. `requires` is a speculative premise: the question is always asked (the image is
// billed once), and code keeps the answer only when that presence tag came out "true".
export interface FlagDef {
  id: string;
  label: string;
  group: "sky" | "activity";
  question: string;
  yes: string;
  no: string;
  requires?: "person";
  yesMin?: number; // stricter bar for "yes" than YES_MIN in jev.ts, for rare tags where false positives stand out
  excludes?: string; // a flag that can't also be "true": if both come out yes, the less likely one becomes unsure
}

// Sky features need a stricter "yes": a false one (a dust spot read as the moon or a star, any warm
// light read as sunset) is worse than a missed one.
const RARE_YES_MIN = 0.9;

// `notCounted` names look-alikes that belong to another activity, added to the "no" criterion.
const activity = (id: string, label: string, doing: string, examples: string, extra: { notCounted?: string; excludes?: string } = {}): FlagDef => ({
  id: `act_${id}`,
  label,
  group: "activity",
  question: `If there is a person in \`photo\`, are they ${doing}?`,
  yes: `A person in the photo is ${doing}: ${examples}`,
  no: `No person in the photo is ${doing}, or no person is visible${extra.notCounted ? `; ${extra.notCounted}` : ""}`,
  requires: "person",
  ...(extra.excludes ? { excludes: `act_${extra.excludes}` } : {}),
});

export const FLAGS: FlagDef[] = [
  {
    id: "sunset",
    label: "Sunrise / sunset",
    group: "sky",
    question: "Was `photo` taken around sunrise or sunset?",
    yes: "The sun is low at or near the horizon, or the sky or light glows orange, pink, red or gold from a rising or setting sun, including the minutes just before sunrise and after sunset",
    no: "Daytime with the sun well above the horizon, full night, or warm colours that come from something else, such as autumn leaves, fire, smoke or artificial light",
    yesMin: RARE_YES_MIN,
  },
  {
    id: "night_sky",
    label: "Night sky",
    group: "sky",
    question: "Does `photo` show a night sky?",
    yes: "A dark night sky with stars, the Milky Way, star trails, an aurora or the moon clearly visible in it",
    no: "Not a night sky: daytime, sunset or twilight with no stars, or a dark sky with nothing in it. Dust spots, specks, image noise and lights do not count as stars or the moon",
    yesMin: RARE_YES_MIN,
  },
  {
    id: "rainbow",
    label: "Rainbow",
    group: "sky",
    question: "Is a rainbow visible in `photo`?",
    yes: "A rainbow or a clear part of one is visible, including in waterfall spray",
    no: "No rainbow; lens flare, sunset colours, coloured clouds and colour fringes do not count",
    yesMin: RARE_YES_MIN,
  },
  // Hiking and skiing split on what's on the person's feet: someone going uphill in snow with poles fitted
  // both, and 7 photos came out as both. They also exclude each other in code (`excludes`).
  activity(
    "hiking",
    "Hiking",
    "hiking or walking on foot",
    "on a trail, on a summit, over open ground or up snow on foot (bootpacking), without skis, a snowboard or snowshoes on their feet, usually with a pack or poles",
    { notCounted: "people on skis, a snowboard or snowshoes count as skiing, not hiking", excludes: "skiing" },
  ),
  activity(
    "skiing",
    "Skiing",
    "skiing, snowboarding or snowshoeing",
    "travelling over snow on skis, a snowboard or snowshoes, including ski touring uphill, or carrying skis or a board",
    { notCounted: "people walking or bootpacking in snow on foot, without skis, a board or snowshoes, count as hiking, not skiing", excludes: "hiking" },
  ),
  activity("paddling", "Paddling", "paddling", "in or with a kayak, canoe, paddleboard or rowing boat"),
  activity("climbing", "Climbing", "climbing", "rock climbing, ice climbing or scrambling up steep terrain with hands"),
  activity("cycling", "Cycling", "cycling", "riding or pushing a bicycle"),
  activity("camping", "Camping", "camping", "at a tent or campsite, by a campfire or cooking outdoors"),
];

// Single-answer categories. Options with `missing` store no value (unknown or not applicable). A `dropped`
// option is still asked (so the other options' probabilities are unchanged) but never stored: a photo where
// it wins gets the most likely remaining option instead.
export interface ChoiceDef {
  id: string;
  label: string;
  group: "sky";
  question: string;
  options: { id: string; label: string; what: string; missing?: boolean; dropped?: boolean }[];
  requires?: string; // a coverage id that must be present, else no value is stored
}

export const CHOICES: ChoiceDef[] = [
  {
    id: "weather",
    label: "Weather",
    group: "sky",
    question: "What is the weather like in `photo`?",
    options: [
      { id: "clear", label: "Clear", what: "a blue or starry sky with few or no clouds" },
      { id: "cloudy", label: "Cloudy", what: "clouds cover part or all of the sky, with no fog, rain or snow" },
      { id: "fog", label: "Fog / mist", what: "fog, mist, low cloud or haze softens or hides parts of the scene" },
      // Dropped: it was mostly snow lying on the ground, frost and droplets on close-ups (3 right out of 16).
      { id: "precipitation", label: "Rain, snow or storm", what: "falling rain, snow or sleet, raindrops on the water, or dark storm clouds", dropped: true },
      { id: "unknown", label: "Can't tell", what: "no sky is visible and the weather can't be judged", missing: true },
    ],
  },
];

// Primary subject: broader groups than the coverage sliders and "In the photo" tags, worded on their own so
// it answers a different question (what the eye goes to) rather than repeating those lists.
const PRIMARY_OPTIONS = [
  { id: "water", label: "Water", what: "any body of water — sea, ocean, lake, pond, river or stream — with its shoreline or beach, and waterfalls, rapids and cascades" },
  { id: "meadow_forest", label: "Meadows, grasslands and forests", what: "meadows, grassland, prairie, fields, forest, woodland or trees, including snowy and autumn forest, and deserts: sand dunes, desert scrub and arid canyons" },
  { id: "mountains", label: "Mountains", what: "mountains, peaks, ridges, hills, cliffs and rock faces, including snow-covered peaks, glaciers and snowfields" },
  { id: "sky", label: "Sky", what: "the sky itself: clouds, a sunset or sunrise, the sun, the moon, stars or an aurora" },
  { id: "plants", label: "Plants", what: "flowers, ferns, moss, lichen, fungi or other small plants, usually seen up close" },
  { id: "wildlife", label: "Wildlife", what: "wild animals of any kind: mammals, birds, reptiles, amphibians, fish, insects, spiders and sea life" },
  { id: "people", label: "People", what: "one or more people, such as hikers, skiers, climbers or paddlers" },
  { id: "structures", label: "Structures and tents", what: "anything people have built, such as buildings, cabins, huts, bridges, docks, towers, fences or benches, and tents, tarps or other camping shelters" },
  { id: "vehicle", label: "Vehicles", what: "vehicles such as cars, trucks, trains, planes, helicopters, boats, kayaks, canoes and bicycles" },
  { id: "other", label: "Other", what: "something else, such as snow or ice seen up close, an object, a texture or an abstract pattern" },
];

export const coverQuestionId = (id: string) => `cover_${id}`;
export const moodQuestionId = (id: string) => `mood_${id}`;
export const lookQuestionId = (id: string) => `look_${id}`;
export const boxQuestionId = (id: string) => `${id}_box`;
export const flagQuestionId = (id: string) => `flag_${id}`;
export const choiceQuestionId = (id: string) => `choice_${id}`;

// All questions share the one image in `state.photo`, so it is sent and billed once.
export function buildQuestions(): Questions {
  const questions: Questions = {
    primary_scene: choice(
      "What is the visual focal subject of the nature photo in `photo`: the thing the eye is drawn to, which is not necessarily the largest area?",
      Object.fromEntries(PRIMARY_OPTIONS.map((o) => [o.id, `${o.label}: ${o.what}`])),
    ),
  };
  for (const p of PRESENCE) {
    questions[p.questionId] = noul(p.question, { true: p.yes, false: p.no });
    // Speculative: Box always returns a box, so code keeps it only when the presence tag is "true".
    questions[boxQuestionId(p.id)] = box(p.box);
  }
  for (const c of COVERS) {
    questions[coverQuestionId(c.id)] = score(
      `How much of the area of \`photo\` is covered by ${c.noun}, meaning ${c.what}? Count only areas that are clearly ${c.noun}; similar-looking things do not count.`,
      coverLevels(c.noun),
    );
  }
  for (const m of MOODS) questions[moodQuestionId(m.id)] = score(m.instructions, m.levels);
  for (const l of [...LOOKS, ...COLOUR_SCALES]) questions[lookQuestionId(l.id)] = score(l.instructions, l.levels);
  questions[QUALITY_QUESTION_ID] = score(QUALITY.instructions, QUALITY.levels);
  for (const f of FLAGS) questions[flagQuestionId(f.id)] = noul(f.question, { true: f.yes, false: f.no });
  for (const c of CHOICES) {
    questions[choiceQuestionId(c.id)] = choice(c.question, Object.fromEntries(c.options.map((o) => [o.id, `${o.label}: ${o.what}`])));
  }
  return questions;
}

// Expected share of the frame (0–100) from the level probabilities.
export function coverPercent(probabilities: number[]) {
  return probabilities.reduce((sum, p, i) => sum + p * (COVER_LEVELS[i]?.share ?? 0), 0);
}

// The metadata stored per photo. Adding a future kind of metadata means adding a question and an entry
// here; the database, filters and admin UI follow automatically.
const scaleDef = (m: MoodDef, group: AttributeDef["group"]): AttributeDef => ({
  id: m.id,
  label: m.label,
  kind: "scale",
  group,
  source: "jev",
  ends: [m.short[0]!, m.short.at(-1)!],
  levels: m.short,
});

// Colour families for the palette, measured in code (storage.ts pixelPalette).
export const PALETTE = [
  { id: "red", label: "Red", swatch: "#c8402f" },
  { id: "orange", label: "Orange", swatch: "#e0832f" },
  { id: "yellow", label: "Yellow", swatch: "#e2c03a" },
  { id: "green", label: "Green", swatch: "#4f9a45" },
  { id: "teal", label: "Teal", swatch: "#2f9a95" },
  { id: "blue", label: "Blue", swatch: "#3a6fc4" },
  { id: "purple", label: "Purple", swatch: "#7a4fb8" },
  { id: "pink", label: "Pink", swatch: "#d45c9a" },
  { id: "neutral", label: "Neutral", swatch: "#8a8a86" },
];

// The metadata stored per photo. Adding a future kind of metadata means adding a question and an entry
// here; the database, filters and admin UI follow automatically.
export const ATTRIBUTES: AttributeDef[] = [
  ...COVERS.map(
    (c): AttributeDef => ({
      id: coverQuestionId(c.id),
      label: c.label,
      kind: "percent",
      group: c.group,
      source: "jev",
      levels: COVER_LEVELS.map((l) => l.label),
    }),
  ),
  ...MOODS.map((m) => scaleDef(m, "mood")),
  ...COLOUR_SCALES.map((m) => scaleDef(m, "colour")),
  {
    id: "warmth",
    label: "Colour warmth",
    kind: "scale",
    group: "colour",
    source: "computed", // measured from the pixels (see storage.ts pixelWarmth); Jev agreed at r = 0.91
    ends: ["Cool", "Warm"],
    levels: ["Cool", "Neutral", "Warm"],
  },
  {
    id: "saturation",
    label: "Saturation",
    kind: "scale",
    group: "colour",
    source: "computed", // mean HSV saturation (storage.ts pixelSaturation)
    ends: ["Muted", "Vivid"],
    levels: ["Muted", "Moderate", "Vivid"],
  },
  {
    id: "brightness",
    label: "Brightness",
    kind: "scale",
    group: "colour",
    source: "computed", // mean luminance (storage.ts pixelBrightness)
    ends: ["Low-key", "High-key"],
    levels: ["Low-key", "Mid", "High-key"],
  },
  {
    id: "palette",
    label: "Palette",
    kind: "multi",
    group: "colour",
    source: "computed", // the one or two most common colour families (storage.ts pixelPalette)
    options: PALETTE,
  },
  {
    id: "main_hue",
    label: "Main colour",
    kind: "scale",
    group: "colour",
    source: "computed", // hue of the colour family covering the most pixels (storage.ts pixelMainHue); colour picker
    adminOnly: true,
    ends: ["Red", "Pink"],
    levels: ["Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Pink"],
  },
  scaleDef(QUALITY, "look"), // the first Look & composition slider; 1–100, not 0–100 (see jev.ts qualityValue)
  ...LOOKS.map((l) => scaleDef(l, "look")),
  {
    id: "primary_scene",
    label: "Primary subject",
    kind: "choice",
    group: "primary",
    source: "jev",
    options: PRIMARY_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
  },
  // Listed with vehicles after tents (the Jev questions keep PRESENCE's order).
  ...[...PRESENCE.filter((p) => p.id !== "vehicle" && p.id !== "structure"), ...PRESENCE.filter((p) => p.id === "vehicle" || p.id === "structure")].map((p): AttributeDef => ({ id: p.id, label: p.label, kind: "boolean", group: "presence", source: "jev" })),
  ...FLAGS.map((f): AttributeDef => ({ id: f.id, label: f.label, kind: "boolean", group: f.group, source: "jev" })),
  ...CHOICES.map(
    (c): AttributeDef => ({
      id: c.id,
      label: c.label,
      kind: "choice",
      group: c.group,
      source: "jev",
      options: c.options.filter((o) => !o.missing && !o.dropped).map((o) => ({ id: o.id, label: o.label })),
    }),
  ),
];

export const ATTRIBUTE_IDS = new Set(ATTRIBUTES.map((a) => a.id));

export { isNumericKind };

export function isValidAttributeValue(attr: string, value: string) {
  const def = ATTRIBUTES.find((a) => a.id === attr);
  if (!def) return false;
  if (isNumericKind(def.kind)) {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) && n >= (attr === QUALITY.id ? 1 : 0) && n <= 100;
  }
  if (def.kind === "boolean") return value === "true" || value === "false"; // admins can't set "uncertain"
  if (def.kind === "multi") {
    const ids = value.split(",");
    return ids.length >= 1 && ids.length <= 2 && ids.every((id) => def.options?.some((o) => o.id === id));
  }
  return Boolean(def.options?.some((o) => o.id === value));
}
