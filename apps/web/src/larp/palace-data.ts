import { PalaceEntrySchema } from "@noctis/contracts";
import type { PalaceEntry } from "@noctis/contracts";

const id = (number: number) => `01a05c32-8000-7000-8000-${String(number).padStart(12, "0")}`;

const books = [
  ["White Nights", "Fyodor Dostoevsky"],
  ["Dune", "Frank Herbert"],
  ["Tuesdays with Morrie", "Mitch Albom"],
  ["The Alchemist", "Paulo Coelho"],
  ["Man’s Search for Meaning", "Viktor E. Frankl"],
  ["The Courage to Be Disliked", "Ichiro Kishimi & Fumitake Koga"],
  ["Psycho-Cybernetics", "Maxwell Maltz"],
  ["Five Dialogues", "Plato"],
  ["Crime and Punishment", "Fyodor Dostoevsky"],
  ["The Untethered Soul", "Michael A. Singer"],
  ["This Will Make You Smarter", "John Brockman"],
  ["Thinking, Fast and Slow", "Daniel Kahneman"],
  ["The Idiot", "Fyodor Dostoevsky"],
  ["Man and His Symbols", "Carl Jung"],
  ["Breaking the Habit of Being Yourself", "Joe Dispenza"],
  ["Wired differently", ""],
  ["Meditations", "Marcus Aurelius"],
  ["The Daily Stoic", "Ryan Holiday & Stephen Hanselman"],
  ["The creative act: a way of being", ""],
  ["Emotional alchemy", ""],
  ["The art of spending money", ""],
  ["Walden", "Henry David Thoreau"],
  ["The Notebooks of Leonardo da Vinci", "Leonardo da Vinci"],
  ["The Picture of Dorian Gray", "Oscar Wilde"],
  ["Frankenstein", "Mary Shelley"],
  ["Alice’s Adventures in Wonderland", "Lewis Carroll"],
  ["Pride and Prejudice", "Jane Austen"],
  ["Jane Eyre", "Charlotte Brontë"],
  ["The Time Machine", "H. G. Wells"],
  ["Flatland", "Edwin A. Abbott"],
] as const;

const sources: Record<string, { url: string; excerpts: readonly string[] }> = {
  Meditations: {
    url: "https://www.gutenberg.org/cache/epub/2680/pg2680-images.html",
    excerpts: [
      "Look within; within is the fountain of all good.",
      "Cast away from thee opinion, and thou art safe.",
      "Remember that all is but opinion",
    ],
  },
  Walden: {
    url: "https://www.gutenberg.org/cache/epub/205/pg205-images.html",
    excerpts: [
      "Simplify, simplify.",
      "Things do not change; we change.",
      "Heaven is under our feet as well as over our heads.",
      "Our life is frittered away",
    ],
  },
  "The Notebooks of Leonardo da Vinci": {
    url: "https://www.gutenberg.org/cache/epub/5000/pg5000.html",
    excerpts: [
      "And if you call painting dumb poetry, the painter may call poetry blind painting.",
      "pure and simple experience",
      "iron rusts unless it is used",
    ],
  },
  "The Picture of Dorian Gray": {
    url: "https://www.gutenberg.org/cache/epub/174/pg174-images.html",
    excerpts: [
      "The artist is the creator of beautiful things.",
      "All art is quite useless.",
      "To reveal art and conceal the artist is art’s aim.",
    ],
  },
  Frankenstein: {
    url: "https://www.gutenberg.org/cache/epub/84/pg84-images.html",
    excerpts: [
      "Nothing is so painful to the human mind as a great and sudden change.",
      "I ought to be thy Adam",
      "I am fearless",
    ],
  },
  "Alice’s Adventures in Wonderland": {
    url: "https://www.gutenberg.org/cache/epub/11/pg11-images.html",
    excerpts: [
      "we’re all mad here.",
      "Curiouser and curiouser!",
      "Who in the world am I? Ah, that’s the great puzzle!",
      "Begin at the beginning",
    ],
  },
  "Pride and Prejudice": {
    url: "https://www.gutenberg.org/cache/epub/1342/pg1342-images.html",
    excerpts: [
      "I dearly love a laugh.",
      "Till this moment, I never knew myself.",
      "For what do we live, but to make sport for our neighbours",
    ],
  },
  "Jane Eyre": {
    url: "https://www.gutenberg.org/cache/epub/1260/pg1260-images.html",
    excerpts: [
      "I am no bird; and no net ensnares me",
      "I would always rather be happy than dignified",
      "Life appears to me too short",
    ],
  },
  "The Time Machine": {
    url: "https://www.gutenberg.org/cache/epub/35/pg35-images.html",
    excerpts: [
      "We are always getting away from the present moment.",
      "Strength is the outcome of need",
      "It sounds plausible enough tonight",
    ],
  },
  Flatland: {
    url: "https://www.gutenberg.org/cache/epub/201/pg201-images.html",
    excerpts: [
      "Upward, not Northward",
      "to be self-contented is to be vile and ignorant",
      "Either this is madness or it is Hell.",
    ],
  },
};

