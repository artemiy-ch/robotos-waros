/** Everything about the hero that upgrades can improve. */
export interface Stats {
  /** Multiplier on the time between cannon shots (lower is faster). */
  fireInterval: number;
  gunDamage: number;
  /** Hull: lost for good, only health packs and repairs bring it back. */
  maxHp: number;
  /** Force field: takes hits first and recharges on its own. */
  maxShield: number;
  /** Shield points per second once recharging, and the pause after a hit before it starts. */
  shieldRegen: number;
  shieldDelay: number;
  /** Fuel tank size, relative to the stock one. */
  fuelTank: number;
  salvo: number;
  rocketCooldown: number;
  /** Hull repair per second. */
  regen: number;
  /** Multiplier on the landing shockwave's radius and damage. */
  slam: number;
  diveCooldown: number;
  /** Extra seconds on weapons from crates. */
  specialBonus: number;
}

export const baseStats = (): Stats => ({
  fireInterval: 1,
  gunDamage: 1,
  maxHp: 100,
  maxShield: 60,
  shieldRegen: 18,
  shieldDelay: 3,
  fuelTank: 1,
  salvo: 4,
  rocketCooldown: 4,
  regen: 0,
  slam: 1,
  diveCooldown: 10,
  specialBonus: 0,
});

export interface Upgrade {
  id: string;
  name: string;
  text: string;
  max: number;
  apply: (s: Stats) => void;
  /** Hull repaired when it is taken (0..1 of full). */
  repair?: number;
  /** Boss trophies: only offered after a boss, each taken once. */
  legendary?: boolean;
}

export const UPGRADES: Upgrade[] = [
  { id: "rate", name: "Скорострельность", text: "+20% к темпу пулемётов", max: 5, apply: (s) => (s.fireInterval *= 0.83) },
  { id: "dmg", name: "Бронебойные патроны", text: "+25% к урону пулемётов", max: 5, apply: (s) => (s.gunDamage *= 1.25) },
  { id: "armor", name: "Броня корпуса", text: "+25 к здоровью и полный ремонт", max: 5, apply: (s) => (s.maxHp += 25), repair: 1 },
  { id: "shield", name: "Силовой щит", text: "+25 к ёмкости щита", max: 5, apply: (s) => (s.maxShield += 25) },
  { id: "recharge", name: "Конденсаторы", text: "Щит заряжается на 40% быстрее и раньше", max: 4, apply: (s) => ((s.shieldRegen *= 1.4), (s.shieldDelay *= 0.8)) },
  { id: "fuel", name: "Топливный бак", text: "+35% топлива для полёта", max: 4, apply: (s) => (s.fuelTank *= 1.35) },
  { id: "salvo", name: "Ракетные кассеты", text: "+2 ракеты в залпе", max: 4, apply: (s) => (s.salvo += 2) },
  { id: "reload", name: "Автозарядчик", text: "−25% к перезарядке ракет", max: 4, apply: (s) => (s.rocketCooldown *= 0.75) },
  { id: "regen", name: "Нанорепарация", text: "Корпус чинится на 1 ед. в секунду", max: 3, apply: (s) => (s.regen += 1) },
  { id: "slam", name: "Ударная волна", text: "+40% к радиусу и урону удара о землю", max: 4, apply: (s) => (s.slam *= 1.4) },
];

/** What a boss leaves behind: big, one-off power spikes. */
export const TROPHIES: Upgrade[] = [
  {
    id: "minigun", name: "Шестиствольный ад", text: "Пулемёты: темп ×1.6 и урон ×1.4", max: 1, legendary: true,
    apply: (s) => ((s.fireInterval *= 0.62), (s.gunDamage *= 1.4)),
  },
  {
    id: "aegis", name: "Эгида", text: "Щит ×2, заряжается вдвое быстрее и почти без паузы", max: 1, legendary: true,
    apply: (s) => ((s.maxShield *= 2), (s.shieldRegen *= 2), (s.shieldDelay *= 0.4)),
  },
  {
    id: "storm", name: "Ракетный шторм", text: "+6 ракет в залпе, перезарядка −50%", max: 1, legendary: true,
    apply: (s) => ((s.salvo += 6), (s.rocketCooldown *= 0.5)),
  },
  {
    id: "titanium", name: "Титановый корпус", text: "+100 к здоровью, полный ремонт, починка 2 ед./с", max: 1, legendary: true,
    apply: (s) => ((s.maxHp += 100), (s.regen += 2)), repair: 1,
  },
  {
    id: "meteor", name: "Метеор", text: "Удар о землю ×2.2, перезарядка Q всего 3 с", max: 1, legendary: true,
    apply: (s) => ((s.slam *= 2.2), (s.diveCooldown = 3)),
  },
  {
    id: "arsenal", name: "Арсенал", text: "Оружие из ящиков работает на 25 с дольше", max: 1, legendary: true,
    apply: (s) => (s.specialBonus += 25),
  },
  {
    id: "jetpack", name: "Форсаж", text: "Бесконечное топливо для полёта", max: 1, legendary: true,
    apply: (s) => (s.fuelTank = 1e6),
  },
];

const shuffled = <T>(list: T[]) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Three different upgrades that haven't hit their limit yet; boss trophies after a boss. */
export function offer(levels: Map<string, number>, trophy = false) {
  const pool = trophy ? TROPHIES : UPGRADES;
  const open = pool.filter((u) => (levels.get(u.id) ?? 0) < u.max);
  // Ran out of trophies (unlikely): fall back to ordinary ones.
  if (trophy && open.length === 0) return offer(levels);
  return shuffled(open).slice(0, 3);
}
