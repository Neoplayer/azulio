import random
from collections import Counter

SYMBOLS = ["A", "B", "C", "D", "E"]
COPIES_PER_SYMBOL = 20

FACTORIES_COUNT = 5
TILES_PER_FACTORY = 4


def make_bag():
    bag = []
    for symbol in SYMBOLS:
        bag.extend([symbol] * COPIES_PER_SYMBOL)
    random.shuffle(bag)
    return bag


def draw_tiles(bag, count):
    if len(bag) < count:
        raise RuntimeError("В мешке не хватает символов. Начните новую игру командой reset.")

    result = []
    for _ in range(count):
        result.append(bag.pop())
    return result


def format_tiles(tiles):
    if not tiles:
        return "-"

    counter = Counter(tiles)
    parts = []

    for symbol in SYMBOLS:
        if counter[symbol]:
            parts.append(symbol * counter[symbol])

    return " ".join(parts)


def print_state(bag, factories, center):
    print("\n" + "=" * 40)
    print("БУМАЖНЫЙ AZUL")
    print("=" * 40)
    print(f"Мешок: {len(bag)} символов\n")

    print("Витрины:")
    for i, factory in enumerate(factories, start=1):
        print(f"{i}) {format_tiles(factory)}")

    print(f"\nЦентр: {format_tiles(center)}")
    print("\nКоманды:")
    print("  n              - новый раунд")
    print("  t 1 A          - взять все A из витрины 1")
    print("  c A            - взять все A из центра")
    print("  reset          - новая игра")
    print("  q              - выход")
    print("=" * 40)


def new_round(bag):
    factories = []
    for _ in range(FACTORIES_COUNT):
        factories.append(draw_tiles(bag, TILES_PER_FACTORY))
    center = []
    return factories, center


def take_from_factory(factories, center, factory_number, symbol):
    index = factory_number - 1

    if index < 0 or index >= len(factories):
        print("Нет такой витрины.")
        return

    factory = factories[index]

    if not factory:
        print("Эта витрина уже пустая.")
        return

    if symbol not in factory:
        print(f"В витрине {factory_number} нет символа {symbol}.")
        return

    taken = [x for x in factory if x == symbol]
    leftovers = [x for x in factory if x != symbol]

    center.extend(leftovers)
    factories[index] = []

    print(f"Взято: {format_tiles(taken)}")
    if leftovers:
        print(f"В центр ушло: {format_tiles(leftovers)}")


def take_from_center(center, symbol):
    if not center:
        print("Центр пустой.")
        return

    if symbol not in center:
        print(f"В центре нет символа {symbol}.")
        return

    taken = [x for x in center if x == symbol]
    center[:] = [x for x in center if x != symbol]

    print(f"Взято из центра: {format_tiles(taken)}")


def main():
    bag = make_bag()
    factories, center = new_round(bag)

    while True:
        print_state(bag, factories, center)
        command = input("> ").strip().upper().split()

        if not command:
            continue

        if command[0] == "Q":
            break

        if command[0] == "RESET":
            bag = make_bag()
            factories, center = new_round(bag)
            continue

        if command[0] == "N":
            if any(factories) or center:
                print("Раунд ещё не разобран. Но новый раунд всё равно начат.")
            try:
                factories, center = new_round(bag)
            except RuntimeError as e:
                print(e)
            continue

        if command[0] == "T":
            if len(command) != 3:
                print("Формат: t 1 A")
                continue

            try:
                factory_number = int(command[1])
            except ValueError:
                print("Номер витрины должен быть числом.")
                continue

            symbol = command[2]

            if symbol not in SYMBOLS:
                print(f"Символ должен быть одним из: {', '.join(SYMBOLS)}")
                continue

            take_from_factory(factories, center, factory_number, symbol)
            continue

        if command[0] == "C":
            if len(command) != 2:
                print("Формат: c A")
                continue

            symbol = command[1]

            if symbol not in SYMBOLS:
                print(f"Символ должен быть одним из: {', '.join(SYMBOLS)}")
                continue

            take_from_center(center, symbol)
            continue

        print("Неизвестная команда.")


if __name__ == "__main__":
    main()