const thoughts = [
  [
    "The second sketch",
    "Keep the first sketch beside the second. The distance between them tells you what your eye has learned.",
    "practice",
  ],
  [
    "A useful pause",
    "Leave a little time between making an image and judging it. A fresh look often finds the simplest edit.",
    "attention",
  ],
  [
    "Edges of a map",
    "Draw a map of a place using only the things you noticed on foot. Let the gaps stay visible.",
    "perspective",
  ],
  [
    "Small revisions",
    "Move one sentence, crop one edge, remove one sound. Small changes can alter the rhythm of a whole piece.",
    "editing",
  ],
  [
    "Room for questions",
    "Keep a page for questions that are interesting before they have answers.",
    "curiosity",
  ],
  [
    "Windows at dusk",
    "A window carries the street and a faint reflection of the room at the same time. Which picture do you notice first?",
    "photography",
  ],
  [
    "A slower route",
    "Walk the same route at a different hour. Collect the details that the first journey missed.",
    "attention",
  ],
  [
    "Margins",
    "Empty space gives a page its pace. Try enlarging the margins before adding another element.",
    "design",
  ],
  [
    "A shelf of beginnings",
    "Keep unfinished starts with a short note about what made each one worth beginning.",
    "practice",
  ],
  [
    "Patterns in rain",
    "Watch how one street light becomes a hundred broken lines on wet pavement.",
    "light",
  ],
  [
    "Changing the frame",
    "Photograph the same subject with more space above, below, then to one side. Compare how its story changes.",
    "composition",
  ],
  [
    "Returning to a page",
    "A familiar page can meet a different question each time you open it.",
    "reading",
  ],
  [
    "Drawing a system",
    "Sketch a software system as a physical room. Decide what deserves a door and what should share a table.",
    "systems",
  ],
  [
    "Colour from a walk",
    "Choose five colours from one ordinary walk and build an image using only that palette.",
    "colour",
  ],
  [
    "Sound before picture",
    "Listen to a scene before filming it. Let the sound suggest where the first cut belongs.",
    "film",
  ],
  [
    "The useful mistake",
    "Keep an accidental mark and make the next ten marks answer it.",
    "drawing",
  ],
  [
    "An object in time",
    "Draw one object at different stages of use. Let wear become part of its portrait.",
    "observation",
  ],
  [
    "A physical bookmark",
    "Write a question on the bookmark before closing the book. Start there when you return.",
    "reading",
  ],
  [
    "Showing the process",
    "A contact sheet or a discarded sketch can explain a decision that the finished work hides.",
    "making",
  ],
  [
    "One rule for a day",
    "Choose a constraint for a day of making: one lens, one brush, one typeface. Notice the choices it opens up.",
    "practice",
  ],
] as const;

