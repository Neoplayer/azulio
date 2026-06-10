import * as readline from "node:readline";

const SYMBOLS: string[] = ["A", "B", "C", "D", "E"];
const COPIES_PER_SYMBOL = 20;
const FACTORIES_COUNT = 5;
const TILES_PER_FACTORY = 4;

function makeBag(): string[] {
  const bag: string[] = [];
  for (const symbol of SYMBOLS) {
    for (let i = 0; i < COPIES_PER_SYMBOL; i++) {
      bag.push(symbol);
    }
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function drawTiles(bag: string[], count: number): string[] {
  if (bag.length < count) {
    throw new Error("В мешке не хватает символов. Начните новую игру командой reset.");
  }
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(bag.pop()!);
  }
  return result;
}

function formatTiles(tiles: string[]): string {
  if (!tiles || tiles.length === 0) return "-";
  const counter: Record<string, number> = {};
  for (const t of tiles) {
    counter[t] = (counter[t] || 0) + 1;
  }
  const parts: string[] = [];
  for (const symbol of SYMBOLS) {
    if (counter[symbol]) {
      parts.push(symbol.repeat(counter[symbol]));
    }
  }
  return parts.join(" ") || "-";
}

function printState(bag: string[], factories: string[][], center: string[]): void {
  console.log("\n" + "=".repeat(40));
  console.log("БУМАЖНЫЙ AZUL (TS)");
  console.log("=".repeat(40));
  console.log(`Мешок: ${bag.length} символов\n`);
  console.log("Витрины:");
  for (let i = 0; i < factories.length; i++) {
    console.log(`${i + 1}) ${formatTiles(factories[i])}`);
  }
  console.log(`\nЦентр: ${formatTiles(center)}`);
  console.log("\nКоманды:");
  console.log("  n              - новый раунд");
  console.log("  t 1 A          - взять все A из витрины 1");
  console.log("  c A            - взять все A из центра");
  console.log("  reset          - новая игра");
  console.log("  q              - выход");
  console.log("=".repeat(40));
}

function newRound(bag: string[]): { factories: string[][]; center: string[] } {
  const factories: string[][] = [];
  for (let i = 0; i < FACTORIES_COUNT; i++) {
    factories.push(drawTiles(bag, TILES_PER_FACTORY));
  }
  const center: string[] = [];
  return { factories, center };
}

function takeFromFactory(
  factories: string[][],
  center: string[],
  factoryNumber: number,
  symbol: string
): void {
  const index = factoryNumber - 1;
  if (index < 0 || index >= factories.length) {
    console.log("Нет такой витрины.");
    return;
  }
  const factory = factories[index];
  if (!factory || factory.length === 0) {
    console.log("Эта витрина уже пустая.");
    return;
  }
  if (!factory.includes(symbol)) {
    console.log(`В витрине ${factoryNumber} нет символа ${symbol}.`);
    return;
  }
  const taken: string[] = factory.filter((x) => x === symbol);
  const leftovers: string[] = factory.filter((x) => x !== symbol);
  center.push(...leftovers);
  factories[index] = [];
  console.log(`Взято: ${formatTiles(taken)}`);
  if (leftovers.length > 0) {
    console.log(`В центр ушло: ${formatTiles(leftovers)}`);
  }
}

function takeFromCenter(center: string[], symbol: string): void {
  if (!center || center.length === 0) {
    console.log("Центр пустой.");
    return;
  }
  if (!center.includes(symbol)) {
    console.log(`В центре нет символа ${symbol}.`);
    return;
  }
  const taken: string[] = center.filter((x) => x === symbol);
  const remaining: string[] = center.filter((x) => x !== symbol);
  center.length = 0;
  center.push(...remaining);
  console.log(`Взято из центра: ${formatTiles(taken)}`);
}

async function main(): Promise<void> {
  let bag = makeBag();
  let { factories, center } = newRound(bag);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    printState(bag, factories, center);
    const line: string = await new Promise((resolve) => rl.question("> ", resolve));
    const command = line.trim().toUpperCase().split(/\s+/).filter(Boolean);

    if (command.length === 0) continue;

    if (command[0] === "Q") {
      rl.close();
      break;
    }

    if (command[0] === "RESET") {
      bag = makeBag();
      const round = newRound(bag);
      factories = round.factories;
      center = round.center;
      continue;
    }

    if (command[0] === "N") {
      if (factories.some((f) => f.length > 0) || center.length > 0) {
        console.log("Раунд ещё не разобран. Но новый раунд всё равно начат.");
      }
      try {
        const round = newRound(bag);
        factories = round.factories;
        center = round.center;
      } catch (e) {
        console.log((e as Error).message);
      }
      continue;
    }

    if (command[0] === "T") {
      if (command.length !== 3) {
        console.log("Формат: t 1 A");
        continue;
      }
      const factoryNumber = parseInt(command[1], 10);
      if (Number.isNaN(factoryNumber)) {
        console.log("Номер витрины должен быть числом.");
        continue;
      }
      const symbol = command[2];
      if (!SYMBOLS.includes(symbol)) {
        console.log(`Символ должен быть одним из: ${SYMBOLS.join(", ")}`);
        continue;
      }
      takeFromFactory(factories, center, factoryNumber, symbol);
      continue;
    }

    if (command[0] === "C") {
      if (command.length !== 2) {
        console.log("Формат: c A");
        continue;
      }
      const symbol = command[1];
      if (!SYMBOLS.includes(symbol)) {
        console.log(`Символ должен быть одним из: ${SYMBOLS.join(", ")}`);
        continue;
      }
      takeFromCenter(center, symbol);
      continue;
    }

    console.log("Неизвестная команда.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
