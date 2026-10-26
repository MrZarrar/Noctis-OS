import { createRoot } from "react-dom/client";
import { Markdown } from "../src/conversation/Markdown.js";
import "../src/index.css";

const sheet = [
  "**Lyrics**",
  "",
  "```",
  "[Verse 1]",
  "I dreamed of a city made of glass",
  "```",
  "",
  "**Style prompt**",
  "",
  "```text",
  "dream pop, 92 bpm, airy female vocal",
  "```",
].join("\n");

createRoot(document.getElementById("root")).render(<Markdown text={sheet} />);
