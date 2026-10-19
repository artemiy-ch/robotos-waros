/** Everything about the hero that upgrades can improve. */
export interface Stats {
  /** Multiplier on the time between cannon shots (lower is faster). */
  fireInterval: number;
  gunDamage: number;
  maxHp: number;
  /** Fuel tank size, relative to the stock one. */
  fuelTank: number;
  salvo: number;
  rocketCooldown: number;
  /** Health per second. */
  regen: number;
  /** Multiplier on the landing shockwave's radius and damage. */
  slam: number;
}

export const baseStats = (): Stats => ({
  fireInterval: 1,
  gunDamage: 1,
  maxHp: 100,
  fuelTank: 1,
  salvo: 4,
  rocketCooldown: 4,
  regen: 0,
  slam: 1,
});

export interface Upgrade {
  id: string;
  name: string;
  text: string;
  max: number;
  apply: (s: Stats) => void;
}

export const UPGRADES: Upgrade[] = [
  { id: "rate", name: "Скорострельность", text: "+20% к темпу пулемётов", max: 5, apply: (s) => (s.fireInterval *= 0.83) },
  { id: "dmg", name: "Бронебойные патроны", text: "+25% к урону пулемётов", max: 5, apply: (s) => (s.gunDamage *= 1.25) },
  { id: "armor", name: "Броня", text: "+25 к здоровью и полный ремонт", max: 5, apply: (s) => (s.maxHp += 25) },
  { id: "fuel", name: "Топливный бак", text: "+35% топлива для полёта", max: 4, apply: (s) => (s.fuelTank *= 1.35) },
  { id: "salvo", name: "Ракетные кассеты", text: "+2 ракеты в залпе", max: 4, apply: (s) => (s.salvo += 2) },
  { id: "reload", name: "Автозарядчик", text: "−25% к перезарядке ракет", max: 4, apply: (s) => (s.rocketCooldown *= 0.75) },
  { id: "regen", name: "Нанорепарация", text: "+1.5 здоровья в секунду", max: 4, apply: (s) => (s.regen += 1.5) },
  { id: "slam", name: "Ударная волна", text: "+40% к радиусу и урону удара о землю", max: 4, apply: (s) => (s.slam *= 1.4) },
];

/** Three different upgrades that haven't hit their limit yet. */
export function offer(levels: Map<string, number>) {
  const open = UPGRADES.filter((u) => (levels.get(u.id) ?? 0) < u.max);
  for (let i = open.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [open[i], open[j]] = [open[j], open[i]];
  }
  return open.slice(0, 3);
}
