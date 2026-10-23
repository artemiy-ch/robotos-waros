import type { MapName } from "../shared/mp";

export const MAP_LIST: MapName[] = ["city", "jungle", "flood", "moon"];

/** Names and a line about each map, for the start screen and the round banner. */
export const MAP_NAMES: Record<MapName, string> = {
  city: "Город",
  jungle: "Джунгли",
  flood: "Затопленный город",
  moon: "Луна",
};
export const MAP_BLURBS: Record<MapName, string> = {
  city: "Смог, неон, разбитые машины",
  jungle: "Руины в зарослях, лианы, пар",
  flood: "Вода по колено: в ней ржавеешь",
  moon: "Станция, низкая гравитация",
};
