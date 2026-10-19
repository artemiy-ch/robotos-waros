import "./style.css";
import { Game } from "./game";

const game = new Game(document.getElementById("game") as HTMLCanvasElement);
// Handy for poking at the game from the dev console.
if (import.meta.env.DEV) Object.assign(window, { game });