const art = [
  [
    "Paper observatory",
    "Build a folded paper room with a skylight. Photograph the drawing inside as daylight crosses it.",
    "light",
  ],
  [
    "Tide marks",
    "Layer translucent sheets so their overlapping edges resemble a changing shoreline.",
    "material",
  ],
  ["Moving shadows", "Make a mobile whose shadows form a second composition on the wall.", "light"],
  [
    "A city in reflections",
    "Create a photo sequence using only reflections in windows, puddles and polished metal.",
    "photography",
  ],
  [
    "One frame, four seasons",
    "Keep the camera position fixed and rebuild the same tiny scene with a different seasonal palette.",
    "film",
  ],
  [
    "An atlas of ordinary objects",
    "Draw household objects as islands. Use scratches and seams as the map's contours.",
    "drawing",
  ],
  [
    "Colour after sound",
    "Translate a short field recording into a strip of colour, then animate the strip to its rhythm.",
    "motion",
  ],
  [
    "A portrait in negative space",
    "Build a portrait entirely from the shapes around its subject.",
    "composition",
  ],
  [
    "A page that unfolds",
    "Create a foldout print that reveals a wider scene with each opening.",
    "print",
  ],
  [
    "A diagram with weather",
    "Draw a software architecture as a weather map, with traffic shown as moving fronts.",
    "systems",
  ],
  [
    "The contact sheet",
    "Take twelve frames of one small action. Present every frame so the viewer can choose the decisive moment.",
    "photography",
  ],
  [
    "A room made of type",
    "Construct an interior using letterforms as furniture, doors and windows.",
    "typography",
  ],
  [
    "Two clocks",
    "Edit a film with one slow visual rhythm and a faster sound rhythm. Let them meet at the last frame.",
    "film",
  ],
  [
    "A drawing in layers",
    "Separate a drawing into transparent layers that align into a different image when rotated.",
    "material",
  ],
  [
    "Night palette",
    "Paint a street at night using the colours found in its artificial lights.",
    "colour",
  ],
  [
    "A field guide to shadows",
    "Photograph shadows as if they were species. Give each a small observational sketch.",
    "photography",
  ],
  [
    "A cover without a title",
    "Design a book cover that communicates its mood through scale, texture and spacing alone.",
    "design",
  ],
  [
    "The impossible staircase",
    "Storyboard a short journey through a building whose rooms change scale between cuts.",
    "storyboard",
  ],
  [
    "A woven city",
    "Weave strips of two photographs together, combining the same street from opposite directions.",
    "collage",
  ],
  [
    "The worn surface",
    "Make a digital brush library from photographs of scuffed paint, paper fibres and worn stone.",
    "digital art",
  ],
  [
    "A small kinetic book",
    "Build a flipbook from the changing shape of a shadow across one page.",
    "motion",
  ],
  [
    "A gallery of pauses",
    "Make a short film entirely from moments just before or after an action.",
    "film",
  ],
  [
    "A walk as a score",
    "Turn a walking route into a graphic score. Use stops, turns and crossings as musical instructions.",
    "drawing",
  ],
  [
    "The colour of distance",
    "Paint the same scene at different depths of haze, letting contrast describe distance.",
    "painting",
  ],
  [
    "A book of thresholds",
    "Collect photographs of doorways and pair them with drawings of the spaces they suggest.",
    "photography",
  ],
  [
    "The changing poster",
    "Layer a print behind a striped mask. Sliding the mask reveals a second composition.",
    "print",
  ],
  [
    "A useful fiction",
    "Design the interface for an imaginary instrument that measures curiosity. Make every control understandable.",
    "design",
  ],
  [
    "A place remembered",
    "Draw a public place from memory, then visit it and draw only the details you forgot.",
    "perspective",
  ],
] as const;

export function makePalaceEntries(): PalaceEntry[] {
  const at = new Date().toISOString();
  const base = {
    createdAt: at,
    updatedAt: at,
    tags: [],
    sensitive: false,
    archived: false,
    connections: [],
    contentHash: "0".repeat(64),
  };
  const quotes = Object.entries(sources).flatMap(([title, source]) =>
    source.excerpts.map((body) => ({
      body,
      book: books.findIndex(([name]) => name === title) + 101,
    })),
  );
  return [
    ...thoughts.map(([title, body, tag], index) =>
      PalaceEntrySchema.parse({
        ...base,
        id: id(index + 1),
        kind: "thought",
        title,
        body,
        tags: [tag],
      }),
    ),
    ...books.map(([title, author], index) =>
      PalaceEntrySchema.parse({
        ...base,
        id: id(index + 101),
        kind: "book",
        title,
        ...(author === "" ? {} : { author }),
        readingLane: index >= 16 && index <= 20 ? "Alongside" : "Main",
        body:
          sources[title] === undefined
            ? "Sample notebook. Add a passage, a question or a visual response here."
            : `Sample notebook. Short excerpts are linked to this book.\n\nSource edition: ${sources[title].url}${title === "Meditations" ? "\nTranslation: Meric Casaubon." : ""}`,
      }),
    ),
    ...quotes.map(({ body, book }, index) =>
      PalaceEntrySchema.parse({
        ...base,
        id: id(index + 201),
        kind: "quote",
        body,
        bookId: id(book),
        location: "Excerpt; source edition linked in book notes",
        tags: ["excerpt"],
      }),
    ),
    ...art.map(([title, body, tag], index) =>
      PalaceEntrySchema.parse({
        ...base,
        id: id(index + 301),
        kind: "art",
        title,
        body,
        tags: [tag],
        connections: [
          {
            relationship: "inspired_by",
            targetId: id((index % quotes.length) + 201),
            reason: "A sample visual response to this excerpt",
          },
        ],
      }),
    ),
  ];
}
